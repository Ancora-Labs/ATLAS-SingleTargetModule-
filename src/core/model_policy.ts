/**
 * Model Policy — Enforces banned/allowed model rules system-wide.
 *
 * ABSOLUTE RULES:
 *   - Claude Opus 4.6 Fast Mode (30x rate) = FORBIDDEN ALWAYS
 *   - Claude Opus 4.6 Fast / Preview = FORBIDDEN ALWAYS
 *   - Any model with "fast" in name = FORBIDDEN ALWAYS
 *   - Claude Opus 4.5/4.6 (regular) = allowed ONLY for large tasks
 *   - 3x rate models = allowed for long-duration tasks
 *
 * This module is imported by worker_runner.js and agent_loader.js
 * to enforce model selection before any AI call.
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";
import { FAILURE_CLASS } from "./failure_classifier.js";
import { scheduleBoundedHypothesisCandidates, type ScheduledHypothesisCandidate } from "./hypothesis_scheduler.js";
import {
  resolveStableInterventionLineage,
  type InterventionLineageContract,
} from "./state_tracker.js";
import { MIN_TELEMETRY_SAMPLE_THRESHOLD } from "./telemetry_thresholds.js";
import { getLaneForWorkerName } from "./role_registry.js";
import { VERIFICATION_FAILURE_CODE } from "./verification_gate.js";
export { MIN_TELEMETRY_SAMPLE_THRESHOLD };
export type { ScheduledHypothesisCandidate } from "./hypothesis_scheduler.js";

// ── Banned model patterns (case-insensitive) ─────────────────────────────────
// These patterns match against the resolved model slug BEFORE any CLI call.
// If a model matches ANY pattern, it is rejected unconditionally.

const BANNED_PATTERNS = [
  /fast/i,                    // Any model with "fast" in name — 30x rate risk
  /preview/i,                 // Preview/experimental models — unstable behavior
  /30x/i,                     // Explicit 30x rate reference
  /opus.*fast/i,              // Claude Opus fast mode specifically
  /fast.*opus/i,              // Reverse order match
];

// ── Opus-tier models (expensive, only for large tasks) ───────────────────────
// These are allowed ONLY when estimated task scope justifies the cost.

const OPUS_PATTERNS = [
  /opus/i,                    // Any Opus model
];

// ── Large-task threshold ─────────────────────────────────────────────────────
// Tasks must meet at least ONE criterion to use Opus:
// - estimatedLines >= 3000
// - estimatedDurationMinutes >= 120 (2 hours)
// - taskComplexity === "critical" or "massive"

const OPUS_MIN_ESTIMATED_LINES = 3000;
const OPUS_MIN_DURATION_MINUTES = 120;
const OPUS_ALLOWED_COMPLEXITIES = new Set(["critical", "massive", "high"]);

// ── Typed interfaces for decision branches ────────────────────────────────────

/** Hints describing a task's estimated scope, used for model selection decisions. */
export interface TaskHints {
  estimatedLines?: number;
  estimatedDurationMinutes?: number;
  complexity?: string;
  /** Expected quality gain — used by uncertainty-aware routing (Packet 14). */
  expectedQualityGain?: number;
}

/** Available model tiers for complexity-based routing. */
export interface ModelOptions {
  defaultModel?: string;
  strongModel?: string;
  efficientModel?: string;
}

/** Historical ROI data for uncertainty-aware routing. */
export interface RoutingHistory {
  /** Recent ROI value for the current task type (0–∞; 0 means no history). */
  recentROI?: number;
}

export interface RoutingOutcomeMetrics {
  /** Total observed samples used to compute successRate/recentROI. */
  sampleCount: number;
  /** Ratio of done outcomes in [0, 1]. */
  successRate: number;
  /** ROI-like proxy from outcomes in [0, 1]. */
  recentROI: number;
  /** Raw done/total completion rate retained for compatibility and auditability. */
  completionRate?: number;
  /** Ratio of requests that produced a substantive attempt. */
  attemptRate?: number;
  /** Ratio of requests that abstained or exited without attempting. */
  abstainRate?: number;
  /** Successful attempted tasks / attempted tasks. */
  precisionOnAttempted?: number;
  /** Successful hard-task chains / observed hard-task chains. */
  hardChainSuccessRate?: number;
  /** Count of hard-task chains contributing to hardChainSuccessRate. */
  hardChainSampleCount?: number;
  /** Weighted lane-level reliability observed for this task kind. */
  laneReliability?: number;
  /** Composite long-horizon outcome score in [0, 1]. */
  outcomeScore?: number;
}

export const HARD_TASK_UNCERTAINTY_THRESHOLDS = Object.freeze({
  minObservedSamples: 6,
  minSuccessRate: 0.55,
  minRecentROI: 0.30,
  minAttemptRate: 0.70,
  maxAbstainRate: 0.25,
  minPrecisionOnAttempted: 0.65,
  minHardChainSuccessRate: 0.55,
  minLaneReliability: 0.55,
  minBenchmarkScore: 0.70,
  minCapacityGain: 0.10,
});

export interface HardTaskEscalationSignal {
  hardTask: boolean;
  escalate: boolean;
  severity: "none" | "recommended" | "required";
  reason: string;
  uncertaintyScore: number;
}

export interface RetryExpectedRoiSignal {
  allowRetry: boolean;
  expectedGain: number;
  threshold: number;
  reason: string;
  attempt: number;
}

export interface DeliberationPolicy {
  mode: "single-pass" | "multi-attempt";
  attempts: number;
  reflection: boolean;
  boundedSearch: boolean;
  searchBudget: number;
  uncertaintyLevel: "low" | "moderate" | "high";
  executionMode: "direct_execute" | "bounded_deliberation";
  candidateFirstMoves: ScheduledHypothesisCandidate[];
  recommendedFirstMove: ScheduledHypothesisCandidate | null;
  reason: string;
}

export interface LineageRoutingSignals {
  lowRoiSignalCount?: number;
  promptCacheHitRate?: number;
  promptCacheSavedTokens?: number;
  latestFailureClass?: string | null;
  latestFinishCode?: string | null;
  latestFinishStatus?: string | null;
}

interface HardTaskUncertaintyFlags {
  noSamples: boolean;
  lowSamples: boolean;
  weakSuccess: boolean;
  weakROI: boolean;
  weakAttemptRate: boolean;
  highAbstainRate: boolean;
  weakPrecision: boolean;
  weakHardChain: boolean;
  weakLaneReliability: boolean;
  weakBenchmarkScore: boolean;
  weakCapacityGain: boolean;
  highUnresolvedBenchmark: boolean;
}

interface HardTaskUncertaintyProfile {
  hardTask: boolean;
  uncertaintyScore: number;
  thresholds: typeof HARD_TASK_UNCERTAINTY_THRESHOLDS;
  outcomeSampleCount: number;
  outcomeSuccessRate: number;
  outcomeROI: number;
  outcomeAttemptRate: number;
  outcomeAbstainRate: number;
  precisionOnAttempted: number;
  hardChainSuccessRate: number;
  hardChainSampleCount: number;
  laneReliability: number;
  benchmarkScore: number;
  capacityGain: number;
  flags: HardTaskUncertaintyFlags;
}

/** Typed overlays for per-task model call settings. */
export interface ModelCallSettingsOverlay {
  /** Optional explicit model override for this task (still policy-enforced). */
  model?: string;
  /** Optional bounded override for max turns/continues in this task run. */
  maxTurns?: number;
  /** Optional per-task no-ask-user toggle for deterministic execution. */
  noAskUser?: boolean;
  /** Optional per-task silent mode toggle for lower-noise calls. */
  silent?: boolean;
}

function normalizeModelCallSettingsOverlay(input: unknown): ModelCallSettingsOverlay {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: ModelCallSettingsOverlay = {};
  const model = String(src.model ?? "").trim();
  if (model) out.model = model;
  const rawMaxTurns = Number(src.maxTurns);
  if (Number.isFinite(rawMaxTurns)) {
    out.maxTurns = Math.max(1, Math.min(200, Math.round(rawMaxTurns)));
  }
  if (src.noAskUser === true) out.noAskUser = true;
  if (src.silent === true) out.silent = true;
  return out;
}

/**
 * Merge base + per-task model-call settings overlays deterministically.
 * Per-task values always win over base values.
 */
export function resolveModelCallSettingsOverlay(
  baseOverlay: unknown,
  taskOverlay: unknown,
): ModelCallSettingsOverlay {
  const base = normalizeModelCallSettingsOverlay(baseOverlay);
  const task = normalizeModelCallSettingsOverlay(taskOverlay);
  return { ...base, ...task };
}

/**
 * Check if a model is absolutely banned.
 * @param {string} modelName - Model name or slug
 * @returns {{ banned: boolean, reason: string }}
 */
export function isModelBanned(modelName) {
  const name = String(modelName || "").trim();
  if (!name) return { banned: false, reason: "" };

  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(name)) {
      return {
        banned: true,
        reason: `MODEL BANNED: "${name}" matches forbidden pattern ${pattern}. Fast/preview/30x models are absolutely forbidden in BOX.`
      };
    }
  }
  return { banned: false, reason: "" };
}

/**
 * Check if a model is Opus-tier (expensive).
 * @param {string} modelName
 * @returns {boolean}
 */
export function isOpusTier(modelName) {
  const name = String(modelName || "").trim();
  return OPUS_PATTERNS.some(p => p.test(name));
}

/**
 * Check if task scope justifies Opus usage.
 * @param {{ estimatedLines?: number, estimatedDurationMinutes?: number, complexity?: string }} taskHints
 * @returns {{ allowed: boolean, reason: string }}
 */
export function isOpusJustified(taskHints: TaskHints = {}) {
  const lines = Number(taskHints.estimatedLines || 0);
  const duration = Number(taskHints.estimatedDurationMinutes || 0);
  const complexity = String(taskHints.complexity || "").toLowerCase();

  if (lines >= OPUS_MIN_ESTIMATED_LINES) {
    return { allowed: true, reason: `Task scope ${lines} lines >= ${OPUS_MIN_ESTIMATED_LINES} threshold` };
  }
  if (duration >= OPUS_MIN_DURATION_MINUTES) {
    return { allowed: true, reason: `Task duration ${duration}m >= ${OPUS_MIN_DURATION_MINUTES}m threshold` };
  }
  if (OPUS_ALLOWED_COMPLEXITIES.has(complexity)) {
    return { allowed: true, reason: `Task complexity "${complexity}" qualifies for Opus` };
  }

  return {
    allowed: false,
    reason: `Task does not meet Opus thresholds (lines=${lines}<${OPUS_MIN_ESTIMATED_LINES}, duration=${duration}m<${OPUS_MIN_DURATION_MINUTES}m, complexity="${complexity}")`
  };
}

/**
 * Routing reason codes for observability.
 * @enum {string}
 */
export const ROUTING_REASON = Object.freeze({
  ALLOWED:                 "ALLOWED",
  BANNED:                  "BANNED",
  OPUS_DOWNGRADED:         "OPUS_DOWNGRADED",
  EMPTY_MODEL:             "EMPTY_MODEL",
  JANUS_LATENCY_FALLBACK:  "JANUS_LATENCY_FALLBACK",
});

export const OPTIMIZATION_INTERVENTION_KIND = Object.freeze({
  PROMPT_DELTA: "prompt-delta",
  ROUTING_DELTA: "routing-delta",
  POLICY_DELTA: "policy-delta",
});

/**
 * Complexity tier taxonomy (T1/T2/T3).
 * Maps task complexity to model selection and token budget strategy.
 *
 * @enum {string}
 */
export const COMPLEXITY_TIER = Object.freeze({
  /** T1: routine patch — short context, quick execution. */
  T1: "T1",
  /** T2: medium — two-pass reasoning, moderate context. */
  T2: "T2",
  /** T3: architectural — deep think budget, critic mandatory. */
  T3: "T3",
});

/**
 * Classify a task into a complexity tier based on task hints.
 *
 * @param {{ estimatedLines?: number, estimatedDurationMinutes?: number, complexity?: string }} taskHints
 * @returns {{ tier: string, reason: string, maxContinuations: number }}
 */
export function classifyComplexityTier(taskHints: TaskHints = {}) {
  const lines = Number(taskHints.estimatedLines || 0);
  const duration = Number(taskHints.estimatedDurationMinutes || 0);
  const complexity = String(taskHints.complexity || "").toLowerCase();

  // T3: architectural — needs deep reasoning
  if (OPUS_ALLOWED_COMPLEXITIES.has(complexity) || lines >= 3000 || duration >= 120) {
    return { tier: COMPLEXITY_TIER.T3, reason: `complexity=${complexity} lines=${lines} duration=${duration}`, maxContinuations: 5 };
  }

  // T2: medium — two-pass, moderate scope
  if (lines >= 500 || duration >= 30 || complexity === "medium") {
    return { tier: COMPLEXITY_TIER.T2, reason: `complexity=${complexity} lines=${lines} duration=${duration}`, maxContinuations: 3 };
  }

  // T1: routine — quick patch
  return { tier: COMPLEXITY_TIER.T1, reason: `complexity=${complexity} lines=${lines} duration=${duration}`, maxContinuations: 1 };
}

/**
 * Route model selection by task complexity and uncertainty (Packet 7).
 * Returns the recommended model based on complexity tier classification.
 *
 * @param {{ estimatedLines?: number, estimatedDurationMinutes?: number, complexity?: string }} taskHints
 * @param {{ defaultModel?: string, strongModel?: string, efficientModel?: string }} modelOptions
 * @returns {{ model: string, tier: string, reason: string }}
 */
export function routeModelByComplexity(taskHints: TaskHints = {}, modelOptions: ModelOptions = {}) {
  const defaultModel = modelOptions.defaultModel || "Claude Sonnet 4.6";
  const strongModel = modelOptions.strongModel || defaultModel;
  const efficientModel = modelOptions.efficientModel || defaultModel;

  const { tier, reason } = classifyComplexityTier(taskHints);

  if (tier === COMPLEXITY_TIER.T3) {
    return { model: strongModel, tier, reason: `T3 (deep reasoning): ${reason}` };
  }
  if (tier === COMPLEXITY_TIER.T1) {
    return { model: efficientModel, tier, reason: `T1 (routine): ${reason}` };
  }
  return { model: defaultModel, tier, reason: `T2 (medium): ${reason}` };
}

/**
 * Enforce model policy: ban forbidden models, gate Opus to large tasks.
 * Returns the safe model to use — either the requested model (if allowed)
 * or a downgraded fallback.
 *
 * @param {string} requestedModel - Model requested by worker/config
 * @param {{ estimatedLines?: number, estimatedDurationMinutes?: number, complexity?: string, expectedQualityGain?: number }} taskHints
 * @param {string} fallbackModel - Safe fallback model
 * @returns {{ model: string, downgraded: boolean, reason: string, routingReasonCode: string }}
 */
export function enforceModelPolicy(requestedModel, taskHints = {}, fallbackModel = "Claude Sonnet 4.6") {
  const name = String(requestedModel || "").trim();

  // Step 1: Absolute ban check
  const banCheck = isModelBanned(name);
  if (banCheck.banned) {
    return {
      model: fallbackModel,
      downgraded: true,
      reason: banCheck.reason,
      routingReasonCode: ROUTING_REASON.BANNED
    };
  }

  // Step 2: Opus tier gate
  if (isOpusTier(name)) {
    const justification = isOpusJustified(taskHints);
    if (!justification.allowed) {
      return {
        model: fallbackModel,
        downgraded: true,
        reason: `Opus downgraded to ${fallbackModel}: ${justification.reason}`,
        routingReasonCode: ROUTING_REASON.OPUS_DOWNGRADED
      };
    }
  }

  // Step 3: Model is allowed
  return {
    model: name || fallbackModel,
    downgraded: false,
    reason: "",
    routingReasonCode: name ? ROUTING_REASON.ALLOWED : ROUTING_REASON.EMPTY_MODEL
  };
}

/**
 * Token ROI telemetry entry (Packet 14).
 * Records model choice, token spend, and quality outcome per task for
 * uncertainty-aware routing optimization.
 *
 * @typedef {object} TokenROIEntry
 * @property {string} taskId
 * @property {string} model
 * @property {string} tier — T1/T2/T3
 * @property {number} estimatedTokens — estimated prompt tokens
 * @property {string} outcome — done/partial/blocked/error
 * @property {number} qualityScore — 0-1 quality assessment
 * @property {string} recordedAt — ISO timestamp
 */

/**
 * Compute token ROI for a completed task.
 *
 * @param {{ model: string, tier: string, estimatedTokens: number, outcome: string, qualityScore?: number }} entry
 * @returns {{ roi: number, efficiency: string }}
 */
export function computeTokenROI(entry) {
  const tokens = entry.estimatedTokens || 1;
  const quality = entry.qualityScore ?? (entry.outcome === "done" ? 1.0 : entry.outcome === "partial" ? 0.5 : 0);
  const roi = Math.round((quality / (tokens / 1000)) * 100) / 100;

  let efficiency = "normal";
  if (roi > 1.0) efficiency = "high";
  else if (roi < 0.2) efficiency = "low";

  return { roi, efficiency };
}

/**
 * Route model selection with uncertainty awareness (Packet 14).
 * Combines complexity tier classification with historical ROI data.
 *
 * @param {{ estimatedLines?: number, estimatedDurationMinutes?: number, complexity?: string }} taskHints
 * @param {{ defaultModel?: string, strongModel?: string, efficientModel?: string }} modelOptions
 * @param {{ recentROI?: number }} history — historical ROI for this task type
 * @returns {{ model: string, tier: string, reason: string, uncertainty: string }}
 */
export function routeModelWithUncertainty(taskHints: TaskHints = {}, modelOptions: ModelOptions = {}, history: RoutingHistory = {}) {
  const base = routeModelByComplexity(taskHints, modelOptions);
  const recentROI = Number(history.recentROI || 0);

  // If historical ROI for this tier is low, consider downgrading
  let uncertainty = "low";
  if (recentROI > 0 && recentROI < 0.3) {
    uncertainty = "high";
    // For high-uncertainty tasks with low historical ROI, use the default model
    if (base.tier === COMPLEXITY_TIER.T3 && recentROI < 0.2) {
      return {
        model: modelOptions.defaultModel || "Claude Sonnet 4.6",
        tier: base.tier,
        reason: `${base.reason} — downgraded due to low historical ROI (${recentROI})`,
        uncertainty,
      };
    }
  } else if (recentROI >= 0.3 && recentROI < 0.7) {
    uncertainty = "medium";
  }

  return { ...base, uncertainty };
}

/**
 * Resolve the Janus fallback model for latency-aware routing.
 *
 * Priority order:
 *   1. config.runtime.janusFallbackModel (explicit override)
 *   2. config.copilot.efficientModel (lighter/faster model)
 *   3. config.copilot.defaultModel (safe fallback)
 *
 * @param config — full BOX config object
 * @returns model name string (never empty)
 */
export function resolveJanusFallbackModel(config: any): string {
  const explicit = String(config?.runtime?.janusFallbackModel ?? "").trim();
  if (explicit) return explicit;
  const efficient = String(config?.copilot?.efficientModel ?? "").trim();
  if (efficient) return efficient;
  return String(config?.copilot?.defaultModel ?? "Claude Sonnet 4.6");
}


//
// The ledger persists expected and realized quality scores per routing decision
// so that historical ROI deltas can inform next-cycle model selection.
//
// File: state/route_roi_ledger.json  (array of RouteROIEntry, capped at MAX_LEDGER_SIZE)

const ROUTE_ROI_LEDGER_FILE = "route_roi_ledger.json";

/** Maximum number of entries kept in the ledger. */
export const MAX_LEDGER_SIZE = 200;

/**
 * A single routing decision record in the ROI ledger.
 *
 * @property taskId           — unique task identifier
 * @property model            — model that was selected for this task
 * @property tier             — complexity tier (T1/T2/T3)
 * @property estimatedTokens  — estimated prompt token count at routing time
 * @property expectedQuality  — quality score predicted at routing time (0–1)
 * @property realizedQuality  — actual quality score recorded after task completion (null until realized)
 * @property outcome          — task outcome ("done"/"partial"/"blocked"/"error"; null until realized)
 * @property roi              — computed ROI = realizedQuality / (estimatedTokens / 1000); null until realized
 * @property roiDelta         — realizedROI − expectedROI; learning signal for next-cycle routing; null until realized
 * @property routedAt         — ISO timestamp when the routing decision was made
 * @property realizedAt       — ISO timestamp when the outcome was recorded; null until realized
 */
export interface RouteROIEntry {
  taskId: string;
  model: string;
  tier: string;
  estimatedTokens: number;
  expectedQuality: number;
  realizedQuality: number | null;
  outcome: string | null;
  roi: number | null;
  roiDelta: number | null;
  routedAt: string;
  realizedAt: string | null;
  /** Lineage contract ID tying this routing decision to dispatch, usage, and outcomes. */
  lineageId: string | null;
  /** Normalized lineage contract spanning routing, specialization, and outcomes. */
  lineage: InterventionLineageContract | null;
  /** Deterministic join key derived from the lineage contract. */
  lineageJoinKey: string | null;
  /** Stable prompt family key used for cache/request-efficiency joins. */
  promptFamilyKey?: string | null;
  taskKind?: string | null;
  role?: string | null;
  cycleId?: string | null;
  interventionId?: string | null;
  routingReasonCode?: string | null;
}

/**
 * Append a new routing decision to the ROI ledger.
 * The realized fields (realizedQuality, outcome, roi, roiDelta, realizedAt)
 * start as null and are populated later by realizeRouteROIEntry().
 *
 * Never throws — write errors propagate to the caller.
 *
 * @param config  — BOX config object (config.paths.stateDir)
 * @param entry   — routing decision to record (realized fields optional, default null)
 */
export async function appendRouteROIEntry(
  config: object,
  entry: Pick<RouteROIEntry, "taskId" | "model" | "tier" | "estimatedTokens" | "expectedQuality"> & Partial<RouteROIEntry>
): Promise<void> {
  const stateDir = (config as any)?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, ROUTE_ROI_LEDGER_FILE);

  const ledger: RouteROIEntry[] = await readJson(filePath, []);
  const safeList: RouteROIEntry[] = Array.isArray(ledger) ? ledger : [];
  const { lineage, lineageJoinKey } = resolveStableInterventionLineage(
    entry?.lineage,
    {
      lineageId: entry?.lineageId ?? null,
      taskId: entry?.taskId ?? null,
      cycleId: entry?.cycleId ?? null,
      taskKind: entry?.taskKind ?? null,
      promptFamilyKey: entry?.promptFamilyKey ?? null,
      model: entry?.model ?? null,
      role: entry?.role ?? null,
      interventionId: entry?.interventionId ?? null,
      rerouteReasonCode: entry?.routingReasonCode ?? null,
    },
    {
      explicitJoinKey: entry?.lineageJoinKey,
      taskKind: entry?.taskKind ?? null,
      role: entry?.role ?? null,
    },
  );

  const record: RouteROIEntry = {
    taskId:          entry.taskId,
    model:           entry.model,
    tier:            entry.tier,
    estimatedTokens: entry.estimatedTokens,
    expectedQuality: entry.expectedQuality,
    realizedQuality: entry.realizedQuality ?? null,
    outcome:         entry.outcome ?? null,
    roi:             entry.roi ?? null,
    roiDelta:        entry.roiDelta ?? null,
    routedAt:        entry.routedAt || new Date().toISOString(),
    realizedAt:      entry.realizedAt ?? null,
    lineageId:       lineage.lineageId,
    lineage,
    lineageJoinKey,
    promptFamilyKey: entry.promptFamilyKey ?? lineage.promptFamilyKey,
    taskKind:        entry.taskKind ?? lineage.taskKind,
    role:            entry.role ?? lineage.role,
    cycleId:         entry.cycleId ?? lineage.cycleId,
    routingReasonCode: entry.routingReasonCode ?? lineage.rerouteReasonCode,
  };

  safeList.push(record);
  const trimmed = safeList.length > MAX_LEDGER_SIZE ? safeList.slice(-MAX_LEDGER_SIZE) : safeList;
  await writeJson(filePath, trimmed);
}

/**
 * Record the realized outcome for a previously appended routing entry.
 * Locates the most-recent entry for taskId, computes ROI and delta, then
 * persists the updated ledger.
 *
 * No-op (safe) when taskId is not found in the ledger.
 *
 * @param config        — BOX config object
 * @param taskId        — task identifier matching the original appendRouteROIEntry() call
 * @param qualityScore  — actual quality score (0–1) assessed after task completion
 * @param outcome       — task outcome string ("done"/"partial"/"blocked"/"error")
 */
export async function realizeRouteROIEntry(
  config: object,
  taskId: string,
  qualityScore: number,
  outcome: string
): Promise<void> {
  const stateDir = (config as any)?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, ROUTE_ROI_LEDGER_FILE);

  const ledger: RouteROIEntry[] = await readJson(filePath, []);
  const safeList: RouteROIEntry[] = Array.isArray(ledger) ? ledger : [];

  // Find the last unrealized entry for this taskId
  let found = false;
  for (let i = safeList.length - 1; i >= 0; i--) {
    if (safeList[i].taskId === taskId && safeList[i].realizedAt === null) {
      const entry = safeList[i];
      const tokens = entry.estimatedTokens || 1;
      const roi = Math.round((qualityScore / (tokens / 1000)) * 100) / 100;
      const expectedROI = Math.round((entry.expectedQuality / (tokens / 1000)) * 100) / 100;
      safeList[i] = {
        ...entry,
        realizedQuality: qualityScore,
        outcome,
        roi,
        roiDelta: Math.round((roi - expectedROI) * 1000) / 1000,
        realizedAt: new Date().toISOString(),
      };
      found = true;
      break;
    }
  }

  if (found) {
    await writeJson(filePath, safeList);
  }
}

/**
 * Load the full ROI ledger from state.
 * Returns an empty array when the file does not exist.
 *
 * @param config — BOX config object
 */
export async function loadRouteROILedger(config: object): Promise<RouteROIEntry[]> {
  const stateDir = (config as any)?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, ROUTE_ROI_LEDGER_FILE);
  const data = await readJson(filePath, []);
  return Array.isArray(data) ? data : [];
}

// ── Cost-aware routing — quality-floor model selection ────────────────────────
//
// Selects the cheapest model whose expected quality meets or exceeds a caller-
// supplied floor.  Falls back to the strongest available model when no candidate
// qualifies, marking the result so the caller can log a warning.

/** Default quality floor used by all quality-floor-aware routing functions (0–1). */
export const QUALITY_FLOOR_DEFAULT = 0.7 as const;

/** Heuristic default quality scores per model (case-insensitive normalized key). */
const DEFAULT_MODEL_QUALITY: Record<string, number> = {
  "claude sonnet 4.6": 0.85,
  "claude haiku 4":    0.70,
  "claude haiku 4.5":  0.72,
  "claude opus 4.6":   0.95,
};

/**
 * Route to the cheapest model that still meets a minimum quality floor.
 *
 * Candidates are evaluated cheapest → strongest.  The first candidate whose
 * expected quality meets or exceeds `qualityFloor` is returned.  When no
 * candidate satisfies the constraint the strongest model is returned and
 * `meetsQualityFloor` is `false`.
 *
 * @param taskHints    — task scope for complexity-tier derivation
 * @param modelOptions — model pool; supply efficientModel / defaultModel / strongModel
 *                       and optionally qualityByModel to override heuristic scores
 * @param qualityFloor — minimum acceptable quality score (0–1; default 0.7)
 * @returns {{ model, tier, reason, meetsQualityFloor }}
 */
export function routeModelByCost(
  taskHints: TaskHints = {},
  modelOptions: ModelOptions & { qualityByModel?: Record<string, number> } = {},
  qualityFloor = 0.7
): { model: string; tier: string; reason: string; meetsQualityFloor: boolean } {
  const { tier } = classifyComplexityTier(taskHints);
  const qualityByModel = modelOptions.qualityByModel || {};

  const resolveQuality = (name: string): number => {
    const key = String(name || "").toLowerCase();
    return qualityByModel[name] ?? qualityByModel[key] ?? DEFAULT_MODEL_QUALITY[key] ?? 0.75;
  };

  const efficientModel = modelOptions.efficientModel || "";
  const defaultModel   = modelOptions.defaultModel   || "Claude Sonnet 4.6";
  const strongModel    = modelOptions.strongModel    || defaultModel;

  // Build candidate list cheapest → strongest (deduplication preserving order)
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const m of [efficientModel, defaultModel, strongModel]) {
    if (m && !seen.has(m)) { candidates.push(m); seen.add(m); }
  }

  for (const candidate of candidates) {
    const quality = resolveQuality(candidate);
    if (quality >= qualityFloor) {
      return {
        model: candidate,
        tier,
        reason: `cost-aware: "${candidate}" meets quality floor ${qualityFloor} (score=${quality}) for tier ${tier}`,
        meetsQualityFloor: true,
      };
    }
  }

  // No candidate meets the floor — use strongest as safe fallback
  const fallback = candidates[candidates.length - 1] || defaultModel;
  const fallbackQuality = resolveQuality(fallback);
  return {
    model: fallback,
    tier,
    reason: `cost-aware: no model meets quality floor ${qualityFloor}; using strongest "${fallback}" (score=${fallbackQuality}) for tier ${tier}`,
    meetsQualityFloor: fallbackQuality >= qualityFloor,
  };
}

// ── Completion-yield ROI-adjusted routing ─────────────────────────────────────
//
// Adjusts the quality floor based on historical tier ROI so that
// model selection optimises for completion yield:
//   - High-ROI tiers → relax floor slightly → cheaper model passes (cost saving)
//   - Low-ROI tiers  → tighten floor        → better model required (quality uplift)
//   - No history     → use floor as-is      → deterministic baseline behaviour

const ROI_HIGH_THRESHOLD   = 0.8;   // Above this: tier is productive; allow relaxation
const ROI_LOW_THRESHOLD    = 0.3;   // Below this (and > 0): tier is under-performing; tighten
const FLOOR_RELAX_AMOUNT   = 0.05;  // Floor reduction when ROI is high
const FLOOR_TIGHTEN_AMOUNT = 0.10;  // Floor increase when ROI is low
const MIN_QUALITY_FLOOR    = 0.50;  // Absolute minimum — always route to something
const MAX_QUALITY_FLOOR    = 0.99;  // Absolute maximum — preserve a model selection path

/**
 * Route to the cheapest model that satisfies a quality floor adjusted by
 * the tier's historical completion-yield ROI.
 *
 * The effective floor is derived from `qualityFloor` and `tierROI`:
 *   - tierROI > ROI_HIGH_THRESHOLD → floor − FLOOR_RELAX_AMOUNT (productive tier; cheaper ok)
 *   - 0 < tierROI < ROI_LOW_THRESHOLD → floor + FLOOR_TIGHTEN_AMOUNT (under-performing; tighten)
 *   - otherwise (no history or medium) → floor unchanged
 * The floor is always clamped to [MIN_QUALITY_FLOOR, MAX_QUALITY_FLOOR].
 *
 * Quality contract is preserved: when no model meets the effective floor the
 * strongest available model is returned with `meetsQualityFloor: false`.
 *
 * @param taskHints    — task scope for complexity-tier derivation
 * @param modelOptions — model pool; efficientModel / defaultModel / strongModel
 *                       and optional qualityByModel score overrides
 * @param qualityFloor — caller-supplied minimum quality score (default 0.7)
 * @param tierROI      — recent average ROI for this tier (0 = no data; see computeRecentROIForTier)
 */
export function routeModelWithCompletionROI(
  taskHints: TaskHints = {},
  modelOptions: ModelOptions & { qualityByModel?: Record<string, number> } = {},
  qualityFloor = 0.7,
  tierROI = 0,
): { model: string; tier: string; reason: string; meetsQualityFloor: boolean; effectiveFloor: number; roiAdjustment: string } {
  let effectiveFloor = qualityFloor;
  let roiAdjustment = "none";

  if (tierROI > ROI_HIGH_THRESHOLD) {
    effectiveFloor = qualityFloor - FLOOR_RELAX_AMOUNT;
    roiAdjustment = `relaxed (tierROI=${tierROI} > ${ROI_HIGH_THRESHOLD})`;
  } else if (tierROI > 0 && tierROI < ROI_LOW_THRESHOLD) {
    effectiveFloor = qualityFloor + FLOOR_TIGHTEN_AMOUNT;
    roiAdjustment = `tightened (tierROI=${tierROI} < ${ROI_LOW_THRESHOLD})`;
  }

  effectiveFloor = Math.max(MIN_QUALITY_FLOOR, Math.min(MAX_QUALITY_FLOOR, effectiveFloor));
  effectiveFloor = Math.round(effectiveFloor * 1000) / 1000;

  const base = routeModelByCost(taskHints, modelOptions, effectiveFloor);
  return {
    ...base,
    effectiveFloor,
    roiAdjustment,
    reason: `roi-adjusted(${roiAdjustment}): ${base.reason}`,
  };
}

// ── Closure-yield routing — quality floor tightening ─────────────────────────
//
// Low closure yield (few carry-forward items shipped with verified evidence) signals
// the system is struggling to deliver improvements.  Under these conditions, prefer
// stronger models to increase the probability of successful task completion.

/** Closure yield below this value triggers quality floor tightening. */
export const CLOSURE_YIELD_LOW_THRESHOLD = 0.5;

/** Quality floor increase applied when closure yield is below the threshold. */
const CLOSURE_YIELD_TIGHTEN_AMOUNT = 0.10;

/**
 * Route to a model with quality floor adjusted by realized closure yield.
 *
 * Low closure yield (> 0 and < CLOSURE_YIELD_LOW_THRESHOLD) tightens the floor,
 * biasing selection toward stronger models when the system has a track record of
 * failing to ship verifiably.  Zero yield (no data) leaves the floor unchanged so
 * the function is safe to call before any closure history exists.
 *
 * The effective floor is always clamped to [MIN_QUALITY_FLOOR, MAX_QUALITY_FLOOR].
 *
 * @param taskHints    — task scope for complexity-tier derivation
 * @param modelOptions — model pool; efficientModel / defaultModel / strongModel
 *                       and optional qualityByModel score overrides
 * @param qualityFloor — caller-supplied minimum quality score (default 0.7)
 * @param closureYield — realized closure yield (0–1; 0 = no data / no history)
 */
export function routeModelWithClosureYield(
  taskHints: TaskHints = {},
  modelOptions: ModelOptions & { qualityByModel?: Record<string, number> } = {},
  qualityFloor = 0.7,
  closureYield = 0,
): { model: string; tier: string; reason: string; meetsQualityFloor: boolean; effectiveFloor: number; closureYieldAdjustment: string } {
  let effectiveFloor = qualityFloor;
  let closureYieldAdjustment = "none";

  if (closureYield > 0 && closureYield < CLOSURE_YIELD_LOW_THRESHOLD) {
    effectiveFloor = qualityFloor + CLOSURE_YIELD_TIGHTEN_AMOUNT;
    closureYieldAdjustment = `tightened (closureYield=${closureYield} < ${CLOSURE_YIELD_LOW_THRESHOLD})`;
  }

  effectiveFloor = Math.max(MIN_QUALITY_FLOOR, Math.min(MAX_QUALITY_FLOOR, effectiveFloor));
  effectiveFloor = Math.round(effectiveFloor * 1000) / 1000;

  const base = routeModelByCost(taskHints, modelOptions, effectiveFloor);
  return {
    ...base,
    effectiveFloor,
    closureYieldAdjustment,
    reason: `closure-yield-adjusted(${closureYieldAdjustment}): ${base.reason}`,
  };
}

// ── Memory-hit-ratio routing — quality floor adjustment ───────────────────────
//
// Adjusts the quality floor based on the knowledge-memory hit ratio so that
// model selection reflects how effectively memory is contributing to task success:
//   - High hit ratio (≥ MEMORY_HIT_RATIO_HIGH) → relax floor (memory is helping;
//     cheaper model likely sufficient since context is well-populated)
//   - Low hit ratio (0 < ratio < MEMORY_HIT_RATIO_LOW) → tighten floor (memory is
//     sparse; stronger model needed to compensate for missing context)
//   - Zero / no history → floor unchanged (safe baseline; no signal yet)

/** Memory hit ratio above this threshold is considered productive (floor relaxation allowed). */
export const MEMORY_HIT_RATIO_HIGH = 0.70;

/** Memory hit ratio below this threshold (and > 0) triggers floor tightening. */
export const MEMORY_HIT_RATIO_LOW  = 0.30;

/** Floor reduction applied when memory hit ratio is high. */
export const MEMORY_FLOOR_RELAX_AMOUNT = 0.05;

/** Floor increase applied when memory hit ratio is low (but > 0). */
export const MEMORY_FLOOR_TIGHTEN_AMOUNT = 0.08;

/**
 * Route to the cheapest model that satisfies a quality floor adjusted by the
 * knowledge-memory hit ratio.
 *
 * The effective floor is derived from `qualityFloor` and `memoryHitRatio`:
 *   - ratio ≥ MEMORY_HIT_RATIO_HIGH → floor − MEMORY_FLOOR_RELAX_AMOUNT  (high hit; cheaper ok)
 *   - 0 < ratio < MEMORY_HIT_RATIO_LOW → floor + MEMORY_FLOOR_TIGHTEN_AMOUNT (low hit; tighten)
 *   - otherwise (zero / medium) → floor unchanged
 * The effective floor is always clamped to [MIN_QUALITY_FLOOR, MAX_QUALITY_FLOOR].
 *
 * @param taskHints      — task scope for complexity-tier derivation
 * @param modelOptions   — model pool; efficientModel / defaultModel / strongModel
 *                         and optional qualityByModel score overrides
 * @param qualityFloor   — caller-supplied minimum quality score (default 0.7)
 * @param memoryHitRatio — recent memory hit ratio (0 = no data / no hits)
 */
export function routeModelWithMemoryHitRatio(
  taskHints: TaskHints = {},
  modelOptions: ModelOptions & { qualityByModel?: Record<string, number> } = {},
  qualityFloor = 0.7,
  memoryHitRatio = 0,
): { model: string; tier: string; reason: string; meetsQualityFloor: boolean; effectiveFloor: number; memoryHitAdjustment: string; memoryHitRatio: number } {
  let effectiveFloor = qualityFloor;
  let memoryHitAdjustment = "none";

  if (memoryHitRatio >= MEMORY_HIT_RATIO_HIGH) {
    effectiveFloor = qualityFloor - MEMORY_FLOOR_RELAX_AMOUNT;
    memoryHitAdjustment = `relaxed (memoryHitRatio=${memoryHitRatio} >= ${MEMORY_HIT_RATIO_HIGH})`;
  } else if (memoryHitRatio > 0 && memoryHitRatio < MEMORY_HIT_RATIO_LOW) {
    effectiveFloor = qualityFloor + MEMORY_FLOOR_TIGHTEN_AMOUNT;
    memoryHitAdjustment = `tightened (memoryHitRatio=${memoryHitRatio} < ${MEMORY_HIT_RATIO_LOW})`;
  }

  effectiveFloor = Math.max(MIN_QUALITY_FLOOR, Math.min(MAX_QUALITY_FLOOR, effectiveFloor));
  effectiveFloor = Math.round(effectiveFloor * 1000) / 1000;

  const base = routeModelByCost(taskHints, modelOptions, effectiveFloor);
  return {
    ...base,
    effectiveFloor,
    memoryHitAdjustment,
    memoryHitRatio,
    reason: `memory-hit-adjusted(${memoryHitAdjustment}): ${base.reason}`,
  };
}

/**
 * Route model selection by combining uncertainty-awareness with quality-floor enforcement.
 *
 * Priority:
 *   1. Apply uncertainty-aware routing as the primary mechanism.
 *   2. Check whether the selected candidate meets the quality floor.
 *   3. If not, fall back to cost-aware quality-floor routing so no model below the
 *      minimum bar is dispatched. Uncertainty routing operates *under* the floor.
 *
 * @param taskHints    - task scope for complexity classification
 * @param modelOptions - model pool; defaultModel / strongModel / efficientModel and optional qualityByModel overrides
 * @param history      - routing history for uncertainty computation (recentROI)
 * @param qualityFloor - minimum acceptable quality score (0-1; default 0.7)
 */
export function routeModelUnderQualityFloor(
  taskHints: TaskHints = {},
  modelOptions: ModelOptions & { qualityByModel?: Record<string, number> } = {},
  history: RoutingHistory = {},
  qualityFloor = 0.7,
): { model: string; tier: string; reason: string; uncertainty: string; meetsQualityFloor: boolean } {
  const uncertaintyResult = routeModelWithUncertainty(taskHints, modelOptions, history);

  const qualityByModel = modelOptions.qualityByModel || {};
  const resolveQuality = (name: string): number => {
    const key = String(name || "").toLowerCase();
    return qualityByModel[name] ?? qualityByModel[key] ?? DEFAULT_MODEL_QUALITY[key] ?? 0.75;
  };
  const candidateQuality = resolveQuality(uncertaintyResult.model);

  if (candidateQuality >= qualityFloor) {
    return { ...uncertaintyResult, meetsQualityFloor: true };
  }

  // Uncertainty-selected model is below quality floor - upgrade via cost-aware routing.
  const floorResult = routeModelByCost(taskHints, modelOptions, qualityFloor);
  return {
    model: floorResult.model,
    tier: floorResult.tier,
    reason: `quality-floor-upgrade(uncertainty-selected=${uncertaintyResult.model} score=${candidateQuality.toFixed(2)} < floor=${qualityFloor}): ${floorResult.reason}`,
    uncertainty: uncertaintyResult.uncertainty,
    meetsQualityFloor: floorResult.meetsQualityFloor,
  };
}

/**
 * Compute the average realized ROI for a complexity tier from the ledger.
 *
 * Only realized entries (realizedAt !== null) for the requested tier are
 * included. Returns 0 when no realized history is available so callers
 * can distinguish "no data" from "genuinely zero ROI" (which would require
 * quality=0 on every task, an unusual but possible state).
 *
 * @param config  — BOX config object
 * @param tier    — COMPLEXITY_TIER value ("T1"/"T2"/"T3")
 * @param limit   — max entries to consider (most-recent first; default 20)
 * @returns average realized ROI (0 when no realized history for tier)
 */
export async function computeRecentROIForTier(
  config: object,
  tier: string,
  limit = 20
): Promise<number> {
  const ledger = await loadRouteROILedger(config);
  const realized = ledger
    .filter(e => e.tier === tier && e.realizedAt !== null && typeof e.roi === "number")
    .slice(-limit);

  if (realized.length === 0) return 0;
  const sum = realized.reduce((acc, e) => acc + (e.roi as number), 0);
  return Math.round((sum / realized.length) * 1000) / 1000;
}

/**
 * Summarize realized ROI deltas for a complexity tier from the ledger.
 *
 * The roiDelta is the learning signal (realized − expected ROI). A positive average
 * means the tier consistently outperforms predictions; negative means underperformance.
 * Only fully-realized entries (realizedAt !== null, roiDelta is a finite number) for
 * the requested tier are included.
 *
 * Returns { avgRoiDelta: 0, sampleCount: 0 } when no realized history is available so
 * callers can distinguish "no data" from "genuinely neutral history" (avgRoiDelta=0 with
 * sampleCount > 0 means history exists but deltas cancel out).
 *
 * @param config  — BOX config object
 * @param tier    — COMPLEXITY_TIER value ("T1"/"T2"/"T3")
 * @param limit   — max most-recent entries to include (default: 20)
 * @returns { avgRoiDelta, sampleCount }
 */
export async function summarizeTierTelemetry(
  config: object,
  tier: string,
  limit = 20
): Promise<{ avgRoiDelta: number; sampleCount: number }> {
  try {
    const ledger = await loadRouteROILedger(config);
    const realized = ledger
      .filter(
        e =>
          e.tier === tier &&
          e.realizedAt !== null &&
          typeof e.roiDelta === "number" &&
          Number.isFinite(e.roiDelta)
      )
      .slice(-limit);
    if (realized.length === 0) return { avgRoiDelta: 0, sampleCount: 0 };
    const sum = realized.reduce((acc, e) => acc + (e.roiDelta as number), 0);
    return {
      avgRoiDelta: Math.round((sum / realized.length) * 1000) / 1000,
      sampleCount: realized.length,
    };
  } catch {
    return { avgRoiDelta: 0, sampleCount: 0 };
  }
}

// ── Realized-ROI-dominant routing with bounded exploration ────────────────────
//
// Uses the actual realized ROI from the ledger as the primary adaptive signal
// rather than a caller-supplied estimate.  Bounded exploration prevents the
// system from indefinitely trying expensive models on tiers with consistently
// poor outcomes.

/**
 * Maximum fraction of dispatch cycles that may explore stronger models when
 * realized ROI is very low.  Below this threshold the system switches to
 * conservative floor-tightening rather than continued exploration.
 */
export const EXPLORATION_BOUND = 0.15 as const;

/** Realized ROI below this value triggers exploration limiting. */
const EXPLORATION_LIMIT_THRESHOLD = EXPLORATION_BOUND;

/** Additional quality floor increase applied when exploration is limited. */
const EXPLORATION_LIMIT_TIGHTEN = 0.15;

const PROMPT_CACHE_HIT_RATE_RELAX_THRESHOLD = 0.6;
const PROMPT_CACHE_SAVED_TOKENS_RELAX_THRESHOLD = 1200;
const PROMPT_CACHE_FLOOR_RELAX_AMOUNT = 0.05;

/**
 * Route model selection using the realized ROI from the ROI ledger as the
 * dominant adaptive signal.
 *
 * Steps:
 *   1. Read `computeRecentROIForTier` for the task's complexity tier.
 *   2. Apply bounded exploration: when realizedROI > 0 but < EXPLORATION_BOUND,
 *      tighten the quality floor to prevent continued wasteful exploration.
 *   3. Delegate to `routeModelWithCompletionROI` with the effective floor and
 *      realized ROI.
 *
 * Zero realizedROI (no ledger data) leaves the floor unchanged — the function
 * is safe to call before any history exists.
 *
 * @param config       — BOX config object (config.paths.stateDir for ledger)
 * @param taskHints    — task scope for complexity-tier derivation
 * @param modelOptions — model pool; efficientModel / defaultModel / strongModel
 * @param opts         — qualityFloor (default 0.7), explorationBound override
 */
export async function routeModelWithRealizedROI(
  config: object,
  taskHints: TaskHints = {},
  modelOptions: ModelOptions & { qualityByModel?: Record<string, number> } = {},
  opts: {
    qualityFloor?: number;
    explorationBound?: number;
    promptCacheHitRate?: number;
    promptCacheSavedTokens?: number;
    lineageSignals?: LineageRoutingSignals;
  } = {},
): Promise<{
  model: string;
  tier: string;
  reason: string;
  realizedROI: number;
  uncertainty: string;
  meetsQualityFloor: boolean;
  explorationLimited: boolean;
  promptCacheAdjustment: string;
  selectionPattern: string;
}> {
  const qualityFloor    = opts.qualityFloor    ?? 0.7;
  const explorationBound = opts.explorationBound ?? EXPLORATION_LIMIT_THRESHOLD;
  const promptCacheHitRate = Number.isFinite(Number(opts.promptCacheHitRate))
    ? Math.max(0, Math.min(1, Number(opts.promptCacheHitRate)))
    : 0;
  const promptCacheSavedTokens = Number.isFinite(Number(opts.promptCacheSavedTokens))
    ? Math.max(0, Math.round(Number(opts.promptCacheSavedTokens)))
    : 0;
  const lineageSignals = opts.lineageSignals || {};
  const lowRoiSignalCount = Math.max(0, Math.floor(Number(lineageSignals.lowRoiSignalCount || 0)));
  const latestFailureClass = String(lineageSignals.latestFailureClass || "").trim().toLowerCase();
  const latestFinishCode = String(lineageSignals.latestFinishCode || "").trim().toLowerCase();
  const promptCacheCheap = (
    promptCacheHitRate >= PROMPT_CACHE_HIT_RATE_RELAX_THRESHOLD
    || promptCacheSavedTokens >= PROMPT_CACHE_SAVED_TOKENS_RELAX_THRESHOLD
  );
  const selectionPattern =
    latestFailureClass === FAILURE_CLASS.LOGIC_DEFECT
      ? "reasoning-recovery"
      : latestFailureClass === FAILURE_CLASS.POLICY
        || latestFailureClass === FAILURE_CLASS.VERIFICATION
        || /policy|guard|capability_check|verification/.test(latestFinishCode)
        ? "constraint-first"
        : latestFailureClass === FAILURE_CLASS.MODEL
          || latestFailureClass === FAILURE_CLASS.EXTERNAL_API
          || /rate|quota|429|503|timeout|provider/.test(latestFinishCode)
          ? "cooldown-stability"
          : "balanced";

  const { tier } = classifyComplexityTier(taskHints);

  let realizedROI = 0;
  try {
    realizedROI = await computeRecentROIForTier(config, tier);
  } catch {
    // keep realizedROI = 0 (no data → no adjustment)
  }

  // Bounded exploration: very low ROI means exploration has been wasteful — tighten
  let explorationLimited = false;
  let effectiveFloor     = qualityFloor;

  if (realizedROI > 0 && realizedROI < explorationBound) {
    effectiveFloor     = Math.min(MAX_QUALITY_FLOOR, qualityFloor + EXPLORATION_LIMIT_TIGHTEN);
    explorationLimited = true;
  }

  let promptCacheAdjustment = "none";
  if (
    promptCacheHitRate >= PROMPT_CACHE_HIT_RATE_RELAX_THRESHOLD
    || promptCacheSavedTokens >= PROMPT_CACHE_SAVED_TOKENS_RELAX_THRESHOLD
  ) {
    effectiveFloor = Math.max(MIN_QUALITY_FLOOR, effectiveFloor - PROMPT_CACHE_FLOOR_RELAX_AMOUNT);
    promptCacheAdjustment = `relaxed (hitRate=${promptCacheHitRate.toFixed(2)} savedTokens=${Math.round(promptCacheSavedTokens)})`;
  }
  if (lowRoiSignalCount > 0 && selectionPattern !== "constraint-first") {
    effectiveFloor = Math.min(MAX_QUALITY_FLOOR, effectiveFloor + Math.min(0.09, lowRoiSignalCount * 0.03));
  }
  if (selectionPattern === "reasoning-recovery" && promptCacheCheap && lowRoiSignalCount === 0) {
    effectiveFloor = Math.min(MAX_QUALITY_FLOOR, effectiveFloor + 0.03);
  }

  const base = routeModelWithCompletionROI(taskHints, modelOptions, effectiveFloor, realizedROI);
  const defaultModel = modelOptions.defaultModel || "Claude Sonnet 4.6";
  const strongModel = modelOptions.strongModel || defaultModel;
  const efficientModel = modelOptions.efficientModel || defaultModel;
  let selectedModel = base.model;
  if (selectionPattern === "constraint-first") {
    if (selectedModel === strongModel && defaultModel) {
      selectedModel = defaultModel;
    }
    if (selectedModel === efficientModel && tier !== COMPLEXITY_TIER.T1 && defaultModel) {
      selectedModel = defaultModel;
    }
  } else if (selectionPattern === "cooldown-stability" && selectedModel === strongModel && defaultModel) {
    selectedModel = defaultModel;
  } else if (
    selectionPattern === "reasoning-recovery"
    && promptCacheCheap
    && lowRoiSignalCount === 0
    && tier !== COMPLEXITY_TIER.T1
    && selectedModel === defaultModel
    && strongModel
  ) {
    selectedModel = strongModel;
  }

  let uncertainty: string;
  if (realizedROI === 0)       uncertainty = "low";     // no data → no signal
  else if (realizedROI < 0.3)  uncertainty = "high";
  else if (realizedROI < 0.7)  uncertainty = "medium";
  else                          uncertainty = "low";

  const explorationTag = explorationLimited ? " [exploration-limited]" : "";
  return {
    model:              selectedModel,
    tier,
    reason:             `realized-roi(roi=${realizedROI}, tier=${tier})${explorationTag} prompt-cache(${promptCacheAdjustment}) pattern=${selectionPattern} low-roi-lineage=${lowRoiSignalCount}: ${base.reason}`,
    realizedROI,
    uncertainty,
    meetsQualityFloor:  base.meetsQualityFloor,
    explorationLimited,
    promptCacheAdjustment,
    selectionPattern,
  };
}

// ── Benchmark contract telemetry ingestion ──────────────────────────────────────

export interface BenchmarkContract {
  name: string;
  version: string;
  requiredFields: string[];
  statusEnum: string[];
}

export interface BenchmarkSample {
  benchmarkName: string;
  taskId: string;
  status: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  elapsedMs: number;
  evaluatedAt: string;
}

export async function loadBenchmarkContracts(config: object): Promise<BenchmarkContract[]> {
  const stateDir = (config as any)?.paths?.stateDir || "state";
  const raw = await readJson(path.join(stateDir, "benchmark_contracts.json"), { contracts: [] });
  const contracts = Array.isArray((raw as any)?.contracts) ? (raw as any).contracts : [];
  return contracts
    .filter((c: any) => c && typeof c === "object")
    .map((c: any) => ({
      name: String(c.name || "").trim(),
      version: String(c.version || "").trim(),
      requiredFields: Array.isArray(c.requiredFields) ? c.requiredFields.map((f: any) => String(f || "").trim()).filter(Boolean) : [],
      statusEnum: Array.isArray(c.statusEnum) ? c.statusEnum.map((v: any) => String(v || "").trim().toLowerCase()).filter(Boolean) : [],
    }))
    .filter((c: BenchmarkContract) => c.name.length > 0);
}

export function validateBenchmarkSample(sample: BenchmarkSample, contracts: BenchmarkContract[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const benchmarkName = String(sample?.benchmarkName || "").trim();
  const contract = Array.isArray(contracts)
    ? contracts.find((c) => c.name.toLowerCase() === benchmarkName.toLowerCase())
    : undefined;
  if (!contract) {
    errors.push(`unknown_benchmark:${benchmarkName || "missing"}`);
    return { valid: false, errors };
  }
  for (const field of contract.requiredFields) {
    const value = (sample as any)?.[field];
    const missing = value === null || value === undefined || (typeof value === "string" && String(value).trim().length === 0);
    if (missing) errors.push(`missing_field:${field}`);
  }
  const status = String(sample?.status || "").trim().toLowerCase();
  if (!contract.statusEnum.includes(status)) errors.push(`invalid_status:${status || "missing"}`);
  return { valid: errors.length === 0, errors };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function roundMetric(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

const ROUTING_SUCCESS_OUTCOMES = new Set(["done", "success"]);
const ROUTING_ATTEMPTED_OUTCOMES = new Set([
  "done",
  "success",
  "partial",
  "error",
  "failed",
  "transient_error",
  "verification_failed",
  "rollback",
]);
const ROUTING_ABSTAIN_OUTCOMES = new Set([
  "blocked",
  "skipped",
  "timeout",
  "abstain",
  "abstained",
  "unknown",
  "inconclusive",
  "no_signal",
  "noop",
  "no-op",
]);

function normalizeRoutingOutcome(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function isRoutingSuccess(value: unknown): boolean {
  return ROUTING_SUCCESS_OUTCOMES.has(normalizeRoutingOutcome(value));
}

function isRoutingAttempt(value: unknown): boolean {
  const normalized = normalizeRoutingOutcome(value);
  return ROUTING_SUCCESS_OUTCOMES.has(normalized) || ROUTING_ATTEMPTED_OUTCOMES.has(normalized);
}

function isRoutingAbstain(value: unknown): boolean {
  return ROUTING_ABSTAIN_OUTCOMES.has(normalizeRoutingOutcome(value));
}

function averageMetrics(values: Array<number | null | undefined>): number {
  const finite = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (finite.length === 0) return 0;
  return roundMetric(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function computeRoutingReliabilityScore(input: {
  completionRate?: number | null;
  attemptRate?: number | null;
  abstainRate?: number | null;
  precisionOnAttempted?: number | null;
}): number {
  return averageMetrics([
    input.completionRate ?? null,
    input.attemptRate ?? null,
    input.abstainRate != null ? 1 - input.abstainRate : null,
    input.precisionOnAttempted ?? null,
  ]);
}

function computeRoutingOutcomeScore(input: {
  attemptRate?: number | null;
  abstainRate?: number | null;
  precisionOnAttempted?: number | null;
  laneReliability?: number | null;
  hardChainSuccessRate?: number | null;
  includeHardChain?: boolean;
}): number {
  return averageMetrics([
    input.attemptRate ?? null,
    input.abstainRate != null ? 1 - input.abstainRate : null,
    input.precisionOnAttempted ?? null,
    input.laneReliability ?? null,
    input.includeHardChain ? (input.hardChainSuccessRate ?? null) : null,
  ]);
}

function deriveLatestBenchmarkSignal(benchmarkGroundTruth: any): {
  sampleCount: number;
  avgBenchmarkScore: number;
  avgCapacityGain: number;
  unresolvedRatio: number;
} {
  const entries = Array.isArray(benchmarkGroundTruth?.entries) ? benchmarkGroundTruth.entries : [];
  const latest = entries.length > 0 ? entries[0] : null;
  const recs = Array.isArray(latest?.recommendations) ? latest.recommendations : [];
  if (recs.length === 0) {
    return { sampleCount: 0, avgBenchmarkScore: 0, avgCapacityGain: 0, unresolvedRatio: 0 };
  }

  let scoreCount = 0;
  let scoreSum = 0;
  let gainCount = 0;
  let gainSum = 0;
  let unresolved = 0;

  for (const rec of recs) {
    if (!rec || typeof rec !== "object") continue;
    const status = String((rec as any).implementationStatus || "pending").toLowerCase().trim();
    if (status !== "implemented" && status !== "implemented_correctly") unresolved++;
    const score = Number((rec as any).benchmarkScore);
    if (Number.isFinite(score)) {
      scoreSum += score;
      scoreCount++;
    }
    const gain = Number((rec as any).capacityGain);
    if (Number.isFinite(gain)) {
      gainSum += gain;
      gainCount++;
    }
  }

  const avgBenchmarkScore = scoreCount > 0 ? scoreSum / scoreCount : 0;
  const avgCapacityGain = gainCount > 0 ? gainSum / gainCount : 0;
  const unresolvedRatio = recs.length > 0 ? unresolved / recs.length : 0;

  return {
    sampleCount: recs.length,
    avgBenchmarkScore: Math.round(avgBenchmarkScore * 1000) / 1000,
    avgCapacityGain: Math.round(avgCapacityGain * 1000) / 1000,
    unresolvedRatio: Math.round(unresolvedRatio * 1000) / 1000,
  };
}

// ── Integrity-Aware Benchmark Scoring ────────────────────────────────────────

/** Schema version for computeBenchmarkIntegrityScore output. */
export const BENCHMARK_INTEGRITY_SCHEMA_VERSION = 1;

/**
 * Non-linear unresolved-ratio penalty thresholds used by computeBenchmarkIntegrityScore.
 *
 * 0 – minor:    ratio < 0.30  → penalty multiplier 0.90  (minor penalty)
 * minor – moderate: ratio < 0.60 → penalty multiplier 0.70  (moderate penalty)
 * moderate+:    ratio ≥ 0.60  → penalty multiplier 0.50  (severe penalty)
 */
export const BENCHMARK_INTEGRITY_UNRESOLVED_THRESHOLDS = Object.freeze({
  minor:    0.30,
  moderate: 0.60,
} as const);

/** Machine-readable reason codes for benchmark contradiction detection. */
export const BENCHMARK_CONTRADICTION_REASON = Object.freeze({
  SAME_TOPIC_CONFLICTING_STATUS: "SAME_TOPIC_CONFLICTING_STATUS",
  DUPLICATE_ENTRY:               "DUPLICATE_ENTRY",
} as const);

export interface BenchmarkIntegrityResult {
  schemaVersion: typeof BENCHMARK_INTEGRITY_SCHEMA_VERSION;
  /** Overall integrity score in [0, 1] after applying penalties. Higher is better. */
  integrityScore: number;
  /** Number of contradiction pairs detected. */
  contradictionCount: number;
  /** Number of unique, normalized suite/topic names. */
  normalizedSuiteCount: number;
  /** Ratio of unresolved recommendations over total (0–1). */
  unresolvedRatio: number;
  /** Penalty multiplier applied due to unresolved ratio. */
  penaltyApplied: number;
  /** Raw average benchmark score before integrity penalty. */
  avgBenchmarkScore: number;
  /** Raw average capacity gain before integrity penalty. */
  avgCapacityGain: number;
  /** Total recommendation records processed. */
  sampleCount: number;
}

/**
 * Compute an integrity-aware benchmark score from ground-truth recommendation data.
 *
 * Upgrades status-only scoring with:
 *   1. Normalized suite/topic names (lowercase, deduplication).
 *   2. Contradiction detection: same topic with conflicting "implemented" / non-implemented status.
 *   3. Non-linear unresolved-ratio penalty curve (minor / moderate / severe thresholds).
 *
 * Returns a zero-signal record when no benchmark data is available.
 *
 * @param benchmarkGroundTruth - parsed benchmark_ground_truth.json content
 */
export function computeBenchmarkIntegrityScore(benchmarkGroundTruth: any): BenchmarkIntegrityResult {
  const zero: BenchmarkIntegrityResult = {
    schemaVersion: BENCHMARK_INTEGRITY_SCHEMA_VERSION,
    integrityScore: 0,
    contradictionCount: 0,
    normalizedSuiteCount: 0,
    unresolvedRatio: 0,
    penaltyApplied: 1,
    avgBenchmarkScore: 0,
    avgCapacityGain: 0,
    sampleCount: 0,
  };

  const entries = Array.isArray(benchmarkGroundTruth?.entries) ? benchmarkGroundTruth.entries : [];
  const latest = entries.length > 0 ? entries[0] : null;
  const recs = Array.isArray(latest?.recommendations) ? latest.recommendations : [];
  if (recs.length === 0) return zero;

  // ── 1. Collect metrics + normalize topic names ───────────────────────────
  const topicStatusMap = new Map<string, Set<string>>();
  const suiteNames = new Set<string>();
  let unresolved = 0;
  let scoreSum = 0;
  let scoreCount = 0;
  let gainSum = 0;
  let gainCount = 0;

  for (const rec of recs) {
    if (!rec || typeof rec !== "object") continue;
    const raw = rec as Record<string, unknown>;

    // Normalize topic/suite name: lowercase, trim, collapse whitespace
    const topic = String(raw.topic || raw.id || raw.summary || "unknown")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 80);
    const suite = String(raw.suite || raw.benchmarkSuite || topic).toLowerCase().trim();
    suiteNames.add(suite);

    const status = String(raw.implementationStatus || "pending").toLowerCase().trim();
    const isImplemented = status === "implemented" || status === "implemented_correctly";
    if (!isImplemented) unresolved++;

    // Track per-topic status values for contradiction detection
    const existing = topicStatusMap.get(topic) ?? new Set();
    existing.add(isImplemented ? "implemented" : "unresolved");
    topicStatusMap.set(topic, existing);

    const score = Number(raw.benchmarkScore);
    if (Number.isFinite(score)) { scoreSum += score; scoreCount++; }
    const gain = Number(raw.capacityGain);
    if (Number.isFinite(gain)) { gainSum += gain; gainCount++; }
  }

  const unresolvedRatio = recs.length > 0 ? unresolved / recs.length : 0;
  const avgBenchmarkScore = scoreCount > 0 ? scoreSum / scoreCount : 0;
  const avgCapacityGain = gainCount > 0 ? gainSum / gainCount : 0;

  // ── 2. Contradiction detection ───────────────────────────────────────────
  let contradictionCount = 0;
  for (const [, statuses] of topicStatusMap) {
    if (statuses.has("implemented") && statuses.has("unresolved")) {
      contradictionCount++;
    }
  }

  // ── 3. Non-linear unresolved penalty ────────────────────────────────────
  let penaltyApplied: number;
  if (unresolvedRatio < BENCHMARK_INTEGRITY_UNRESOLVED_THRESHOLDS.minor) {
    penaltyApplied = 0.90;
  } else if (unresolvedRatio < BENCHMARK_INTEGRITY_UNRESOLVED_THRESHOLDS.moderate) {
    penaltyApplied = 0.70;
  } else {
    penaltyApplied = 0.50;
  }

  // Additional contradiction penalty: each contradiction reduces score by 0.05 (max 0.3)
  const contradictionPenalty = Math.min(0.30, contradictionCount * 0.05);

  // Base score: blend of avgBenchmarkScore, avgCapacityGain, resolved ratio
  const resolvedRatio = 1 - unresolvedRatio;
  const rawScore = clamp01(
    (avgBenchmarkScore * 0.40) + (avgCapacityGain * 0.30) + (resolvedRatio * 0.30)
  );
  const integrityScore = Math.round(
    clamp01(rawScore * penaltyApplied - contradictionPenalty) * 1000
  ) / 1000;

  return {
    schemaVersion: BENCHMARK_INTEGRITY_SCHEMA_VERSION,
    integrityScore,
    contradictionCount,
    normalizedSuiteCount: suiteNames.size,
    unresolvedRatio: Math.round(unresolvedRatio * 1000) / 1000,
    penaltyApplied,
    avgBenchmarkScore: Math.round(avgBenchmarkScore * 1000) / 1000,
    avgCapacityGain: Math.round(avgCapacityGain * 1000) / 1000,
    sampleCount: recs.length,
  };
}

export const RETRY_EXPECTED_GAIN_MIN_THRESHOLD = 0.18;

function deriveRoutingOutcomeSignal(premiumUsageData: any, taskKind: string): {
  sampleCount: number;
  successRate: number;
  recentROI: number;
  completionRate: number;
  attemptRate: number;
  abstainRate: number;
  precisionOnAttempted: number;
  hardChainSuccessRate: number;
  hardChainSampleCount: number;
  laneReliability: number;
  outcomeScore: number;
} {
  const rows = Array.isArray(premiumUsageData) ? premiumUsageData : [];
  if (rows.length === 0) {
    return {
      sampleCount: 0,
      successRate: 0,
      recentROI: 0,
      completionRate: 0,
      attemptRate: 0,
      abstainRate: 0,
      precisionOnAttempted: 0,
      hardChainSuccessRate: 0,
      hardChainSampleCount: 0,
      laneReliability: 0,
      outcomeScore: 0,
    };
  }
  const key = String(taskKind || "general").trim().toLowerCase();
  const filtered = rows
    .filter((row) => row && typeof row === "object")
    .filter((row) => {
      const rowKind = String((row as any).taskKind || "general").trim().toLowerCase();
      return rowKind === key;
    })
    .slice(-30);
  if (filtered.length === 0) {
    return {
      sampleCount: 0,
      successRate: 0,
      recentROI: 0,
      completionRate: 0,
      attemptRate: 0,
      abstainRate: 0,
      precisionOnAttempted: 0,
      hardChainSuccessRate: 0,
      hardChainSampleCount: 0,
      laneReliability: 0,
      outcomeScore: 0,
    };
  }
  let successful = 0;
  let attempted = 0;
  let abstained = 0;
  const laneCounts = new Map<string, { total: number; successful: number; attempted: number; abstained: number }>();
  const hardChainGroups = new Map<string, { total: number; successful: number; abstained: number }>();
  for (const row of filtered) {
    const outcome = normalizeRoutingOutcome((row as any).outcome);
    const lane = getLaneForWorkerName((row as any).worker, "implementation");
    const laneAcc = laneCounts.get(lane) ?? { total: 0, successful: 0, attempted: 0, abstained: 0 };
    laneAcc.total += 1;
    if (isRoutingSuccess(outcome)) {
      successful += 1;
      laneAcc.successful += 1;
    }
    if (isRoutingAttempt(outcome)) {
      attempted += 1;
      laneAcc.attempted += 1;
    }
    if (isRoutingAbstain(outcome)) {
      abstained += 1;
      laneAcc.abstained += 1;
    }
    laneCounts.set(lane, laneAcc);

    const lineageId = String((row as any).lineageId || "").trim();
    if (lineageId) {
      const chainAcc = hardChainGroups.get(lineageId) ?? { total: 0, successful: 0, abstained: 0 };
      chainAcc.total += 1;
      if (isRoutingSuccess(outcome)) chainAcc.successful += 1;
      if (isRoutingAbstain(outcome)) chainAcc.abstained += 1;
      hardChainGroups.set(lineageId, chainAcc);
    }
  }
  const completionRate = filtered.length > 0 ? successful / filtered.length : 0;
  const attemptRate = filtered.length > 0 ? attempted / filtered.length : 0;
  const abstainRate = filtered.length > 0 ? abstained / filtered.length : 0;
  const precisionOnAttempted = attempted > 0 ? successful / attempted : 0;
  let hardChainTotal = 0;
  let hardChainSuccess = 0;
  for (const chain of hardChainGroups.values()) {
    if (chain.total <= 1) continue;
    hardChainTotal += 1;
    if (chain.abstained === 0 && chain.successful === chain.total) hardChainSuccess += 1;
  }
  const laneReliability = averageMetrics(
    [...laneCounts.values()].map((lane) => computeRoutingReliabilityScore({
        completionRate: lane.total > 0 ? lane.successful / lane.total : 0,
        attemptRate: lane.total > 0 ? lane.attempted / lane.total : 0,
        abstainRate: lane.total > 0 ? lane.abstained / lane.total : 0,
        precisionOnAttempted: lane.attempted > 0 ? lane.successful / lane.attempted : 0,
      }))
  );
  const hardChainSuccessRate = hardChainTotal > 0 ? hardChainSuccess / hardChainTotal : 0;
  const outcomeScore = computeRoutingOutcomeScore({
    attemptRate,
    abstainRate,
    precisionOnAttempted,
    laneReliability,
    hardChainSuccessRate,
    includeHardChain: hardChainTotal > 0,
  });
  return {
    sampleCount: filtered.length,
    successRate: roundMetric(precisionOnAttempted),
    recentROI: outcomeScore,
    completionRate: roundMetric(completionRate),
    attemptRate: roundMetric(attemptRate),
    abstainRate: roundMetric(abstainRate),
    precisionOnAttempted: roundMetric(precisionOnAttempted),
    hardChainSuccessRate: roundMetric(hardChainSuccessRate),
    hardChainSampleCount: hardChainTotal,
    laneReliability,
    outcomeScore,
  };
}

export function assessRetryExpectedROI(input: {
  attempt: number;
  maxRetries?: number;
  taskKind?: string;
  premiumUsageData?: any;
  benchmarkGroundTruth?: any;
  minExpectedGain?: number;
  promptCacheHitRate?: number;
  promptCacheSavedTokens?: number;
  lowRoiSignalCount?: number;
  failureClass?: string | null;
  finishCode?: string | null;
}): RetryExpectedRoiSignal {
  const attempt = Math.max(1, Math.floor(Number(input?.attempt) || 1));
  const maxRetries = Math.max(1, Math.floor(Number(input?.maxRetries) || 3));
  const taskKind = String(input?.taskKind || "general");
  const threshold = Number.isFinite(Number(input?.minExpectedGain))
    ? Math.max(0, Number(input?.minExpectedGain))
    : RETRY_EXPECTED_GAIN_MIN_THRESHOLD;
  const promptCacheHitRate = clamp01(Number(input?.promptCacheHitRate ?? 0));
  const promptCacheSavedTokens = Math.max(0, Number(input?.promptCacheSavedTokens ?? 0));
  const lowRoiSignalCount = Math.max(0, Math.floor(Number(input?.lowRoiSignalCount || 0)));
  const failureClass = String(input?.failureClass || "").trim().toLowerCase();
  const finishCode = String(input?.finishCode || "").trim().toLowerCase();
  if (attempt > maxRetries) {
    return {
      allowRetry: false,
      expectedGain: 0,
      threshold,
      reason: `retry-cap-reached(attempt=${attempt}, max=${maxRetries})`,
      attempt,
    };
  }
  const outcome = deriveRoutingOutcomeSignal(input?.premiumUsageData, taskKind);
  const benchmark = deriveLatestBenchmarkSignal(input?.benchmarkGroundTruth);
  const integrity = computeBenchmarkIntegrityScore(input?.benchmarkGroundTruth);
  const successSignal = outcome.sampleCount > 0 ? clamp01(outcome.outcomeScore ?? outcome.successRate) : 0.5;
  // Use integrity-aware benchmark signal: blend raw score with integrityScore penalty
  const rawBenchmarkSignal = benchmark.sampleCount > 0
    ? clamp01((benchmark.avgBenchmarkScore + benchmark.avgCapacityGain + (1 - benchmark.unresolvedRatio)) / 3)
    : 0.5;
  const benchmarkSignal = integrity.sampleCount > 0
    ? clamp01(rawBenchmarkSignal * integrity.penaltyApplied - Math.min(0.15, integrity.contradictionCount * 0.03))
    : rawBenchmarkSignal;
  const attemptDecay = 1 / attempt;
  const cacheBonus = (
    (promptCacheHitRate >= 0.55 ? 0.05 : promptCacheHitRate >= 0.30 ? 0.02 : 0)
    + (promptCacheSavedTokens >= 180 ? 0.04 : promptCacheSavedTokens >= 90 ? 0.02 : 0)
  );
  const lineagePenalty = Math.min(0.24, lowRoiSignalCount * 0.08);
  const failurePenalty =
    failureClass === FAILURE_CLASS.POLICY || /policy|guard|capability_check/.test(finishCode)
      ? 0.18
      : failureClass === FAILURE_CLASS.VERIFICATION || /^verification_report_fail:/.test(finishCode)
        ? 0.12
        : failureClass === FAILURE_CLASS.MODEL || failureClass === FAILURE_CLASS.EXTERNAL_API || /rate|quota|429|503|timeout|provider/.test(finishCode)
          ? 0.08
          : failureClass === FAILURE_CLASS.ENVIRONMENT
            ? 0.04
            : 0.02;
  const expectedGain = Math.round(clamp01((successSignal * benchmarkSignal * attemptDecay) + cacheBonus - lineagePenalty - failurePenalty) * 1000) / 1000;
  const allowRetry = expectedGain >= threshold;
  return {
    allowRetry,
    expectedGain,
    threshold,
    reason: `retry-roi(taskKind=${taskKind}, outcome=${successSignal.toFixed(2)}, precision=${(outcome.precisionOnAttempted ?? outcome.successRate).toFixed(2)}, attempt_rate=${(outcome.attemptRate ?? 0).toFixed(2)}, benchmark=${benchmarkSignal.toFixed(2)}, cache_bonus=${cacheBonus.toFixed(2)}, lineage_penalty=${lineagePenalty.toFixed(2)}, failure_penalty=${failurePenalty.toFixed(2)}, attempt=${attempt})`,
    attempt,
  };
}

/**
 * Determine whether routing for a hard task should escalate to a stronger model.
 *
 * Binds three deterministic signals:
 * 1) task hardness (T3 / critical-scale hints),
 * 2) observed outcome metrics (ROI + completion rate),
 * 3) benchmark ground-truth quality/capacity signals.
 */
export function assessHardTaskEscalation(
  taskHints: TaskHints = {},
  history: RoutingHistory = {},
  signals: {
    benchmarkGroundTruth?: any;
    outcomeMetrics?: Partial<RoutingOutcomeMetrics> | null;
    thresholds?: Partial<typeof HARD_TASK_UNCERTAINTY_THRESHOLDS>;
  } = {}
): HardTaskEscalationSignal {
  const profile = deriveHardTaskUncertaintyProfile(taskHints, history, signals);
  if (!profile.hardTask) {
    return {
      hardTask: false,
      escalate: false,
      severity: "none",
      reason: "not-hard-task",
      uncertaintyScore: 0,
    };
  }

  if (profile.uncertaintyScore >= 0.60 || (profile.flags.noSamples && profile.flags.highUnresolvedBenchmark)) {
    return {
      hardTask: true,
      escalate: true,
      severity: "required",
      reason: `hard-task-uncertainty-required(score=${profile.uncertaintyScore})`,
      uncertaintyScore: profile.uncertaintyScore,
    };
  }
  if (profile.uncertaintyScore >= 0.35) {
    return {
      hardTask: true,
      escalate: true,
      severity: "recommended",
      reason: `hard-task-uncertainty-recommended(score=${profile.uncertaintyScore})`,
      uncertaintyScore: profile.uncertaintyScore,
    };
  }
  return {
    hardTask: true,
    escalate: false,
    severity: "none",
    reason: `hard-task-uncertainty-low(score=${profile.uncertaintyScore})`,
    uncertaintyScore: profile.uncertaintyScore,
  };
}

function deriveHardTaskUncertaintyProfile(
  taskHints: TaskHints = {},
  history: RoutingHistory = {},
  signals: {
    benchmarkGroundTruth?: any;
    outcomeMetrics?: Partial<RoutingOutcomeMetrics> | null;
    thresholds?: Partial<typeof HARD_TASK_UNCERTAINTY_THRESHOLDS>;
  } = {},
): HardTaskUncertaintyProfile {
  const complexity = String(taskHints.complexity || "").toLowerCase().trim();
  const lines = Number(taskHints.estimatedLines || 0);
  const duration = Number(taskHints.estimatedDurationMinutes || 0);
  const hardTask =
    OPUS_ALLOWED_COMPLEXITIES.has(complexity) ||
    lines >= OPUS_MIN_ESTIMATED_LINES ||
    duration >= OPUS_MIN_DURATION_MINUTES;

  if (!hardTask) {
    return {
      hardTask: false,
      uncertaintyScore: 0,
      thresholds: HARD_TASK_UNCERTAINTY_THRESHOLDS,
      outcomeSampleCount: 0,
      outcomeSuccessRate: 0,
      outcomeROI: 0,
      outcomeAttemptRate: 0,
      outcomeAbstainRate: 0,
      precisionOnAttempted: 0,
      hardChainSuccessRate: 0,
      hardChainSampleCount: 0,
      laneReliability: 0,
      benchmarkScore: 0,
      capacityGain: 0,
      flags: {
        noSamples: false,
        lowSamples: false,
        weakSuccess: false,
        weakROI: false,
        weakAttemptRate: false,
        highAbstainRate: false,
        weakPrecision: false,
        weakHardChain: false,
        weakLaneReliability: false,
        weakBenchmarkScore: false,
        weakCapacityGain: false,
        highUnresolvedBenchmark: false,
      },
    };
  }

  const t = {
    ...HARD_TASK_UNCERTAINTY_THRESHOLDS,
    ...(signals.thresholds || {}),
  };

  const outcomeSampleCount = Number(signals.outcomeMetrics?.sampleCount ?? 0);
  const outcomeSuccessRate = clamp01(Number(signals.outcomeMetrics?.successRate ?? 0));
  const outcomeAttemptRate = clamp01(Number(signals.outcomeMetrics?.attemptRate ?? 0));
  const outcomeAbstainRate = clamp01(Number(signals.outcomeMetrics?.abstainRate ?? (outcomeSampleCount > 0 ? 1 - outcomeAttemptRate : 0)));
  const precisionOnAttempted = clamp01(Number(signals.outcomeMetrics?.precisionOnAttempted ?? outcomeSuccessRate));
  const hardChainSuccessRate = clamp01(Number(signals.outcomeMetrics?.hardChainSuccessRate ?? 0));
  const hardChainSampleCount = Math.max(0, Number(signals.outcomeMetrics?.hardChainSampleCount ?? 0));
  const laneReliability = clamp01(Number(signals.outcomeMetrics?.laneReliability ?? 0));
  const outcomeROI = Number.isFinite(Number(signals.outcomeMetrics?.recentROI))
    ? clamp01(Number(signals.outcomeMetrics?.recentROI))
    : clamp01(Number(history.recentROI || 0));

  const benchmark = deriveLatestBenchmarkSignal(signals.benchmarkGroundTruth || null);
  const integrityResult = computeBenchmarkIntegrityScore(signals.benchmarkGroundTruth || null);
  const lowSamples = outcomeSampleCount > 0 && outcomeSampleCount < t.minObservedSamples;
  const noSamples = outcomeSampleCount === 0;
  const weakSuccess = outcomeSampleCount > 0 && outcomeSuccessRate < t.minSuccessRate;
  const weakROI = outcomeROI > 0 && outcomeROI < t.minRecentROI;
  const weakAttemptRate = outcomeSampleCount > 0 && outcomeAttemptRate < t.minAttemptRate;
  const highAbstainRate = outcomeSampleCount > 0 && outcomeAbstainRate > t.maxAbstainRate;
  const weakPrecision = outcomeSampleCount > 0 && precisionOnAttempted < t.minPrecisionOnAttempted;
  const weakHardChain = hardChainSampleCount > 0 && hardChainSuccessRate < t.minHardChainSuccessRate;
  const weakLaneReliability = outcomeSampleCount > 0 && laneReliability > 0 && laneReliability < t.minLaneReliability;
  const weakBenchmarkScore =
    benchmark.sampleCount > 0 &&
    benchmark.avgBenchmarkScore > 0 &&
    benchmark.avgBenchmarkScore < t.minBenchmarkScore;
  const weakCapacityGain =
    benchmark.sampleCount > 0 &&
    benchmark.avgCapacityGain > 0 &&
    benchmark.avgCapacityGain < t.minCapacityGain;
  // Use integrity-aware unresolved check: either raw ratio threshold or low integrity score
  const highUnresolvedBenchmark = benchmark.sampleCount > 0 && (
    benchmark.unresolvedRatio >= BENCHMARK_INTEGRITY_UNRESOLVED_THRESHOLDS.moderate ||
    (integrityResult.sampleCount > 0 && integrityResult.integrityScore < 0.35)
  );

  const penalties = [
    noSamples ? 0.35 : 0,
    lowSamples ? 0.20 : 0,
    weakSuccess ? 0.25 : 0,
    weakROI ? 0.20 : 0,
    weakAttemptRate ? 0.15 : 0,
    highAbstainRate ? 0.15 : 0,
    weakPrecision ? 0.20 : 0,
    weakHardChain ? 0.15 : 0,
    weakLaneReliability ? 0.15 : 0,
    weakBenchmarkScore ? 0.15 : 0,
    weakCapacityGain ? 0.10 : 0,
    highUnresolvedBenchmark ? 0.15 : 0,
  ];
  const uncertaintyScore = Math.round(Math.min(1, penalties.reduce((a, b) => a + b, 0)) * 1000) / 1000;

  return {
    hardTask: true,
    uncertaintyScore,
    thresholds: t,
    outcomeSampleCount,
    outcomeSuccessRate,
    outcomeROI,
    outcomeAttemptRate,
    outcomeAbstainRate,
    precisionOnAttempted,
    hardChainSuccessRate,
    hardChainSampleCount,
    laneReliability,
    benchmarkScore: clamp01(Number(benchmark.avgBenchmarkScore ?? 0)),
    capacityGain: clamp01(Number(benchmark.avgCapacityGain ?? 0)),
    flags: {
      noSamples,
      lowSamples,
      weakSuccess,
      weakROI,
      weakAttemptRate,
      highAbstainRate,
      weakPrecision,
      weakHardChain,
      weakLaneReliability,
      weakBenchmarkScore,
      weakCapacityGain,
      highUnresolvedBenchmark,
    },
  };
}

function classifyDeliberationUncertaintyLevel(
  uncertaintyScore: number,
  hardTask: boolean,
): DeliberationPolicy["uncertaintyLevel"] {
  if (!hardTask || uncertaintyScore < 0.35) {
    return "low";
  }
  if (uncertaintyScore < 0.60) {
    return "moderate";
  }
  return "high";
}

function toFixedSignal(value: number): string {
  return Number(value || 0).toFixed(2);
}

function buildDeliberationCandidatePool(
  profile: HardTaskUncertaintyProfile,
): Array<{
  key: string;
  summary: string;
  rationale: string;
  cheapSignals: string[];
  signalScores: {
    uncertaintyReduction: number;
    cheapVerification: number;
    executionLeverage: number;
  };
}> {
  if (!profile.hardTask) {
    return [];
  }

  const contractSignals = [
    profile.flags.noSamples
      ? "no observed task-kind samples yet"
      : `sampleCount=${profile.outcomeSampleCount} below threshold ${profile.thresholds.minObservedSamples}`,
    profile.flags.weakPrecision
      ? `precisionOnAttempted=${toFixedSignal(profile.precisionOnAttempted)} below ${profile.thresholds.minPrecisionOnAttempted}`
      : "",
    profile.flags.highUnresolvedBenchmark ? "benchmark integrity unresolved for comparable hard tasks" : "",
  ].filter(Boolean);

  const verificationSignals = [
    profile.flags.weakSuccess
      ? `successRate=${toFixedSignal(profile.outcomeSuccessRate)} below ${profile.thresholds.minSuccessRate}`
      : "",
    profile.flags.weakAttemptRate
      ? `attemptRate=${toFixedSignal(profile.outcomeAttemptRate)} below ${profile.thresholds.minAttemptRate}`
      : "",
    profile.flags.highAbstainRate
      ? `abstainRate=${toFixedSignal(profile.outcomeAbstainRate)} above ${profile.thresholds.maxAbstainRate}`
      : "",
  ].filter(Boolean);

  const surfaceSignals = [
    profile.flags.weakROI
      ? `recentROI=${toFixedSignal(profile.outcomeROI)} below ${profile.thresholds.minRecentROI}`
      : "",
    profile.flags.weakLaneReliability
      ? `laneReliability=${toFixedSignal(profile.laneReliability)} below ${profile.thresholds.minLaneReliability}`
      : "",
    profile.flags.weakHardChain
      ? `hardChainSuccessRate=${toFixedSignal(profile.hardChainSuccessRate)} below ${profile.thresholds.minHardChainSuccessRate}`
      : "",
  ].filter(Boolean);

  return [
    {
      key: "smallest_verification",
      summary: "Run the smallest relevant verification slice to confirm the first failing surface.",
      rationale: "Cheap verification evidence should anchor the first move before deeper implementation work.",
      cheapSignals: verificationSignals,
      signalScores: {
        uncertaintyReduction: clamp01(
          0.5
          + (profile.flags.weakSuccess ? 0.2 : 0)
          + (profile.flags.weakAttemptRate ? 0.15 : 0)
          + (profile.flags.highAbstainRate ? 0.1 : 0)
        ),
        cheapVerification: clamp01(0.9 + (profile.outcomeSampleCount > 0 ? 0.05 : 0)),
        executionLeverage: clamp01(
          0.6
          + (profile.flags.weakHardChain ? 0.15 : 0)
          + (profile.flags.weakROI ? 0.1 : 0)
        ),
      },
    },
    {
      key: "contract_scan",
      summary: "Inspect the task contract, target files, and nearest tests before deeper execution.",
      rationale: "Thin evidence or weak precision favors a cheap contract pass before choosing an edit path.",
      cheapSignals: contractSignals,
      signalScores: {
        uncertaintyReduction: clamp01(
          0.55
          + (profile.flags.noSamples ? 0.25 : 0)
          + (profile.flags.lowSamples ? 0.1 : 0)
          + (profile.flags.weakPrecision ? 0.1 : 0)
        ),
        cheapVerification: 0.95,
        executionLeverage: clamp01(
          0.45
          + (profile.flags.weakAttemptRate ? 0.15 : 0)
          + (profile.flags.highAbstainRate ? 0.15 : 0)
        ),
      },
    },
    {
      key: "surface_map",
      summary: "Map the high-risk call path and isolate one reversible edit surface before coding.",
      rationale: "Hard-task throughput stays bounded when the runner narrows the edit surface before committing.",
      cheapSignals: surfaceSignals,
      signalScores: {
        uncertaintyReduction: clamp01(
          0.45
          + (profile.flags.weakLaneReliability ? 0.15 : 0)
          + (profile.flags.weakBenchmarkScore ? 0.1 : 0)
        ),
        cheapVerification: clamp01(
          0.75
          + (profile.flags.weakCapacityGain ? 0.05 : 0)
          + (profile.flags.highUnresolvedBenchmark ? 0.05 : 0)
        ),
        executionLeverage: clamp01(
          0.65
          + (profile.flags.weakROI ? 0.1 : 0)
          + (profile.flags.weakHardChain ? 0.1 : 0)
        ),
      },
    },
  ].map((candidate) => ({
    ...candidate,
    cheapSignals: candidate.cheapSignals.length > 0
      ? candidate.cheapSignals
      : ["bounded deliberation requested due to hard-task uncertainty"],
  }));
}

/**
 * Determine whether a task should run in lean single-pass mode or bounded
 * multi-attempt deliberation mode.
 *
 * Routine work remains single-pass. Only high-uncertainty hard tasks are
 * upgraded to multi-attempt reflection/search mode.
 */
export function decideDeliberationPolicy(
  taskHints: TaskHints = {},
  history: RoutingHistory = {},
  signals: {
    benchmarkGroundTruth?: any;
    outcomeMetrics?: Partial<RoutingOutcomeMetrics> | null;
    lineageSignals?: LineageRoutingSignals | null;
  } = {}
): DeliberationPolicy {
  const profile = deriveHardTaskUncertaintyProfile(taskHints, history, signals);
  const hard = assessHardTaskEscalation(taskHints, history, signals);
  const lineageSignals = signals.lineageSignals || {};
  const lowRoiSignalCount = Math.max(0, Math.floor(Number(lineageSignals.lowRoiSignalCount || 0)));
  const promptCacheHitRate = clamp01(Number(lineageSignals.promptCacheHitRate ?? 0));
  const promptCacheSavedTokens = Math.max(0, Number(lineageSignals.promptCacheSavedTokens ?? 0));
  const promptCacheCheap = promptCacheHitRate >= 0.55 || promptCacheSavedTokens >= 180;
  const latestFailureClass = String(lineageSignals.latestFailureClass || "").trim().toLowerCase();
  const latestFinishCode = String(lineageSignals.latestFinishCode || "").trim().toLowerCase();
  const selectionPattern =
    latestFailureClass === FAILURE_CLASS.LOGIC_DEFECT
      ? "reasoning-recovery"
      : latestFailureClass === FAILURE_CLASS.POLICY
        || latestFailureClass === FAILURE_CLASS.VERIFICATION
        || /policy|guard|capability_check|verification/.test(latestFinishCode)
        ? "constraint-first"
        : latestFailureClass === FAILURE_CLASS.MODEL
          || latestFailureClass === FAILURE_CLASS.EXTERNAL_API
          || /rate|quota|429|503|timeout|provider/.test(latestFinishCode)
          ? "cooldown-stability"
          : "balanced";
  const order = selectionPattern === "constraint-first"
    ? ["contract_scan", "smallest_verification", "surface_map"]
    : selectionPattern === "cooldown-stability"
      ? ["contract_scan", "surface_map", "smallest_verification"]
      : ["smallest_verification", "surface_map", "contract_scan"];
  const rank = new Map(order.map((key, index) => [key, index]));
  if (!hard.hardTask || !hard.escalate) {
    return {
      mode: "single-pass",
      attempts: 1,
      reflection: false,
      boundedSearch: false,
      searchBudget: 0,
      uncertaintyLevel: classifyDeliberationUncertaintyLevel(profile.uncertaintyScore, profile.hardTask),
      executionMode: "direct_execute",
      candidateFirstMoves: [],
      recommendedFirstMove: null,
      reason: `${hard.reason}; pattern=${selectionPattern}; low-roi-lineage=${lowRoiSignalCount}`,
    };
  }
  if (lowRoiSignalCount >= 2 && !promptCacheCheap) {
    return {
      mode: "single-pass",
      attempts: 1,
      reflection: false,
      boundedSearch: false,
      searchBudget: 0,
      uncertaintyLevel: classifyDeliberationUncertaintyLevel(profile.uncertaintyScore, profile.hardTask),
      executionMode: "direct_execute",
      candidateFirstMoves: [],
      recommendedFirstMove: null,
      reason: `${hard.reason}; lineage-low-roi-gate(count=${lowRoiSignalCount})`,
    };
  }

  const required = hard.severity === "required";
  const reorderedCandidates = (() => {
    const baseCandidates = buildDeliberationCandidatePool(profile);
    return [...baseCandidates].sort((left, right) => {
      const leftRank = rank.has(left.key) ? rank.get(left.key)! : order.length;
      const rightRank = rank.has(right.key) ? rank.get(right.key)! : order.length;
      return leftRank - rightRank;
    });
  })();
  const searchBudget = Math.max(
    1,
    Math.min(
      required ? 3 : 2,
      (required ? 3 : 2) - Math.min(lowRoiSignalCount, promptCacheCheap ? 0 : 1),
    ),
  );
  const candidateFirstMoves = scheduleBoundedHypothesisCandidates(
    reorderedCandidates,
    { limit: searchBudget },
  ).sort((left, right) => {
    const leftRank = rank.has(left.key) ? rank.get(left.key)! : order.length;
    const rightRank = rank.has(right.key) ? rank.get(right.key)! : order.length;
    return leftRank - rightRank;
  });
  return {
    mode: "multi-attempt",
    attempts: Math.max(2, (required ? 3 : 2) - Math.min(lowRoiSignalCount, promptCacheCheap ? 0 : 1)),
    reflection: true,
    boundedSearch: true,
    searchBudget,
    uncertaintyLevel: classifyDeliberationUncertaintyLevel(profile.uncertaintyScore, profile.hardTask),
    executionMode: "bounded_deliberation",
    candidateFirstMoves,
    recommendedFirstMove: candidateFirstMoves[0] ?? null,
    reason: `${hard.reason}; pattern=${selectionPattern}; low-roi-lineage=${lowRoiSignalCount}; prompt-cache-cheap=${promptCacheCheap}`,
  };
}

export interface TaskKindEconomicsPoint {
  successProbability: number;
  capacityImpact: number;
  requestCost: number;
}

function toTaskKindKey(taskKind: string): string {
  return String(taskKind || "").trim().toLowerCase();
}

function normalizeEconomicsPoint(input: any): TaskKindEconomicsPoint | null {
  if (!input || typeof input !== "object") return null;
  const successProbability = Number(input.successProbability);
  const capacityImpact = Number(input.capacityImpact);
  const requestCost = Number(input.requestCost);
  if (!Number.isFinite(successProbability) || !Number.isFinite(capacityImpact) || !Number.isFinite(requestCost) || requestCost <= 0) {
    return null;
  }
  return {
    successProbability: clamp01(successProbability),
    capacityImpact: Math.max(0, capacityImpact),
    requestCost,
  };
}

export function computeExpectedValue(point: TaskKindEconomicsPoint): number {
  return (point.successProbability * point.capacityImpact) / Math.max(0.0001, point.requestCost);
}

/**
 * Canonicalize a model name string to a consistent telemetry key.
 *
 * Canonical form: lowercase, hyphens and underscores collapsed to single
 * spaces, surrounding whitespace trimmed.  This prevents fragmented ROI
 * signals when the same model is logged under different string variations
 * (e.g. "Claude Sonnet 4.6" vs "claude-sonnet-4-6" vs "claude_sonnet_4_6").
 *
 * @param name — raw model name from a log entry, config field, or API response
 * @returns canonical key string; empty string when input is blank/null
 */
export function normalizeModelLabel(name: string | null | undefined): string {
  const raw = String(name ?? "").trim();
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[-_]+/g, " ")   // collapse hyphen/underscore separators to space
    .replace(/\s+/g, " ")     // collapse repeated whitespace
    .trim();
}

const VERIFICATION_ROUTING_FAILURE_PENALTY = Object.freeze({
  [VERIFICATION_FAILURE_CODE.CLE]: 0.18,
  [VERIFICATION_FAILURE_CODE.IA]: 0.24,
  [VERIFICATION_FAILURE_CODE.INVALID_FORMAT]: 0.14,
  [VERIFICATION_FAILURE_CODE.TLE]: 0.16,
  [VERIFICATION_FAILURE_CODE.POLICY_VIOLATION]: 0.28,
  [VERIFICATION_FAILURE_CODE.HARNESS_ARTIFACT]: 0.06,
} as const);

function deriveVerificationRoutingAdjustment(taskKind: string, cycleAnalytics: any): {
  multiplier: number;
  reason: string;
} | null {
  const key = toTaskKindKey(taskKind);
  const taskTelemetry = cycleAnalytics?.verificationTelemetry?.byTaskKind?.[key];
  if (!taskTelemetry || typeof taskTelemetry !== "object") return null;

  const sampleCount = Number((taskTelemetry as any).sampleCount ?? 0);
  if (!Number.isFinite(sampleCount) || sampleCount < MIN_TELEMETRY_SAMPLE_THRESHOLD) {
    return null;
  }

  const averageWeightedScore = clamp01(Number((taskTelemetry as any).averageWeightedScore ?? 1));
  const failureCodeCounts = (taskTelemetry as any).failureCodeCounts && typeof (taskTelemetry as any).failureCodeCounts === "object"
    ? (taskTelemetry as any).failureCodeCounts as Record<string, unknown>
    : {};
  let burden = 0;
  for (const [code, penalty] of Object.entries(VERIFICATION_ROUTING_FAILURE_PENALTY)) {
    const count = Number(failureCodeCounts[code] ?? 0);
    if (!Number.isFinite(count) || count <= 0) continue;
    const rate = clamp01(count / Math.max(1, sampleCount));
    burden += rate * penalty;
  }
  const multiplier = Math.max(0.1, Math.round(clamp01(averageWeightedScore - burden) * 1000) / 1000);
  const dominantFailureCode = String((taskTelemetry as any).dominantFailureCode || "").trim() || "none";

  return {
    multiplier,
    reason: `verification-penalty(score=${averageWeightedScore.toFixed(2)}, burden=${Math.round(burden * 1000) / 1000}, dominant=${dominantFailureCode})`,
  };
}

export function rankModelsByTaskKindExpectedValue(
  taskKind: string,
  models: string[],
  cycleAnalytics: any,
  opts: {
    taskHints?: TaskHints;
    history?: RoutingHistory;
    signals?: {
      benchmarkGroundTruth?: any;
      outcomeMetrics?: Partial<RoutingOutcomeMetrics> | null;
    };
  } = {},
): { rankedModels: string[]; scoreByModel: Record<string, number>; usedTelemetry: boolean; reason: string } {
  const original = Array.isArray(models) ? models.filter(Boolean) : [];
  if (original.length <= 1) {
    return { rankedModels: original, scoreByModel: {}, usedTelemetry: false, reason: "single-candidate" };
  }

  const key = toTaskKindKey(taskKind);
  const byTaskKind = cycleAnalytics?.modelRoutingTelemetry?.byTaskKind;
  const taskTelemetry = byTaskKind && typeof byTaskKind === "object" ? byTaskKind[key] : null;
  const telemetryOutcomeMetrics = taskTelemetry && typeof taskTelemetry === "object"
    ? {
        sampleCount: Number((taskTelemetry as any).sampleCount ?? 0),
        successRate: Number((taskTelemetry as any)?.default?.successProbability ?? 0),
        recentROI: Number(
          (taskTelemetry as any)?.default?.outcomeScore
          ?? (taskTelemetry as any)?.default?.capacityImpact
          ?? cycleAnalytics?.routingROISummary?.overallLinkedROI
          ?? 0
        ),
        completionRate: Number((taskTelemetry as any)?.default?.completionRate ?? 0),
        attemptRate: Number((taskTelemetry as any)?.default?.attemptRate ?? 0),
        abstainRate: Number((taskTelemetry as any)?.default?.abstainRate ?? 0),
        precisionOnAttempted: Number((taskTelemetry as any)?.default?.precisionOnAttempted ?? 0),
        hardChainSuccessRate: Number((taskTelemetry as any)?.default?.hardChainSuccessRate ?? 0),
        hardChainSampleCount: Number((taskTelemetry as any)?.default?.hardChainSampleCount ?? 0),
        laneReliability: Number((taskTelemetry as any)?.default?.laneReliability ?? 0),
        outcomeScore: Number((taskTelemetry as any)?.default?.outcomeScore ?? 0),
      } satisfies Partial<RoutingOutcomeMetrics>
    : null;

  const hardSignal = assessHardTaskEscalation(
    opts.taskHints || {},
    opts.history || {},
    {
      ...(opts.signals || {}),
      outcomeMetrics: opts.signals?.outcomeMetrics ?? telemetryOutcomeMetrics,
    },
  );
  if (hardSignal.escalate && hardSignal.severity === "required") {
    return {
      rankedModels: original,
      scoreByModel: {},
      usedTelemetry: false,
      reason: `hard-task-uncertainty-required(score=${hardSignal.uncertaintyScore})`,
    };
  }

  if (!taskTelemetry || typeof taskTelemetry !== "object") {
    return { rankedModels: original, scoreByModel: {}, usedTelemetry: false, reason: "telemetry-missing" };
  }

  // Enforce minimum sample threshold: routing on sparse data is worse than no routing.
  const taskSampleCount = typeof (taskTelemetry as any).sampleCount === "number"
    ? (taskTelemetry as any).sampleCount
    : Infinity; // legacy telemetry without sampleCount is trusted as-is
  const lineageLinkedSampleCount = typeof (taskTelemetry as any).lineageLinkedSampleCount === "number"
    ? (taskTelemetry as any).lineageLinkedSampleCount
    : null;
  const linkedRatio = typeof (taskTelemetry as any).lineageLinkedRatio === "number"
    ? clamp01((taskTelemetry as any).lineageLinkedRatio)
    : (typeof cycleAnalytics?.routingROISummary?.linkedRatio === "number"
        ? clamp01(cycleAnalytics.routingROISummary.linkedRatio)
        : null);
  const linkageAdjustedSampleCount = linkedRatio !== null
    ? Math.floor(taskSampleCount * linkedRatio)
    : taskSampleCount;
  const hasLineageLinkedSampleCount = typeof lineageLinkedSampleCount === "number"
    && Number.isFinite(lineageLinkedSampleCount)
    && lineageLinkedSampleCount >= 0;
  // Enforce lineage linkage when analytics publishes linked sample counts.
  // Legacy telemetry (without lineage counts) remains backward-compatible.
  const effectiveSampleCount = hasLineageLinkedSampleCount
    ? Math.min(taskSampleCount, lineageLinkedSampleCount, linkageAdjustedSampleCount)
    : linkageAdjustedSampleCount;
  if (!Number.isFinite(effectiveSampleCount)) {
    return { rankedModels: original, scoreByModel: {}, usedTelemetry: false, reason: "telemetry-invalid" };
  }
  if (effectiveSampleCount < MIN_TELEMETRY_SAMPLE_THRESHOLD) {
    return { rankedModels: original, scoreByModel: {}, usedTelemetry: false, reason: "telemetry-below-threshold" };
  }

  const defaultPoint = normalizeEconomicsPoint((taskTelemetry as any).default);
  const modelPoints = (taskTelemetry as any).models && typeof (taskTelemetry as any).models === "object"
    ? (taskTelemetry as any).models
    : {};
  const verificationAdjustment = deriveVerificationRoutingAdjustment(taskKind, cycleAnalytics);

  const scoreByModel: Record<string, number> = {};
  let usableScores = 0;
  for (const model of original) {
    const direct = normalizeEconomicsPoint(modelPoints[model]);
    const lower = normalizeEconomicsPoint(modelPoints[String(model).toLowerCase()]);
    const canonical = normalizeEconomicsPoint(modelPoints[normalizeModelLabel(model)]);
    const point = direct || lower || canonical || defaultPoint;
    if (!point) continue;
    const baseScore = computeExpectedValue(point);
    const adjustedScore = verificationAdjustment
      ? baseScore * verificationAdjustment.multiplier
      : baseScore;
    scoreByModel[model] = Math.round(adjustedScore * 1000) / 1000;
    usableScores += 1;
  }
  if (usableScores === 0) {
    return { rankedModels: original, scoreByModel: {}, usedTelemetry: false, reason: "telemetry-invalid" };
  }

  const rankedModels = [...original].sort((a, b) => {
    const as = Number.isFinite(scoreByModel[a]) ? scoreByModel[a] : Number.NEGATIVE_INFINITY;
    const bs = Number.isFinite(scoreByModel[b]) ? scoreByModel[b] : Number.NEGATIVE_INFINITY;
    if (bs !== as) return bs - as;
    return original.indexOf(a) - original.indexOf(b);
  });

  return {
    rankedModels,
    scoreByModel,
    usedTelemetry: true,
    reason: verificationAdjustment
      ? `expected-value(taskKind)+${verificationAdjustment.reason}`
      : "expected-value(taskKind)",
  };
}

// ── Memory-hit routing adjustment (Task 2) ────────────────────────────────────
//
// Memory hits (injected knowledge-memory entries) are positively correlated with
// completion quality when the hit rate is high.  When recent memory-hit rate is
// low it may indicate the memory is stale or irrelevant — no routing adjustment
// is applied in that case (fail-open so missing memory never blocks dispatch).

/** Weight applied to memory hit ratio when adjusting the quality floor. */
export const MEMORY_HIT_ROUTING_WEIGHT = 0.05 as const;

/**
 * Compute a routing floor adjustment from the recent memory-hit success ratio.
 *
 * Logic:
 *   - hitRatio ≥ 0.7  → relax floor by MEMORY_HIT_ROUTING_WEIGHT (memory is effective)
 *   - hitRatio > 0 and < 0.3 → tighten floor by MEMORY_HIT_ROUTING_WEIGHT (memory low effectiveness)
 *   - otherwise → no adjustment
 *
 * Returns { adjustment, reason } where adjustment is the signed delta to add to the quality floor.
 * Never throws — returns { adjustment: 0, reason: "no-data" } when hitRatio is absent.
 *
 * @param hitRatio — ratio of injected memory entries that correlated with a done outcome (0–1).
 *                   Pass 0 or omit when no history exists.
 */
export function computeMemoryHitBonus(
  hitRatio: number | undefined | null
): { adjustment: number; reason: string } {
  const ratio = typeof hitRatio === "number" && Number.isFinite(hitRatio)
    ? Math.max(0, Math.min(1, hitRatio))
    : -1;
  if (ratio < 0) return { adjustment: 0, reason: "no-data" };
  if (ratio >= 0.7) return { adjustment: -MEMORY_HIT_ROUTING_WEIGHT, reason: `memory-effective(ratio=${ratio.toFixed(2)})` };
  if (ratio > 0 && ratio < 0.3) return { adjustment: MEMORY_HIT_ROUTING_WEIGHT, reason: `memory-low-effectiveness(ratio=${ratio.toFixed(2)})` };
  return { adjustment: 0, reason: `memory-neutral(ratio=${ratio.toFixed(2)})` };
}

// ── Benchmark ingestion normalization ─────────────────────────────────────────
//
// Provides strict ingestion normalization for benchmark artifacts (SWE-bench,
// OSWorld-verified style, etc.) including schema/date/step-budget field validation
// and suite classification (verified_suite vs exploratory_suite).

/** Suite classification for benchmark evaluation reporting. */
export const BENCHMARK_SUITE_TYPE = Object.freeze({
  /** Verified results: status in verifiedSuiteStatuses AND verifiedAt present (for OSWorld-style). */
  VERIFIED:    "verified_suite",
  /** Exploratory results: failed, partial, or missing verification timestamp. */
  EXPLORATORY: "exploratory_suite",
});

// ── Benchmark planning priors ─────────────────────────────────────────────────
// Converts benchmark uncertainty and historical capacity gain into planning
// priors that Prometheus uses to choose packet strictness, verification depth,
// and decomposition strategy before dispatch — not only worker model routing.

/**
 * Runtime violation and retry signal derived from the previous cycle's observed
 * outcomes.  Fed into computeBenchmarkPlanningPriors so that high retry / violation
 * pressure tightens planning strictness independently of benchmark capacity gain.
 *
 * All rate fields are in the range [0, 1]; null means no data available.
 */
export interface RetryViolationSignal {
  /** Fraction of dispatched workers that triggered transient retries (0–1). */
  retryRate: number | null;
  /** Fraction of dispatched workers with contract violations (closureBoundary + hookTelemetry). */
  contractViolationRate: number | null;
  /** Fraction of dispatched workers that were rerouted away from their planned role (0–1). */
  rerouteRate: number | null;
}

/**
 * Planning priors derived from benchmark history and uncertainty.
 * Applied in the Prometheus post-processing pipeline to adjust packet
 * strictness thresholds and decomposition limits before dispatch.
 */
export interface PlanningPrior {
  /** Multiplier for packet strictness thresholds (1.0 = baseline). > 1.0 = stricter. */
  strictnessMultiplier: number;
  /** Required verification depth signal for packet admission. */
  verificationDepth: "shallow" | "standard" | "deep";
  /** Signed adjustment to the decomposition plan cap (+N = more plans allowed). */
  decompositionCapAdjustment: number;
  /** Uncertainty level derived from benchmark history. */
  uncertainty: "low" | "medium" | "high";
  /** Sliding-window capacity gain used to derive this prior (null = no history). */
  capacityGain: number | null;
  /**
   * Additive adjustment applied on top of the benchmark multiplier due to observed
   * retry / contract-violation / reroute pressure from the previous cycle.
   * 0.0 when no retry-violation signal was provided or all rates were low.
   */
  retryViolationAdjustment: number;
}

export interface CandidatePlanningPolicy {
  enabled: boolean;
  minCandidates: number;
  maxCandidates: number;
  reason: string;
}

/**
 * Enable bounded multi-candidate planning only for high-uncertainty planning cycles.
 * The returned bounds are intentionally small to control premium-request spend.
 */
export function deriveCandidatePlanningPolicy(
  planningPrior: Pick<PlanningPrior, "uncertainty" | "verificationDepth"> | null | undefined,
): CandidatePlanningPolicy {
  const uncertainty = String(planningPrior?.uncertainty || "low").trim().toLowerCase();
  if (uncertainty !== "high") {
    return {
      enabled: false,
      minCandidates: 1,
      maxCandidates: 1,
      reason: `single_pass_uncertainty=${uncertainty || "low"}`,
    };
  }

  const verificationDepth = String(planningPrior?.verificationDepth || "standard").trim().toLowerCase();
  const maxCandidates = verificationDepth === "deep" ? 3 : 2;
  return {
    enabled: true,
    minCandidates: 2,
    maxCandidates,
    reason: `bounded_multi_candidate_uncertainty=high verificationDepth=${verificationDepth}`,
  };
}

/**
 * Compute planning priors from benchmark ground-truth data and cycle history.
 *
 * Rules (benchmark-based):
 *   - No history (null gain / < 2 evaluated samples) → baseline strictness, high uncertainty
 *   - Low gain (< 0.30) → +30% stricter thresholds, deep verification, cap -2
 *   - Medium gain (0.30 – 0.70) → +10% stricter, standard verification, no cap change
 *   - High gain (≥ 0.70) → −10% strictness (relax), shallow verification, cap +2
 *
 * Rules (retry/violation overlay, additive on top of benchmark multiplier):
 *   - contractViolationRate > 0.20 → +0.15 strictness
 *   - retryRate > 0.30             → +0.10 strictness
 *   - rerouteRate > 0.30           → escalate verificationDepth by one level
 *
 * Input shape mirrors the output of computeResearchCapacityGain() in cycle_analytics.ts
 * so callers can compute the gain once and pass both values here.
 *
 * Never throws — returns baseline priors on any error.
 *
 * @param capacityGainResult — { capacityGain: number | null; evaluatedCount: number }
 * @param retryViolationSignal — optional observed retry/violation rates from prior cycle
 */
export function computeBenchmarkPlanningPriors(
  capacityGainResult: { capacityGain: number | null; evaluatedCount: number } | null | undefined,
  retryViolationSignal?: RetryViolationSignal | null,
): PlanningPrior {
  const gain = typeof capacityGainResult?.capacityGain === "number"
    ? capacityGainResult.capacityGain
    : null;
  const evaluated = Number(capacityGainResult?.evaluatedCount) || 0;

  // ── Benchmark-based base prior ─────────────────────────────────────────────
  let baseStrictness: number;
  let baseDepth: "shallow" | "standard" | "deep";
  let baseCapAdj: number;
  let uncertainty: "low" | "medium" | "high";

  if (gain === null || evaluated < 2) {
    baseStrictness = 1.0;
    baseDepth      = "standard";
    baseCapAdj     = 0;
    uncertainty    = "high";
  } else if (gain < 0.30) {
    baseStrictness = 1.3;
    baseDepth      = "deep";
    baseCapAdj     = -2;
    uncertainty    = "high";
  } else if (gain < 0.70) {
    baseStrictness = 1.1;
    baseDepth      = "standard";
    baseCapAdj     = 0;
    uncertainty    = "medium";
  } else {
    baseStrictness = 0.9;
    baseDepth      = "shallow";
    baseCapAdj     = 2;
    uncertainty    = "low";
  }

  // ── Retry / violation overlay ──────────────────────────────────────────────
  // Each observed pressure signal adds an independent strictness increment so
  // that multiple concurrent pressures compound correctly (max +0.25 additive).
  let rvAdj = 0;
  let depthEscalated = false;

  if (retryViolationSignal && typeof retryViolationSignal === "object") {
    const vr = typeof retryViolationSignal.contractViolationRate === "number"
      ? retryViolationSignal.contractViolationRate
      : null;
    const rr = typeof retryViolationSignal.retryRate === "number"
      ? retryViolationSignal.retryRate
      : null;
    const rer = typeof retryViolationSignal.rerouteRate === "number"
      ? retryViolationSignal.rerouteRate
      : null;

    if (vr !== null && vr > 0.20) rvAdj += 0.15;
    if (rr !== null && rr > 0.30)  rvAdj += 0.10;
    if (rer !== null && rer > 0.30) {
      // Escalate verification depth one level (shallow→standard, standard→deep).
      depthEscalated = true;
    }
  }

  const finalStrictness = Math.round((baseStrictness + rvAdj) * 1000) / 1000;
  const finalDepth: "shallow" | "standard" | "deep" = depthEscalated
    ? (baseDepth === "shallow" ? "standard" : "deep")
    : baseDepth;

  return {
    strictnessMultiplier:       finalStrictness,
    verificationDepth:          finalDepth,
    decompositionCapAdjustment: baseCapAdj,
    uncertainty,
    capacityGain:               gain,
    retryViolationAdjustment:   Math.round(rvAdj * 1000) / 1000,
  };
}

/** A benchmark sample after normalization including suite classification and error list. */
export interface NormalizedBenchmarkSample extends BenchmarkSample {
  stepBudget?: number | null;
  verifiedAt?: string | null;
  suiteType: string;
  normalizationErrors: string[];
}

/**
 * Normalize a raw benchmark artifact for strict ingestion.
 *
 * Validation steps:
 *   1. Locate the matching contract by benchmarkName (case-insensitive).
 *   2. Check all requiredFields — empty/null/undefined values are flagged.
 *   3. Validate status against the contract's statusEnum.
 *   4. Normalize dateFields to ISO 8601; non-parseable dates produce an error and are set to null.
 *   5. Validate stepBudgetFields as positive integers; invalid values produce an error and are set to null.
 *   6. Classify the sample as verified_suite or exploratory_suite via classifyBenchmarkSuite().
 *
 * Returns the normalized sample and a list of normalization errors.
 * A non-empty errors array means the sample failed at least one validation rule.
 * Never throws.
 */
export function normalizeBenchmarkSample(
  raw: Record<string, unknown>,
  contracts: BenchmarkContract[]
): { sample: NormalizedBenchmarkSample; errors: string[] } {
  const errors: string[] = [];
  const partial = raw && typeof raw === "object" ? raw : {};
  const benchmarkName = String(partial.benchmarkName ?? "").trim();

  const contract = Array.isArray(contracts)
    ? contracts.find((c) => c.name.toLowerCase() === benchmarkName.toLowerCase())
    : undefined;

  if (!contract) {
    errors.push(`unknown_benchmark:${benchmarkName || "missing"}`);
    return {
      sample: {
        benchmarkName,
        taskId: "",
        status: "",
        model: "",
        tokensIn: 0,
        tokensOut: 0,
        elapsedMs: 0,
        evaluatedAt: "",
        suiteType: BENCHMARK_SUITE_TYPE.EXPLORATORY,
        normalizationErrors: errors,
      },
      errors,
    };
  }

  // Validate required fields
  for (const field of contract.requiredFields) {
    const value = partial[field];
    const missing =
      value === null ||
      value === undefined ||
      (typeof value === "string" && String(value).trim().length === 0);
    if (missing) errors.push(`missing_field:${field}`);
  }

  // Validate status enum (normalize to lowercase for comparison)
  const statusRaw = String(partial.status ?? "").trim().toLowerCase();
  if (!contract.statusEnum.includes(statusRaw)) {
    errors.push(`invalid_status:${statusRaw || "missing"}`);
  }

  // Normalize date fields to ISO 8601
  const dateFields: string[] = Array.isArray((contract as any).dateFields)
    ? (contract as any).dateFields
    : ["evaluatedAt"];
  const normalizedDates: Record<string, string | null> = {};
  for (const field of dateFields) {
    const rawVal = partial[field];
    if (rawVal === null || rawVal === undefined) {
      normalizedDates[field] = null;
      continue;
    }
    const dateStr = String(rawVal).trim();
    if (!dateStr) {
      normalizedDates[field] = null;
      continue;
    }
    const parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) {
      errors.push(`invalid_date:${field}=${dateStr}`);
      normalizedDates[field] = null;
    } else {
      normalizedDates[field] = parsed.toISOString();
    }
  }

  // Validate step-budget fields (must be positive integers)
  const stepBudgetFields: string[] = Array.isArray((contract as any).stepBudgetFields)
    ? (contract as any).stepBudgetFields
    : [];
  let stepBudget: number | null = null;
  for (const field of stepBudgetFields) {
    const rawVal = partial[field];
    if (rawVal === null || rawVal === undefined) {
      // Missing — already flagged by requiredFields check if applicable
      continue;
    }
    const num = Number(rawVal);
    if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
      errors.push(`invalid_step_budget:${field}=${rawVal}`);
    } else {
      stepBudget = num;
    }
  }

  // Classify suite type
  const suiteType = classifyBenchmarkSuite(
    { ...(partial as any), status: statusRaw },
    contracts
  );

  const sample: NormalizedBenchmarkSample = {
    benchmarkName,
    taskId:    String(partial.taskId    ?? "").trim(),
    status:    statusRaw,
    model:     String(partial.model     ?? "").trim(),
    tokensIn:  Number(partial.tokensIn  ?? 0),
    tokensOut: Number(partial.tokensOut ?? 0),
    elapsedMs: Number(partial.elapsedMs ?? 0),
    evaluatedAt: normalizedDates.evaluatedAt ?? String(partial.evaluatedAt ?? "").trim(),
    stepBudget,
    verifiedAt: normalizedDates.verifiedAt ?? null,
    suiteType,
    normalizationErrors: errors,
  };

  return { sample, errors };
}

/**
 * Classify a benchmark sample into verified_suite or exploratory_suite.
 *
 * A sample is VERIFIED when:
 *   - Its status is in the contract's verifiedSuiteStatuses list (default: ["success"]).
 *   - For benchmarks with stepBudgetFields (OSWorld-style): verifiedAt must also be present
 *     and parseable as a valid date.
 *
 * All other samples are classified as EXPLORATORY.
 * Unknown benchmarks always fall through to EXPLORATORY (fail-safe).
 */
export function classifyBenchmarkSuite(
  sample: Partial<BenchmarkSample> & Record<string, unknown>,
  contracts: BenchmarkContract[]
): string {
  const benchmarkName = String(sample?.benchmarkName ?? "").trim().toLowerCase();
  const contract = Array.isArray(contracts)
    ? contracts.find((c) => c.name.toLowerCase() === benchmarkName)
    : undefined;

  // Unknown benchmark — cannot verify; always exploratory
  if (!contract) {
    return BENCHMARK_SUITE_TYPE.EXPLORATORY;
  }

  const allowedStatuses: string[] = Array.isArray((contract as any)?.verifiedSuiteStatuses)
    ? (contract as any).verifiedSuiteStatuses.map((s: unknown) => String(s).toLowerCase())
    : ["success"];

  const status = String(sample?.status ?? "").trim().toLowerCase();
  if (!allowedStatuses.includes(status)) {
    return BENCHMARK_SUITE_TYPE.EXPLORATORY;
  }

  // For OSWorld-style benchmarks (those with stepBudgetFields), require a valid verifiedAt
  const hasStepBudgetFields =
    Array.isArray((contract as any)?.stepBudgetFields) &&
    (contract as any).stepBudgetFields.length > 0;

  if (hasStepBudgetFields) {
    const verifiedAt = sample?.verifiedAt;
    if (!verifiedAt || String(verifiedAt).trim().length === 0) {
      return BENCHMARK_SUITE_TYPE.EXPLORATORY;
    }
    const parsed = new Date(String(verifiedAt).trim());
    if (isNaN(parsed.getTime())) {
      return BENCHMARK_SUITE_TYPE.EXPLORATORY;
    }
  }

  return BENCHMARK_SUITE_TYPE.VERIFIED;
}

// ── Category Frontier Scoring ─────────────────────────────────────────────────

/**
 * Compute the aggregate frontier score for a given benchmark category
 * across a set of benchmark entries.
 *
 * The frontier score is the highest `frontierScore` value seen for the
 * requested category across all entries with `categoryFrontiers` populated.
 *
 * Returns null when no matching category data is found.
 *
 * @param entries  — benchmark ground truth entries (from benchmark_ground_truth.json)
 * @param category — category name to aggregate (case-insensitive)
 */
export function computeCategoryFrontierScore(
  entries: unknown[],
  category: string,
): { frontierScore: number | null; evaluatedCount: number; bestModel: string | null } {
  if (!Array.isArray(entries) || entries.length === 0 || !category) {
    return { frontierScore: null, evaluatedCount: 0, bestModel: null };
  }

  const targetCategory = String(category).trim().toLowerCase();
  let bestScore = -Infinity;
  let bestModel: string | null = null;
  let evaluatedCount = 0;

  for (const entry of entries) {
    const frontiers = (entry as any)?.categoryFrontiers;
    if (!Array.isArray(frontiers)) continue;
    for (const frontier of frontiers) {
      const cat = String(frontier?.category ?? "").trim().toLowerCase();
      if (cat !== targetCategory) continue;
      const score = typeof frontier?.frontierScore === "number" ? frontier.frontierScore : null;
      if (score === null) continue;
      evaluatedCount++;
      if (score > bestScore) {
        bestScore = score;
        bestModel = String(frontier?.model ?? "").trim() || null;
      }
    }
  }

  return {
    frontierScore: evaluatedCount > 0 ? Math.round(bestScore * 10000) / 10000 : null,
    evaluatedCount,
    bestModel,
  };
}

/**
 * Normalize a raw instance score against the current frontier score for its category.
 *
 * Returns a value in [0, 1]:
 *   - 1.0 means the instance score matches or exceeds the frontier.
 *   - 0.0 means the instance score is zero.
 *   - null returned when frontierScore is null or zero (cannot normalize).
 *
 * @param instanceScore  — raw score for a single benchmark instance (e.g., 0.72)
 * @param frontierScore  — best known score for this category (from computeCategoryFrontierScore)
 */
export function computePerInstanceNormalization(
  instanceScore: number,
  frontierScore: number | null,
): number | null {
  if (frontierScore === null || frontierScore <= 0) return null;
  if (typeof instanceScore !== "number" || !Number.isFinite(instanceScore)) return null;
  return Math.min(1, Math.max(0, Math.round((instanceScore / frontierScore) * 10000) / 10000));
}

// ── Provenance-based request-routing delta ────────────────────────────────────
//
// After CI-closure stabilization a recommendation that has been merged (non-empty
// mergedSha) with CI green (ciClosed === true) should be SKIPPED in subsequent
// planning cycles to avoid redundant re-implementation.
//
// A task that is merely "implemented" without a closed CI signal stays in the
// execute queue — the implementation may still need verification or follow-up.

/** Output of computeProvenanceRoutingDelta. */
export interface ProvenanceRoutingDelta {
  /** Recommendation IDs that should be dispatched for execution (not yet CI-closed). */
  execute: string[];
  /** Recommendation IDs that should be skipped (CI-closed, provenance complete). */
  skip: string[];
  /** Number of recommendations with full provenance (mergedSha + ciClosed). */
  provenanceCompleteCount: number;
  /** Compact human-readable summary for logging. */
  provenanceSummary: string;
}

/**
 * Compute a routing delta from benchmark ground-truth provenance data.
 *
 * Examines the most-recent cycle entry in benchmarkGroundTruth.entries and
 * classifies each recommendation as either "execute" or "skip" based on
 * CI-closure stabilization:
 *
 *   skip condition:  implementationStatus === "implemented" (or "implemented_correctly")
 *                    AND mergedSha is non-empty
 *                    AND ciClosed === true
 *
 * All other recommendations go to the execute queue.
 *
 * Returns empty arrays when no benchmark data is available (fail-open).
 * Never throws.
 *
 * @param benchmarkGroundTruth — parsed benchmark_ground_truth.json content
 */
export function computeProvenanceRoutingDelta(
  benchmarkGroundTruth: any,
): ProvenanceRoutingDelta {
  try {
    const entries = Array.isArray(benchmarkGroundTruth?.entries)
      ? benchmarkGroundTruth.entries
      : [];
    const latest = entries.length > 0 ? entries[0] : null;
    const recs = Array.isArray(latest?.recommendations) ? latest.recommendations : [];

    const execute: string[] = [];
    const skip: string[] = [];

    for (const rec of recs) {
      if (!rec || typeof rec !== "object") continue;
      const id = String((rec as any).id || "").trim();
      if (!id) continue;

      const status = String((rec as any).implementationStatus || "pending").toLowerCase().trim();
      const mergedSha = String((rec as any).mergedSha || "").trim();
      const ciClosed = Boolean((rec as any).ciClosed);

      const isImplemented = status === "implemented" || status === "implemented_correctly";

      if (isImplemented && mergedSha.length > 0 && ciClosed) {
        skip.push(id);
      } else {
        execute.push(id);
      }
    }

    const provenanceCompleteCount = skip.length;
    const provenanceSummary =
      `execute=${execute.length} skip=${skip.length} provenance-complete=${provenanceCompleteCount}`;

    return { execute, skip, provenanceCompleteCount, provenanceSummary };
  } catch {
    return { execute: [], skip: [], provenanceCompleteCount: 0, provenanceSummary: "error" };
  }
}

/**
 * Normalize a policy intervention uplift signal from compiled learning metadata.
 * Returns null when no measurable uplift score is present.
 */
export function normalizePolicyInterventionUplift(policy: unknown): number | null {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const raw = Number((policy as Record<string, any>)?.impactAttribution?.baselineQualityScore);
  if (!Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(10, Math.round(raw * 100) / 100));
}

