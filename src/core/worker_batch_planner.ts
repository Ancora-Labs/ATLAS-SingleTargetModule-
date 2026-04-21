import {
  buildWorkerTopologyContract,
  getRoleRegistry,
  getLaneForWorkerName,
  selectExecutionPatternForPlans,
  SPECIALIST_LANE_RESERVATION_ORDER,
} from "./role_registry.js";
import { enforceModelPolicy } from "./model_policy.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveDependencyGraph, GRAPH_STATUS } from "./dependency_graph_resolver.js";
import {
  enforceLaneDiversity,
  selectWorkerByFitScore,
  LanePerformanceLedger,
  buildLanePerformanceFromCycleTelemetry,
  buildLaneTelemetrySignals,
  computeSpecialistFitThreshold,
  getLaneScore,
  computeAdaptiveSpecialistFillThreshold,
  computeAdaptiveSpecializedShareTarget,
  SpecialistRerouteReason,
  SPECIALIST_REROUTE_REASON_CODE,
  buildReroutePenaltyLedger,
  ReroutePenaltyLedger,
} from "./capability_pool.js";
import { compactSingletonWaves, computeWaveParallelismBound } from "./dag_scheduler.js";
import { rankModelsByTaskKindExpectedValue } from "./model_policy.js";
import {
  buildThinPacketRejectionReason,
  computePacketDensityMetrics,
  isThinPacketForAdmission,
  MAX_ACTIONABLE_STEPS_PER_PACKET,
  PACKET_OVERSIZE_REASON,
  resolvePacketSizePolicy,
} from "./plan_contract_validator.js";

const CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 100000;
const DEFAULT_CONTEXT_RESERVE_TOKENS = 12000;
const FRAGILE_TASK_KIND_PACKET_CAPS = Object.freeze({
  test: 3,
  rework: 2,
  "ci-fix": 2,
  qa: 3,
});
const MODERATE_TASK_KIND_PACKET_CAPS = Object.freeze({
  bugfix: 4,
  refactor: 4,
  governance: 3,
});

/**
 * Default minimum context-fill ratio (0–1) for a specialist worker to keep its
 * own batch.  Below this threshold, the specialist's plans are rerouted to
 * evolution-worker and co-packed with other evo-worker tasks.
 *
 * Configurable via config.planner.specialistFillThreshold (default: 1.0 = 100%).
 */
export const DEFAULT_SPECIALIST_FILL_THRESHOLD = 1.0;

/** Roles that are always dispatched as-is (never rerouted by specialist threshold). */
const SPECIALIST_EXEMPT_ROLES = new Set(["evolution-worker"]);

/**
 * Resolve the specialist fill threshold from config.
 * Returns a number in [0, 1]. Values outside range are clamped.
 */
function resolveSpecialistFillThreshold(config: any): number {
  const raw = Number(config?.planner?.specialistFillThreshold);
  if (!Number.isFinite(raw)) return DEFAULT_SPECIALIST_FILL_THRESHOLD;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Maximum number of plans per batch when any plan in the batch carries explicit
 * dependency declarations (dependsOn / dependencies fields).  Dependency-linked
 * plans must be kept small so a worker can reason about the full dependency chain
 * without hitting context limits or missing inter-plan ordering constraints.
 *
 * Configurable via config.runtime.maxPlansPerDependencyBatch (default: 6).
 */
export const MAX_PLANS_PER_DEPENDENCY_BATCH = 6;
const SPLIT_CONFLICTING_PLANS_DEFAULT = false;
const KNOWN_MODEL_CONTEXT_WINDOWS = [
  { pattern: /gpt\s*[- ]?5\.[123]\s*[- ]?codex/i, tokens: 400000 },
  { pattern: /claude\s+sonnet\s+4\.6/i, tokens: 160000 },
  { pattern: /claude\s+sonnet/i, tokens: 160000 },
];

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeDependencyBatchLimit(value, fallback = MAX_PLANS_PER_DEPENDENCY_BATCH) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

function shouldSplitConflictingPlansAcrossBatches(config: any): boolean {
  const configured = (config as any)?.planner?.splitConflictingPlansAcrossBatches;
  if (configured === undefined || configured === null) return SPLIT_CONFLICTING_PLANS_DEFAULT;
  return configured === true;
}

function hasExplicitDependencies(plan) {
  return (
    (Array.isArray(plan?.dependsOn) && plan.dependsOn.length > 0)
    || (Array.isArray(plan?.dependencies) && plan.dependencies.length > 0)
  );
}

function resolveBatchPlanningUncertainty(plans = []): string {
  const normalized = new Set(
    (Array.isArray(plans) ? plans : [])
      .map((plan) => String(plan?.planningUncertainty || plan?.uncertainty || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (normalized.has("high")) return "high";
  if (normalized.has("medium")) return "medium";
  return "low";
}

function slugify(text) {
  return String(text || "worker")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "worker";
}

function aggregateTaskHints(plans = []) {
  const complexities = plans.map((plan) => String(plan?.riskLevel || plan?.complexity || "").toLowerCase());
  const hasCritical = complexities.some((value) => value === "critical");
  const hasHigh = complexities.some((value) => value === "high");

  return {
    estimatedLines: Math.ceil(estimateBatchTokens(plans) * 2.5),
    estimatedDurationMinutes: computeBatchEstimatedDurationMinutes(plans),
    complexity: hasCritical ? "critical" : hasHigh ? "high" : "medium"
  };
}

function getRegisteredWorkerModel(config, roleName) {
  const registry = getRoleRegistry(config);
  const workers = registry?.workers || {};
  for (const worker of Object.values(workers) as Array<{ name?: string; model?: string }>) {
    if (worker?.name === roleName && worker?.model) return worker.model;
  }
  return null;
}

function collectCandidateModels(config, roleName, taskKind, taskHints) {
  const requestedModels = [
    ...(Array.isArray(config?.copilot?.preferredModelsByTaskKind?.[taskKind])
      ? config.copilot.preferredModelsByTaskKind[taskKind]
      : []),
    ...(Array.isArray(config?.copilot?.preferredModelsByRole?.[roleName])
      ? config.copilot.preferredModelsByRole[roleName]
      : []),
    getRegisteredWorkerModel(config, roleName),
    config?.copilot?.defaultModel || "Claude Sonnet 4.6"
  ].filter(Boolean);

  const fallbackModel = config?.copilot?.defaultModel || "Claude Sonnet 4.6";
  const seen = new Set();
  const resolved = [];

  for (const requestedModel of requestedModels) {
    const policy = enforceModelPolicy(requestedModel, taskHints, fallbackModel);
    const model = String(policy.model || fallbackModel).trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    resolved.push(model);
  }

  if (resolved.length === 0) resolved.push(fallbackModel);
  return resolved;
}

function loadCycleAnalyticsTelemetry(config: any): any | null {
  const stateDir = String(config?.paths?.stateDir || "state");
  const analyticsPath = path.join(stateDir, "cycle_analytics.json");
  if (!existsSync(analyticsPath)) return null;
  try {
    return JSON.parse(readFileSync(analyticsPath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeTaskKindKey(taskKind: unknown): string {
  return String(taskKind || "implementation")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-") || "implementation";
}

export function extractTaskKindPacketTelemetry(cycleAnalytics: any): Record<string, {
  successRate: number | null;
  sampleCount: number;
  averageBatchSize: number | null;
  averageOrderedStepCount: number | null;
  averageContextUtilizationPercent: number | null;
}> {
  const resolved: Record<string, {
    successRate: number | null;
    sampleCount: number;
    averageBatchSize: number | null;
    averageOrderedStepCount: number | null;
    averageContextUtilizationPercent: number | null;
  }> = {};

  const packetCorrelation = cycleAnalytics?.lastCycle?.packetOutcomeCorrelation?.byTaskKind
    ?? cycleAnalytics?.packetOutcomeCorrelation?.byTaskKind;
  if (packetCorrelation && typeof packetCorrelation === "object") {
    for (const [taskKind, value] of Object.entries(packetCorrelation as Record<string, any>)) {
      const normalizedTaskKind = normalizeTaskKindKey(taskKind);
      const sampleCount = Number((value as any)?.sampleCount ?? 0);
      resolved[normalizedTaskKind] = {
        successRate: Number.isFinite(Number((value as any)?.successRate))
          ? Math.max(0, Math.min(1, Number((value as any)?.successRate)))
          : null,
        sampleCount: Number.isFinite(sampleCount) && sampleCount > 0 ? Math.floor(sampleCount) : 0,
        averageBatchSize: Number.isFinite(Number((value as any)?.averageBatchSize))
          ? Number((value as any)?.averageBatchSize)
          : null,
        averageOrderedStepCount: Number.isFinite(Number((value as any)?.averageOrderedStepCount))
          ? Number((value as any)?.averageOrderedStepCount)
          : null,
        averageContextUtilizationPercent: Number.isFinite(Number((value as any)?.averageContextUtilizationPercent))
          ? Number((value as any)?.averageContextUtilizationPercent)
          : null,
      };
    }
    return resolved;
  }

  const routingTelemetry = cycleAnalytics?.lastCycle?.modelRoutingTelemetry?.byTaskKind
    ?? cycleAnalytics?.modelRoutingTelemetry?.byTaskKind;
  if (!routingTelemetry || typeof routingTelemetry !== "object") {
    return resolved;
  }
  for (const [taskKind, value] of Object.entries(routingTelemetry as Record<string, any>)) {
    const normalizedTaskKind = normalizeTaskKindKey(taskKind);
    const sampleCount = Number((value as any)?.sampleCount ?? 0);
    const defaultPoint = (value as any)?.default;
    resolved[normalizedTaskKind] = {
      successRate: Number.isFinite(Number(defaultPoint?.successProbability))
        ? Math.max(0, Math.min(1, Number(defaultPoint.successProbability)))
        : null,
      sampleCount: Number.isFinite(sampleCount) && sampleCount > 0 ? Math.floor(sampleCount) : 0,
      averageBatchSize: null,
      averageOrderedStepCount: null,
      averageContextUtilizationPercent: null,
    };
  }
  return resolved;
}

export function resolveAdaptivePacketPlanLimit({
  taskKinds = [],
  baseCap = 5,
  uncertainty = null,
  taskKindTelemetry = null,
}: {
  taskKinds?: unknown[];
  baseCap?: number;
  uncertainty?: string | null;
  taskKindTelemetry?: Record<string, {
    successRate: number | null;
    sampleCount: number;
    averageBatchSize: number | null;
    averageOrderedStepCount: number | null;
    averageContextUtilizationPercent: number | null;
  }> | null;
} = {}): { maxPlansPerPacket: number; reasonCodes: string[] } {
  const hardCap = Math.max(1, Math.min(20, Math.floor(Number.isFinite(baseCap) ? baseCap : 5)));
  const normalizedTaskKinds = [...new Set(
    (Array.isArray(taskKinds) ? taskKinds : [taskKinds])
      .map(normalizeTaskKindKey)
      .filter(Boolean)
  )];
  const reasons = new Set<string>();
  let adaptiveCap = hardCap;

  for (const taskKind of normalizedTaskKinds) {
    if (Object.prototype.hasOwnProperty.call(FRAGILE_TASK_KIND_PACKET_CAPS, taskKind)) {
      adaptiveCap = Math.min(adaptiveCap, FRAGILE_TASK_KIND_PACKET_CAPS[taskKind as keyof typeof FRAGILE_TASK_KIND_PACKET_CAPS]);
      reasons.add(`fragile-kind:${taskKind}`);
    } else if (Object.prototype.hasOwnProperty.call(MODERATE_TASK_KIND_PACKET_CAPS, taskKind)) {
      adaptiveCap = Math.min(adaptiveCap, MODERATE_TASK_KIND_PACKET_CAPS[taskKind as keyof typeof MODERATE_TASK_KIND_PACKET_CAPS]);
      reasons.add(`moderate-kind:${taskKind}`);
    }

    const telemetry = taskKindTelemetry && typeof taskKindTelemetry === "object"
      ? taskKindTelemetry[taskKind]
      : null;
    const successRate = Number(telemetry?.successRate);
    const sampleCount = Number(telemetry?.sampleCount ?? 0);
    if (Number.isFinite(successRate) && sampleCount >= 2) {
      if (successRate < 0.45) {
        adaptiveCap = Math.min(adaptiveCap, 2);
        reasons.add(`low-success:${taskKind}`);
      } else if (successRate < 0.70) {
        adaptiveCap = Math.min(adaptiveCap, 3);
        reasons.add(`medium-success:${taskKind}`);
      }
    }
    const avgOrderedSteps = Number(telemetry?.averageOrderedStepCount ?? 0);
    if (Number.isFinite(avgOrderedSteps) && avgOrderedSteps >= 9) {
      adaptiveCap = Math.min(adaptiveCap, Math.max(1, hardCap - 1));
      reasons.add(`high-step-density:${taskKind}`);
    }
  }

  const normalizedUncertainty = String(uncertainty || "").trim().toLowerCase();
  if (normalizedUncertainty === "high") {
    adaptiveCap = Math.max(1, Math.min(adaptiveCap, hardCap - 1));
    reasons.add("planning-uncertainty:high");
  } else if (normalizedUncertainty === "medium") {
    adaptiveCap = Math.max(1, Math.min(adaptiveCap, hardCap));
    if (normalizedTaskKinds.length > 0) {
      reasons.add("planning-uncertainty:medium");
    }
  }

  return {
    maxPlansPerPacket: Math.max(1, Math.min(hardCap, adaptiveCap)),
    reasonCodes: [...reasons],
  };
}

/**
 * Load the last N reroute history records from reroute_history.jsonl.
 * Used by buildTokenFirstBatches to build a per-lane penalty ledger so
 * specialists with repeated reroutes face a raised fill threshold.
 *
 * @param config  — BOX config (reads config.paths.stateDir)
 * @param limit   — maximum number of records to read from the tail of the file
 * @returns array of raw reroute records (lane + reasonCode fields expected)
 */
function loadRerouteHistory(config: any, limit = 30): Array<{ lane?: string; reasonCode?: string }> {
  const stateDir = String(config?.paths?.stateDir || "state");
  const historyPath = path.join(stateDir, "reroute_history.jsonl");
  if (!existsSync(historyPath)) return [];
  try {
    const raw = readFileSync(historyPath, "utf8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    return lines.slice(-limit).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean) as Array<{ lane?: string; reasonCode?: string }>;
  } catch {
    return [];
  }
}

function resolveSpecialistFitThreshold(config: any): number {
  const raw = Number(config?.workerPool?.specializationTargets?.fitScoreThreshold);
  if (!Number.isFinite(raw)) return 0.65;
  return Math.max(0, Math.min(1, raw));
}

function resolveConfiguredContextWindow(config, modelName) {
  const configured = config?.copilot?.modelContextWindows;
  if (!configured || typeof configured !== "object") return null;

  if (configured[modelName] != null) {
    return normalizePositiveNumber(configured[modelName], null);
  }

  const target = String(modelName || "").toLowerCase();
  for (const [name, value] of Object.entries(configured)) {
    if (String(name).toLowerCase() === target) {
      return normalizePositiveNumber(value, null);
    }
  }

  return null;
}

export function getModelContextWindowTokens(config, modelName) {
  const configured = resolveConfiguredContextWindow(config, modelName);
  if (configured) return configured;

  const model = String(modelName || "");
  for (const entry of KNOWN_MODEL_CONTEXT_WINDOWS) {
    if (entry.pattern.test(model)) return entry.tokens;
  }

  return normalizePositiveNumber(config?.runtime?.workerContextTokenLimit, DEFAULT_CONTEXT_WINDOW_TOKENS);
}

export function getUsableModelContextTokens(config, modelName) {
  const windowTokens = getModelContextWindowTokens(config, modelName);
  const reserveTokens = normalizeNonNegativeNumber(
    config?.copilot?.modelContextReserveTokens,
    DEFAULT_CONTEXT_RESERVE_TOKENS
  );
  return Math.max(1, windowTokens - reserveTokens);
}

export function estimatePlanTokens(plan, calibrationCoefficient?: number, config?: unknown) {
  const payload = [
    plan?.task,
    plan?.context,
    plan?.scope,
    plan?.verification,
    plan?.before_state,
    plan?.after_state,
    plan?.beforeState,
    plan?.afterState,
    plan?.description,
    plan?.premortem ? JSON.stringify(plan.premortem) : "",
    Array.isArray(plan?.target_files) ? plan.target_files.join("\n") : "",
    Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria.join("\n") : "",
    JSON.stringify(Array.isArray(plan?.dependencies) ? plan.dependencies : []),
  ].filter(Boolean).join("\n");

  // Base: payload text / 4 chars per token + per-plan overhead (prompt framing, formatting)
  const payloadTokens = Math.ceil(payload.length / CHARS_PER_TOKEN);
  // Estimate worker reasoning overhead: more complex tasks need more reasoning tokens
  const fileCount = Array.isArray(plan?.target_files) ? plan.target_files.length : 0;
  const riskMultiplier = String(plan?.riskLevel || "").toLowerCase() === "high" ? 1.5
    : String(plan?.riskLevel || "").toLowerCase() === "medium" ? 1.2
    : 1.0;
  const baseOverhead = 300;
  const fileReadOverhead = fileCount * 150; // estimated tokens per file the worker will read
  const reasoningOverhead = Math.ceil(payloadTokens * 0.3 * riskMultiplier); // model reasoning space
  const heuristicEstimate = Math.max(1, payloadTokens + baseOverhead + fileReadOverhead + reasoningOverhead);

  // Apply calibration coefficient if provided (from token_calibration EWMA).
  // coefficient > 1 means we historically underestimate → inflate.
  // coefficient < 1 means we historically overestimate → deflate.
  const coeff = Number.isFinite(calibrationCoefficient) && (calibrationCoefficient as number) > 0
    ? calibrationCoefficient as number
    : 1.0;
  const calibrated = Math.max(1, Math.round(heuristicEstimate * coeff));

  // Apply bounded token floor from packet-size policy to prevent under-estimation
  // on multi-file plans (5+ target files must have at minimum 8k tokens).
  // Single-file/no-file plans only get the minTokensPerPlan floor if they have
  // target_files declared (i.e., they are explicitly scoped plans, not bare tasks).
  const policy = resolvePacketSizePolicy(config);
  if (fileCount >= policy.multiFileThreshold) {
    return Math.max(calibrated, policy.minTokensForMultiFile);
  }
  // Only apply single-plan floor when the plan explicitly declares target files,
  // to avoid suppressing calibration differentials on bare task estimates.
  if (fileCount > 0 && calibrated < policy.minTokensPerPlan) {
    return policy.minTokensPerPlan;
  }
  return calibrated;
}

/**
 * Estimate the total token budget a plan will consume during worker execution,
 * including prompt framing, file reads, and model reasoning. Used by the batch
 * planner to pack tasks into model context windows.
 */
export function estimatePlanExecutionTokens(plan) {
  return estimatePlanTokens(plan);
}

export function estimateBatchTokens(plans = []) {
  return plans.reduce((sum, plan) => sum + estimatePlanTokens(plan), 0);
}

/**
 * Count total ordered steps across all plans in a batch.
 *
 * An "ordered step" is a single actionable item from `plan.orderedSteps` or
 * `plan.acceptanceCriteria`. Each plan also counts as at minimum 1 step.
 * This metric drives the anti-overbundle admission policy in the intervention
 * optimizer: batches exceeding OVERBUNDLE_STEPS_THRESHOLD get an EV penalty.
 *
 * @param plans — array of plan objects
 * @returns total ordered step count (>= plans.length when plans is non-empty)
 */
export function computeBatchOrderedStepCount(plans: any[] = []): number {
  if (!Array.isArray(plans) || plans.length === 0) return 0;
  let total = 0;
  for (const plan of plans) {
    const steps = Array.isArray(plan?.orderedSteps) ? plan.orderedSteps.length
      : Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria.length
      : 1;
    total += Math.max(1, steps);
  }
  return total;
}

export function computePlanEstimatedDurationMinutes(plan: any): number {
  const explicit = Number(plan?.estimatedDurationMinutes);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(5, Math.ceil(explicit));
  }

  const tokenEstimate = Number(plan?.estimatedExecutionTokens);
  const orderedSteps = Array.isArray(plan?.orderedSteps)
    ? plan.orderedSteps.length
    : Array.isArray(plan?.acceptance_criteria)
      ? plan.acceptance_criteria.length
      : 1;
  const fileCount = Array.isArray(plan?.target_files)
    ? plan.target_files.filter(Boolean).length
    : Array.isArray(plan?.filesInScope)
      ? plan.filesInScope.filter(Boolean).length
      : 0;
  const riskLevel = String(plan?.riskLevel || plan?.complexity || "").toLowerCase();
  const riskFloor = riskLevel === "critical"
    ? 45
    : riskLevel === "high"
      ? 35
      : riskLevel === "medium"
        ? 25
        : 15;
  const tokenMinutes = Number.isFinite(tokenEstimate) && tokenEstimate > 0
    ? Math.ceil(tokenEstimate / 4000) * 10
    : 0;
  const stepMinutes = Math.max(1, orderedSteps) * 8;
  const fileMinutes = Math.max(0, fileCount) * 5;
  return Math.max(10, riskFloor, tokenMinutes, stepMinutes + fileMinutes);
}

export function computeBatchEstimatedDurationMinutes(plans: any[] = []): number {
  if (!Array.isArray(plans) || plans.length === 0) return 0;
  return plans.reduce((sum, plan) => sum + computePlanEstimatedDurationMinutes(plan), 0);
}



export function packPlansIntoContextBatches(plans = [], usableTokens) {
  if (!Array.isArray(plans) || plans.length === 0) return [];

  const maxTokens = Math.max(1, normalizePositiveNumber(usableTokens, 1));
  const batches = [];
  let currentPlans = [];
  let currentTokens = 0;

  for (const plan of plans) {
    const planTokens = estimatePlanTokens(plan);
    const shouldSplit = currentPlans.length > 0 && currentTokens + planTokens > maxTokens;

    if (shouldSplit) {
      batches.push({ plans: currentPlans, estimatedTokens: currentTokens });
      currentPlans = [plan];
      currentTokens = planTokens;
      continue;
    }

    currentPlans.push(plan);
    currentTokens += planTokens;
  }

  if (currentPlans.length > 0) {
    batches.push({ plans: currentPlans, estimatedTokens: currentTokens });
  }

  return batches;
}

/**
 * Nucleus/Frontier classification result.
 * - nucleus: plans with critical-path score > 0 (they have downstream dependents that must be
 *   unblocked promptly; dispatching them first minimises downstream idle time).
 * - frontier: plans with critical-path score = 0 (leaf tasks — no other work depends on them;
 *   they can be packed aggressively to maximise context utilisation and reduce request count).
 */
export interface NucleusFrontierClassification {
  nucleus: any[];
  frontier: any[];
}

/**
 * Classify plans into nucleus (critical-path blockers) and frontier (dependency-ready leaves).
 *
 * Plans whose critical-path score > 0 are assigned to the nucleus — they have downstream
 * work waiting and must be dispatched first. Plans with score 0 are assigned to the frontier —
 * they can safely be co-batched with nucleus tasks to fill context window space, reducing
 * the total number of API requests without compromising dependency safety.
 *
 * @param plans              - plan objects (must be the same objects passed to computeCriticalPathScores)
 * @param criticalPathScores - map from plan id to downstream depth score
 * @returns classification with nucleus and frontier arrays (original order preserved within each)
 */
export function classifyNucleusFrontier(
  plans: any[],
  criticalPathScores: Map<string, number>
): NucleusFrontierClassification {
  if (!Array.isArray(plans) || plans.length === 0) return { nucleus: [], frontier: [] };

  const nucleus: any[] = [];
  const frontier: any[] = [];

  for (const plan of plans) {
    const id = String(plan?.task_id || plan?.task || plan?.role || "");
    const score = criticalPathScores.get(id) ?? 0;
    if (score > 0) {
      nucleus.push(plan);
    } else {
      frontier.push(plan);
    }
  }

  return { nucleus, frontier };
}

/**
 * Pack plans into context batches using the nucleus/frontier model.
 *
 * Strategy (reduces API request count vs naive sequential packing):
 *  1. Classify plans into nucleus (score > 0) and frontier (score = 0).
 *  2. Pack nucleus tasks into batches first — their ordering matters.
 *  3. Greedily absorb frontier tasks into each nucleus batch, filling the
 *     remaining context window space. Frontier tasks have no downstream
 *     dependents, so co-batching them with nucleus work is dependency-safe.
 *  4. Any frontier tasks that did not fit into nucleus batches are packed
 *     into additional frontier-only batches appended at the end.
 *
 * When no nucleus tasks exist (all plans are frontier), falls back to
 * standard packPlansIntoContextBatches.
 *
 * @param plans              - plan objects for one wave/sub-group
 * @param criticalPathScores - scores from computeCriticalPathScores
 * @param usableTokens       - usable context window size in tokens
 * @returns array of { plans, estimatedTokens } — same shape as packPlansIntoContextBatches
 */
export function packNucleusFrontierBatches(
  plans: any[],
  criticalPathScores: Map<string, number>,
  usableTokens: number
): Array<{ plans: unknown[]; estimatedTokens: number }> {
  if (!Array.isArray(plans) || plans.length === 0) return [];

  const maxTokens = Math.max(1, normalizePositiveNumber(usableTokens, 1));
  const { nucleus, frontier } = classifyNucleusFrontier(plans, criticalPathScores);

  if (nucleus.length === 0) {
    // All plans are frontier tasks (no critical-path blockers) — standard packing suffices.
    return packPlansIntoContextBatches(plans, maxTokens);
  }

  // Pack nucleus tasks into ordered batches.
  const nucleusBatches = packPlansIntoContextBatches(nucleus, maxTokens);

  // Greedily fill each nucleus batch with frontier tasks that fit within the context window.
  let remainingFrontier = [...frontier];
  for (const batch of nucleusBatches) {
    if (remainingFrontier.length === 0) break;
    const batchPlans = batch.plans as any[];
    const absorbed: any[] = [];
    for (const fp of remainingFrontier) {
      const proposed = [...batchPlans, ...absorbed, fp];
      if (estimateBatchTokens(proposed) <= maxTokens) {
        absorbed.push(fp);
      }
    }
    if (absorbed.length > 0) {
      batch.plans = [...batchPlans, ...absorbed];
      batch.estimatedTokens = estimateBatchTokens(batch.plans as any[]);
      const absorbedSet = new Set(absorbed);
      remainingFrontier = remainingFrontier.filter(p => !absorbedSet.has(p));
    }
  }

  // Pack any frontier tasks that could not be absorbed into nucleus batches.
  if (remainingFrontier.length > 0) {
    const frontierBatches = packPlansIntoContextBatches(remainingFrontier, maxTokens);
    return [...nucleusBatches, ...frontierBatches];
  }

  return nucleusBatches;
}

function chooseModelForRolePlans(config, roleName, plans, taskKind) {
  const taskHints = aggregateTaskHints(plans);
  const candidates = collectCandidateModels(config, roleName, taskKind, taskHints);
  const analytics = loadCycleAnalyticsTelemetry(config);
  const ranking = rankModelsByTaskKindExpectedValue(taskKind, candidates, analytics, {
    taskHints,
    history: {},
    signals: {},
  });
  const rankedCandidates = ranking.rankedModels.length > 0 ? ranking.rankedModels : candidates;
  let best = null;

  for (let index = 0; index < rankedCandidates.length; index += 1) {
    const model = rankedCandidates[index];
    const contextWindowTokens = getModelContextWindowTokens(config, model);
    const usableContextTokens = getUsableModelContextTokens(config, model);
    const batches = packPlansIntoContextBatches(plans, usableContextTokens);

    const score = {
      batchCount: batches.length,
      preferenceIndex: index,
      contextWindowTokens,
    };

    if (!best
      || score.batchCount < best.score.batchCount
      || (score.batchCount === best.score.batchCount && score.preferenceIndex < best.score.preferenceIndex)
      || (score.batchCount === best.score.batchCount
        && score.preferenceIndex === best.score.preferenceIndex
        && score.contextWindowTokens > best.score.contextWindowTokens)) {
      best = {
        model,
        contextWindowTokens,
        usableContextTokens,
        batches,
        score,
        economicsRouting: {
          usedTelemetry: ranking.usedTelemetry,
          reason: ranking.reason,
          expectedValue: ranking.scoreByModel[model] ?? null,
        },
      };
    }
  }

  return best;
}

function buildSharedBranchName(roleName, plans) {
  const roleSlug = slugify(roleName);
  const firstTask = slugify(plans?.[0]?.task || plans?.[0]?.title || "batch").slice(0, 24);
  return `box/${roleSlug}-${firstTask || "batch"}`;
}

/**
 * Auto-bundle thin, related packets into denser packets before dispatch admission.
 *
 * Relatedness heuristic:
 *   - same role
 *   - same wave
 *   - at least one overlapping target file
 *
 * Packets that are thin after this pass are expected to be rejected by the
 * plan contract admission gate with explicit violation reasons.
 */
export function autoBundleThinRelatedPackets(
  plans: any[],
  opts: {
    minTargetFiles?: number;
    minAcceptanceCriteria?: number;
    minTaskChars?: number;
    minExecutionTokens?: number;
  } = {}
): { plans: any[]; bundledCount: number } {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { plans: [], bundledCount: 0 };
  }
  const minTargetFiles = Number(opts.minTargetFiles ?? 2);
  const minAcceptanceCriteria = Number(opts.minAcceptanceCriteria ?? 2);
  const minTaskChars = Number(opts.minTaskChars ?? 120);
  const minExecutionTokens = Number(opts.minExecutionTokens ?? 8000);

  const densityThresholds = {
    minTargetFiles,
    minAcceptanceCriteria,
    minTaskChars,
    minExecutionTokens,
  };
  const isThin = (plan: any): boolean => (
    isThinPacketForAdmission(computePacketDensityMetrics(plan), densityThresholds)
  );

  const normalizedTargetFiles = (plan: any): string[] => (
    Array.isArray(plan?.target_files) ? plan.target_files : []
  ).map((f: any) => String(f || "").trim()).filter(Boolean);
  const overlapsTargets = (a: any, b: any): boolean => {
    const fa = normalizedTargetFiles(a);
    const fb = normalizedTargetFiles(b);
    if (fa.length === 0 || fb.length === 0) return false;
    const bSet = new Set(fb.map((f) => f.toLowerCase()));
    return fa.some((f) => bSet.has(f.toLowerCase()));
  };
  const sameRoleWave = (a: any, b: any): boolean => (
    String(a?.role || "") === String(b?.role || "")
    && Number(a?.wave || 1) === Number(b?.wave || 1)
  );

  const consumed = new Set<number>();
  const out: any[] = [];
  let bundledCount = 0;

  for (let i = 0; i < plans.length; i += 1) {
    if (consumed.has(i)) continue;
    const base = plans[i];
    if (!isThin(base)) {
      out.push(base);
      consumed.add(i);
      continue;
    }
    const bundleIdx = [i];
    for (let j = i + 1; j < plans.length; j += 1) {
      if (consumed.has(j)) continue;
      const candidate = plans[j];
      if (!isThin(candidate)) continue;
      if (!sameRoleWave(base, candidate)) continue;
      if (!overlapsTargets(base, candidate)) continue;
      bundleIdx.push(j);
      consumed.add(j);
    }
    if (bundleIdx.length === 1) {
      out.push(base);
      consumed.add(i);
      continue;
    }
    const bundlePlans = bundleIdx.map((idx) => plans[idx]);
    const mergedTargetFiles = [...new Set(bundlePlans.flatMap((p) => Array.isArray(p?.target_files) ? p.target_files : []))];
    const mergedAcceptance = [...new Set(bundlePlans.flatMap((p) => Array.isArray(p?.acceptance_criteria) ? p.acceptance_criteria : []))];
    const mergedVerificationCommands = [...new Set(bundlePlans.flatMap((p) => Array.isArray(p?.verification_commands) ? p.verification_commands : []))];
    const mergedTask = bundlePlans.map((p, idx) => `${idx + 1}. ${String(p?.task || p?.title || "").trim()}`).join("\n");
    const merged = {
      ...base,
      task: `Bundled thin packet:\n${mergedTask}`,
      target_files: mergedTargetFiles,
      acceptance_criteria: mergedAcceptance,
      verification_commands: mergedVerificationCommands,
      estimatedExecutionTokens: bundlePlans.reduce((sum, p) => sum + Number(p?.estimatedExecutionTokens || 0), 0),
      _autoBundledThinPacket: true,
      _autoBundledFromCount: bundlePlans.length,
    };
    const mergedMetrics = computePacketDensityMetrics(merged);
    if (isThinPacketForAdmission(mergedMetrics, densityThresholds)) {
      merged._thinPacketRejected = true;
      merged._thinPacketReason = buildThinPacketRejectionReason(mergedMetrics, densityThresholds);
    }
    out.push(merged);
    consumed.add(i);
    bundledCount += 1;
  }

  return { plans: out, bundledCount };
}

/**
 * Split an oversized array of plans into chunks of at most `maxSteps` plans
 * each, preserving `dependsOn` chains so dependency ordering is maintained
 * across sub-packets.
 *
 * The split is deterministic:
 *   1. Plans with a `dependsOn` referencing another plan in the same set are
 *      placed in later chunks (after the plan they depend on).
 *   2. Plans with no dependencies fill earlier chunks first.
 *   3. Each chunk's `dependsOn` field is left intact so downstream dispatch
 *      scheduling can still enforce ordering.
 *
 * @param plans      — array of plan objects (any shape, must have optional .dependsOn)
 * @param maxSteps   — max plans per chunk (default MAX_ACTIONABLE_STEPS_PER_PACKET = 3)
 * @returns array of plan-array chunks; each chunk has at most maxSteps entries
 */
export function autosplitOversizedPacket(
  plans: any[],
  maxSteps: number = MAX_ACTIONABLE_STEPS_PER_PACKET,
): any[][] {
  if (!Array.isArray(plans) || plans.length === 0) return [];
  const cap = Math.max(1, Math.floor(maxSteps));
  if (plans.length <= cap) return [plans];

  // Topological sort: plans with declared dependsOn come after their dependencies.
  // Build a dependency id set for each plan (normalized to lowercase strings).
  const getId = (plan: any): string =>
    String(plan?.task_id || plan?.id || plan?.title || plan?.task || "").trim().toLowerCase();

  const idIndex = new Map<string, number>();
  plans.forEach((p, i) => {
    const id = getId(p);
    if (id) idIndex.set(id, i);
  });

  const getDeps = (plan: any): string[] => {
    const raw = plan?.dependsOn ?? plan?.dependencies;
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.map((d: any) => String(d || "").trim().toLowerCase()).filter(Boolean);
  };

  // Kahn's algorithm to get a dependency-respecting order
  const inDegree = new Array(plans.length).fill(0);
  const adj: number[][] = plans.map(() => []);
  for (let i = 0; i < plans.length; i++) {
    for (const dep of getDeps(plans[i])) {
      const j = idIndex.get(dep);
      if (j !== undefined && j !== i) {
        adj[j].push(i); // j must come before i
        inDegree[i]++;
      }
    }
  }
  const queue: number[] = [];
  for (let i = 0; i < plans.length; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }
  const sorted: any[] = [];
  while (queue.length > 0) {
    const idx = queue.shift()!;
    sorted.push(plans[idx]);
    for (const next of adj[idx]) {
      inDegree[next]--;
      if (inDegree[next] === 0) queue.push(next);
    }
  }
  // Any unresolved nodes (cycles) appended in original order
  if (sorted.length < plans.length) {
    const sortedIndices = new Set(sorted.map((p) => plans.indexOf(p)));
    for (let i = 0; i < plans.length; i++) {
      if (!sortedIndices.has(i)) sorted.push(plans[i]);
    }
  }

  // Slice into chunks of `cap`
  const chunks: any[][] = [];
  for (let i = 0; i < sorted.length; i += cap) {
    chunks.push(sorted.slice(i, i + cap));
  }
  return chunks;
}

/**
 * Validate that a plans array does not exceed the actionable-steps cap.
 * Returns the violation reason string if oversized, or null if compliant.
 *
 * @param plans     — array of plan objects
 * @param maxSteps  — cap (default MAX_ACTIONABLE_STEPS_PER_PACKET)
 * @returns violation reason string or null
 */
export function checkPacketSizeCap(plans: any[], maxSteps: number = MAX_ACTIONABLE_STEPS_PER_PACKET): string | null {
  if (!Array.isArray(plans)) return null;
  if (plans.length > maxSteps) {
    return `${PACKET_OVERSIZE_REASON}: ${plans.length} plans exceeds cap of ${maxSteps}`;
  }
  return null;
}

function hasConflictFiles(plan: any, existing: any): boolean {
  const filesA = Array.isArray(plan?.filesInScope)
    ? plan.filesInScope
    : Array.isArray(plan?.target_files)
      ? plan.target_files
      : Array.isArray(plan?.targetFiles)
        ? plan.targetFiles
        : [];
  const filesB = Array.isArray(existing?.filesInScope)
    ? existing.filesInScope
    : Array.isArray(existing?.target_files)
      ? existing.target_files
      : Array.isArray(existing?.targetFiles)
        ? existing.targetFiles
        : [];
  if (filesA.length === 0 || filesB.length === 0) return false;
  const normalize = (v: any) => String(v || "").trim().toLowerCase();
  const bSet = new Set(filesB.map(normalize).filter(Boolean));
  return filesA.map(normalize).some((file) => bSet.has(file));
}

/**
 * Default maximum number of tasks per micro-wave when splitting large waves.
 * Keeps each dependency layer small so workers can reason without context overload.
 * Configurable via config.planner.maxTasksPerMicrowave.
 */
export const MICROWAVE_MAX_TASKS_DEFAULT = 3;

/**
 * Deterministically split plans into micro-waves of at most maxTasksPerWave tasks
 * per dependency layer, with critical-path ordering within each split wave.
 *
 * Algorithm:
 *  1. Group plans by their wave number.
 *  2. For each wave group larger than maxTasksPerWave, sort by intra-wave critical-path
 *     priority: tasks depended on by other tasks in the same wave are placed first.
 *  3. Slice sorted tasks into chunks of maxTasksPerWave and assign new sequential wave numbers.
 *  4. Waves that already fit within the limit are preserved as-is (only their wave number
 *     is resequenced to remain contiguous after earlier waves are split).
 *
 * @param plans - normalized plan objects (must have .wave and .dependencies fields)
 * @param maxTasksPerWave - max tasks per micro-wave (default MICROWAVE_MAX_TASKS_DEFAULT)
 * @returns new plans array with resequenced wave numbers; original objects are not mutated
 */
export function splitWavesIntoMicrowaves(
  plans: any[],
  maxTasksPerWave: number = MICROWAVE_MAX_TASKS_DEFAULT
): any[] {
  if (!Array.isArray(plans) || plans.length === 0) return [];

  const maxTasks = Math.max(1, Math.floor(maxTasksPerWave));

  // Group plans by their declared wave number
  const waveMap = new Map<number, any[]>();
  for (const plan of plans) {
    const wave = Number.isFinite(Number(plan.wave)) ? Number(plan.wave) : 1;
    if (!waveMap.has(wave)) waveMap.set(wave, []);
    waveMap.get(wave)!.push(plan);
  }

  const sortedWaveKeys = [...waveMap.keys()].sort((a, b) => a - b);
  const result: any[] = [];
  let nextWaveNum = 1;

  for (const waveKey of sortedWaveKeys) {
    const wavePlans = waveMap.get(waveKey)!;

    // Compute intra-wave dependent count for each task (critical-path ordering).
    // Only considers tasks within the same wave — cross-wave dependencies are excluded
    // to prevent inflating scores of tasks whose dependents belong to a later wave.
    const idToDepCount = new Map<string, number>();
    const waveTaskIds = new Set<string>();
    for (const plan of wavePlans) {
      const id = String(plan.task_id || plan.id || plan.task || "");
      if (id) { idToDepCount.set(id, 0); waveTaskIds.add(id); }
    }
    for (const plan of wavePlans) {
      const deps = Array.isArray(plan.dependencies) ? plan.dependencies : [];
      for (const dep of deps) {
        const depStr = String(dep || "");
        // Only count intra-wave dependencies (cross-wave deps do not affect ordering here)
        if (waveTaskIds.has(depStr)) {
          idToDepCount.set(depStr, (idToDepCount.get(depStr) ?? 0) + 1);
        }
      }
    }

    // Sort: tasks with more intra-wave dependents (critical path) go first
    const sorted = [...wavePlans].sort((a: any, b: any) => {
      const idA = String(a.task_id || a.id || a.task || "");
      const idB = String(b.task_id || b.id || b.task || "");
      return (idToDepCount.get(idB) ?? 0) - (idToDepCount.get(idA) ?? 0);
    });

    // Slice into micro-waves of maxTasks, reassigning wave numbers sequentially
    for (let i = 0; i < sorted.length; i += maxTasks) {
      const chunk = sorted.slice(i, i + maxTasks);
      for (const plan of chunk) {
        result.push({ ...plan, wave: nextWaveNum });
      }
      nextWaveNum++;
    }
  }

  return result;
}

export function computeCriticalPathScores(
  tasks: Array<{ id: string; dependsOn: string[] }>
): Map<string, number> {
  // Build reverse adjacency: id → ids of tasks that directly depend on it
  const dependentsOf = new Map<string, string[]>();
  for (const task of tasks) {
    if (!dependentsOf.has(task.id)) dependentsOf.set(task.id, []);
    for (const depId of (task.dependsOn || [])) {
      if (!dependentsOf.has(depId)) dependentsOf.set(depId, []);
      dependentsOf.get(depId)!.push(task.id);
    }
  }

  const memo = new Map<string, number>();

  function downstreamDepth(id: string, visiting: Set<string>): number {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0; // cycle guard — DAG assumption; should not trigger
    const deps = dependentsOf.get(id) || [];
    if (deps.length === 0) { memo.set(id, 0); return 0; }
    const next = new Set([...visiting, id]);
    const maxChild = deps.reduce((m, d) => Math.max(m, downstreamDepth(d, next)), 0);
    const score = 1 + maxChild;
    memo.set(id, score);
    return score;
  }

  for (const task of tasks) downstreamDepth(task.id, new Set());
  return memo;
}

export function buildRoleExecutionBatches(plans = [], config, capabilityPoolResult = null) {
  const packetSizePolicy = resolvePacketSizePolicy(config);
  const cycleAnalyticsTelemetry = loadCycleAnalyticsTelemetry(config);
  const taskKindPacketTelemetry = extractTaskKindPacketTelemetry(cycleAnalyticsTelemetry);
  // ── Micro-wave splitting ──────────────────────────────────────────────────
  // When config.planner.maxTasksPerMicrowave is set to a positive integer,
  // large waves are split into micro-waves of at most that many tasks.
  // Critical-path tasks within each wave are placed first so the longest tail
  // of dependent work is unblocked as early as possible.
  //
  // This is opt-in: if maxTasksPerMicrowave is absent/falsy, no splitting
  // occurs and the function behaves identically to the previous version
  // (backward-compatible).
  const rawMicrowaveMax = (config as any)?.planner?.maxTasksPerMicrowave;
  const microwaveMax = Number.isFinite(Number(rawMicrowaveMax)) && Number(rawMicrowaveMax) > 0
    ? Math.floor(Number(rawMicrowaveMax))
    : 0; // 0 = disabled
  let inputPlans = microwaveMax > 0
    ? splitWavesIntoMicrowaves(plans as any[], microwaveMax)
    : (plans as any[]);

  // Compact non-dependent singleton waves into earlier waves when enabled.
  // This reduces unnecessary serial execution stages by merging singleton waves
  // whose sole task has no dependencies into the earliest eligible wave.
  // Opt-in via config.planner.compactSingletonWaves — backward-compatible (default: off).
  if ((config as any)?.planner?.compactSingletonWaves === true) {
    inputPlans = compactSingletonWaves(inputPlans);
  }

  const enforceDependencyAwareWaves = (config as any)?.planner?.requireDependencyAwareWaves !== false;
  const splitConflictingPlansAcrossBatches = shouldSplitConflictingPlansAcrossBatches(config);

  if (enforceDependencyAwareWaves) {
    const hasDependenciesDeclared = (inputPlans as any[]).some((plan) => hasExplicitDependencies(plan));
    if (!hasDependenciesDeclared) {
      inputPlans = (inputPlans as any[]).map((plan) => {
        if (plan && typeof plan === "object") {
          const mutable = plan as any;
          const explicitWave = Number(mutable.wave);
          if (!Number.isFinite(explicitWave) || explicitWave <= 0) {
            mutable.wave = 1;
          }
          if (!Array.isArray(mutable.waveDepends)) {
            mutable.waveDepends = [];
          }
          return mutable;
        }

        const explicitWave = Number(plan?.wave);
        const normalizedWave = Number.isFinite(explicitWave) && explicitWave > 0 ? explicitWave : 1;
        const waveDepends = Array.isArray(plan?.waveDepends) ? plan.waveDepends : [];
        return { ...plan, wave: normalizedWave, waveDepends };
      });
    }
  }

  // ── Dependency graph resolution ───────────────────────────────────────────
  // When any plan carries explicit dependency or file-scope hints, resolve the
  // full dependency graph to (a) assign accurate wave numbers and (b) detect
  // file-conflict pairs that lane detection may not cover (e.g. when no
  // capabilityPoolResult is available).
  // Graph resolution is advisory — a failure never blocks scheduling.
  const graphWaveByPlanId = new Map<string, number>();
  const graphConflictList: Array<[string, string]> = [];
  // Critical-path scores computed from the dependency graph.
  // Within the same wave, tasks with higher scores are dispatched first so the
  // longest tail of blocked downstream work is unblocked as early as possible.
  const criticalPathScoreByPlanId = new Map<string, number>();

  const hasGraphHints = (inputPlans as any[]).some(p =>
    (Array.isArray(p.filesInScope)   && p.filesInScope.length   > 0) ||
    (Array.isArray(p.dependsOn)      && p.dependsOn.length      > 0) ||
    (Array.isArray(p.dependencies)   && p.dependencies.length   > 0)
  );

  if (hasGraphHints) {
    try {
      const graphTasks = (inputPlans as any[]).map(p => ({
        id:                 String(p.task_id || p.task || p.role || ""),
        dependsOn:          Array.isArray(p.dependsOn)    ? p.dependsOn
                          : Array.isArray(p.dependencies) ? p.dependencies
                          : [],
        filesInScope:       Array.isArray(p.filesInScope) ? p.filesInScope : [],
        // Confidence metadata (opt-in): carry through for the readiness gate
        ...(typeof p.shapeConfidence      === "number" ? { shapeConfidence:      p.shapeConfidence      } : {}),
        ...(typeof p.budgetConfidence     === "number" ? { budgetConfidence:     p.budgetConfidence     } : {}),
        ...(typeof p.dependencyConfidence === "number" ? { dependencyConfidence: p.dependencyConfidence } : {}),
      }));
      const graph = resolveDependencyGraph(graphTasks);
      if (graph.status === GRAPH_STATUS.OK) {
        for (const wave of (graph.waves || [])) {
          for (const id of wave.taskIds) {
            graphWaveByPlanId.set(id, wave.wave);
          }
        }
        for (const cp of (graph.conflictPairs || [])) {
          graphConflictList.push([cp.taskA, cp.taskB]);
        }
      }
      // Compute critical-path scores for within-wave ordering.
      // Runs unconditionally so scores are available even when graph.status
      // is not OK (e.g. cycle detected) — the scores still reflect declared deps.
      const scores = computeCriticalPathScores(graphTasks);
      for (const [id, score] of scores) criticalPathScoreByPlanId.set(id, score);
    } catch {
      // advisory — never block scheduling on graph resolution error
    }
  }

  function resolvePlanWave(plan: any) {
    const explicitWave = Number(plan?.wave);
    if (Number.isFinite(explicitWave) && explicitWave > 0) {
      return explicitWave;
    }

    const planId = String(plan?.task_id || plan?.task || plan?.role || "");
    if (enforceDependencyAwareWaves) {
      const graphWave = graphWaveByPlanId.get(planId);
      if (Number.isFinite(Number(graphWave)) && Number(graphWave) > 0) {
        return Number(graphWave);
      }
    }
    return 1;
  }

  const sortedPlans = [...(inputPlans as any[])].sort((a, b) => {
    const idA   = String(a?.task_id || a?.task || a?.role || "");
    const idB   = String(b?.task_id || b?.task || b?.role || "");
    // Use graph-derived wave when the plan lacks an explicit wave field
    const waveA = resolvePlanWave(a);
    const waveB = resolvePlanWave(b);
    const waveDelta = waveA - waveB;
    if (waveDelta !== 0) return waveDelta;
    // Within the same wave, dispatch critical-path tasks first.
    // Higher critical-path score means more downstream work is blocked on this
    // task — running it earlier maximises throughput across the wave.
    const scoreA = criticalPathScoreByPlanId.get(idA) ?? 0;
    const scoreB = criticalPathScoreByPlanId.get(idB) ?? 0;
    const scoreDelta = scoreB - scoreA; // descending: higher score → earlier dispatch
    if (scoreDelta !== 0) return scoreDelta;
    return Number(a?.priority || 0) - Number(b?.priority || 0);
  });

  // ── Conflict-aware lane separation ────────────────────────────────────────
  // If the capability pool detected intra-lane file conflicts, plans that
  // share target files within the same lane must not be co-batched.
  // Build a conflict adjacency set: "planIndex_a:planIndex_b" → true
  const conflictedPairs = new Set();
  if (splitConflictingPlansAcrossBatches && capabilityPoolResult?.assignments) {
    const assignments = capabilityPoolResult.assignments;
    const laneMap = new Map();
    for (let i = 0; i < assignments.length; i++) {
      const lane = assignments[i]?.selection?.lane || "unknown";
      if (!laneMap.has(lane)) laneMap.set(lane, []);
      laneMap.get(lane).push(i);
    }
    for (const indices of laneMap.values()) {
      for (let a = 0; a < indices.length - 1; a++) {
        for (let b = a + 1; b < indices.length; b++) {
          const planA = assignments[indices[a]]?.plan;
          const planB = assignments[indices[b]]?.plan;
          const filesA = new Set(
            Array.isArray(planA?.target_files) ? planA.target_files.map(String) :
            (Array.isArray(planA?.targetFiles) ? planA.targetFiles.map(String) : [])
          );
          if (filesA.size === 0) continue;
          const hasOverlap = (
            Array.isArray(planB?.target_files) ? planB.target_files.map(String) :
            (Array.isArray(planB?.targetFiles) ? planB.targetFiles.map(String) : [])
          ).some(f => filesA.has(f));
          if (hasOverlap) {
            // Record original-array indices so we can match back to sortedPlans
            conflictedPairs.add(`${indices[a]}:${indices[b]}`);
            conflictedPairs.add(`${indices[b]}:${indices[a]}`);
          }
        }
      }
    }
  }

  // Build a lookup from plan object identity → original assignment index
  const planToAssignmentIndex = new Map();
  if (splitConflictingPlansAcrossBatches && capabilityPoolResult?.assignments) {
    capabilityPoolResult.assignments.forEach((a, i) => {
      if (a?.plan) planToAssignmentIndex.set(a.plan, i);
    });
  }

  // Build a plan-ID-based conflict set from the dependency graph resolution.
  // This supplements lane-based conflicts and covers cases where capabilityPoolResult is absent.
  const graphConflictIdPairs = new Set<string>();
  if (splitConflictingPlansAcrossBatches) {
    for (const [taskA, taskB] of graphConflictList) {
      graphConflictIdPairs.add(`${taskA}:${taskB}`);
      graphConflictIdPairs.add(`${taskB}:${taskA}`);
    }
  }

  /**
   * Determine whether two plan objects are in conflict via either:
   *  (a) lane-based file overlap detected by the capability pool, or
   *  (b) file-scope conflict detected by the dependency graph resolver.
   */
  function arePlansConflicting(planA: any, planB: any) {
    if (!splitConflictingPlansAcrossBatches) return false;
    const idxA = planToAssignmentIndex.get(planA) ?? -1;
    const idxB = planToAssignmentIndex.get(planB) ?? -1;
    // Lane-based conflict (assignment index pair)
    if (idxA !== -1 && idxB !== -1 && conflictedPairs.has(`${idxA}:${idxB}`)) return true;
    // Graph-based conflict (plan ID pair)
    if (graphConflictIdPairs.size > 0) {
      const planAId = String((planA as any)?.task_id || (planA as any)?.task || (planA as any)?.role || "");
      const planBId = String((planB as any)?.task_id || (planB as any)?.task || (planB as any)?.role || "");
      if (planAId && planBId && graphConflictIdPairs.has(`${planAId}:${planBId}`)) return true;
    }
    return false;
  }

  const roleBuckets = new Map();
  for (const plan of sortedPlans) {
    const roleName = String(plan?.role || "evolution-worker");
    if (!roleBuckets.has(roleName)) roleBuckets.set(roleName, []);
    roleBuckets.get(roleName).push(plan);
  }

  const flattened = [];
  for (const [roleName, rolePlans] of roleBuckets.entries()) {
    const taskKind = String(rolePlans[0]?.taskKind || rolePlans[0]?.kind || "implementation");
    const sharedBranch = buildSharedBranchName(roleName, rolePlans);

    // ── Conflict-aware sub-grouping within a role bucket ──────────────────
    // Default behavior keeps potentially conflicting plans in the same role
    // batch so the worker can execute them in deterministic order. When
    // planner.splitConflictingPlansAcrossBatches=true, fallback to greedy
    // conflict coloring to isolate conflicting plans into separate sub-groups.
    const subGroups: Array<typeof rolePlans> = [];
    if (splitConflictingPlansAcrossBatches) {
      for (let i = 0; i < rolePlans.length; i++) {
        const plan = rolePlans[i];

        // Find the first group that has no conflict with this plan
        let placed = false;
        for (let g = 0; g < subGroups.length; g++) {
          const hasConflict = subGroups[g].some((existing) => arePlansConflicting(plan, existing));
          if (!hasConflict) {
            subGroups[g].push(plan);
            placed = true;
            break;
          }
        }
        if (!placed) {
          subGroups.push([plan]);
        }
      }
    } else {
      subGroups.push(rolePlans);
    }

    // ── Wave-boundary enforcement ─────────────────────────────────────────
    // Plans from different waves must NOT be co-batched into the same context
    // batch delivered to a worker. Wave N+1 tasks have data dependencies on
    // ALL wave N completions across all workers; co-batching would allow a
    // worker to start wave N+1 work before wave N is globally complete.
    //
    // For each sub-group, split by wave number first, then pack each wave
    // slice into context batches independently using the critical-path-sized
    // model selection.
    for (const subGroupPlans of subGroups) {
      const plansByWave = new Map<number, typeof subGroupPlans>();
      for (const plan of subGroupPlans) {
        const waveNum = resolvePlanWave(plan);
        if (!plansByWave.has(waveNum)) plansByWave.set(waveNum, []);
        plansByWave.get(waveNum)!.push(plan);
      }

      const sortedWaves = [...plansByWave.keys()].sort((a, b) => a - b);
      // Nucleus/frontier mode: opt-in via config.planner.nucleusFrontierMode.
      // When enabled, nucleus tasks (critical-path score > 0) are packed first
      // and frontier tasks (score = 0) are greedily absorbed into nucleus batches
      // to maximise context utilisation and reduce total request count.
      const nucleusFrontierMode = (config as any)?.planner?.nucleusFrontierMode === true;
      for (const waveNum of sortedWaves) {
        const wavePlans = plansByWave.get(waveNum)!;
        const selection = chooseModelForRolePlans(config, roleName, wavePlans, taskKind);
        const adaptivePacketLimit = resolveAdaptivePacketPlanLimit({
          taskKinds: wavePlans.map((plan) => plan?.taskKind || plan?.kind || taskKind),
          baseCap: packetSizePolicy.maxPlansPerPacket,
          taskKindTelemetry: taskKindPacketTelemetry,
        });
        const explicitPacketCap = Number((config as any)?.planner?.maxPlansPerPacket);
        const enforceAdaptivePacketCap = Number.isFinite(explicitPacketCap) && explicitPacketCap > 0
          || adaptivePacketLimit.reasonCodes.length > 0;

        // When nucleus/frontier mode is active, replace the standard sequential
        // batches with nucleus-first / frontier-fill batches.  This reduces the
        // total number of API requests while preserving dependency ordering.
        const activeBatches = nucleusFrontierMode && criticalPathScoreByPlanId.size > 0
          ? packNucleusFrontierBatches(wavePlans, criticalPathScoreByPlanId, selection.usableContextTokens)
          : selection.batches;

        // ── Dependency-sensitive batch splitting ──────────────────────────
        // When any plan in a model-selected batch carries explicit dependency
        // declarations, split oversized batches to MAX_PLANS_PER_DEPENDENCY_BATCH
        // plans each.  This prevents a worker from receiving a large context
        // bundle where dependency ordering can be silently ignored.
        const maxDepBatch = normalizeDependencyBatchLimit(
          (config as any)?.runtime?.maxPlansPerDependencyBatch,
          MAX_PLANS_PER_DEPENDENCY_BATCH
        );
        const splitBatches: Array<{ plans: unknown[]; estimatedTokens: number }> = [];
        for (const batch of activeBatches) {
          const batchPlans = batch.plans as any[];
          const hasDeps = batchPlans.some((p) => hasExplicitDependencies(p));
          const packetPlanLimit = enforceAdaptivePacketCap
            ? adaptivePacketLimit.maxPlansPerPacket
            : Math.max(1, batchPlans.length);
          const chunkSize = hasDeps
            ? Math.max(1, Math.min(maxDepBatch, packetPlanLimit))
            : packetPlanLimit;
          if (batchPlans.length > chunkSize) {
            // Chunk into groups of maxDepBatch; distribute estimated tokens proportionally
            for (let offset = 0; offset < batchPlans.length; offset += chunkSize) {
              const chunk = batchPlans.slice(offset, offset + chunkSize);
              splitBatches.push({
                plans: chunk,
                estimatedTokens: Math.round(batch.estimatedTokens * chunk.length / batchPlans.length),
              });
            }
          } else {
            splitBatches.push(batch);
          }
        }

        const compactedBatches: Array<{ plans: unknown[]; estimatedTokens: number }> = [];
        for (const batch of splitBatches) {
          const currentPlans = batch.plans as any[];
          if (compactedBatches.length === 0) {
            compactedBatches.push(batch);
            continue;
          }

          // Best-fit packing: try to fit into the existing batch with the most
          // remaining capacity (fewest wasted tokens). This maximizes context
          // utilization per worker invocation.
          let bestFitIndex = -1;
          let bestFitRemaining = Infinity;
          for (let ci = 0; ci < compactedBatches.length; ci++) {
            const candidate = compactedBatches[ci];
            const candidatePlans = candidate.plans as any[];
            const mergedPlans = [...candidatePlans, ...currentPlans];
            const mergedTokens = estimateBatchTokens(mergedPlans);
            const mergedHasDeps = mergedPlans.some((p) => hasExplicitDependencies(p));
            const withinDepLimit = !mergedHasDeps || mergedPlans.length <= maxDepBatch;
            const withinContextLimit = mergedTokens <= selection.usableContextTokens;
            const withinPacketPlanLimit = !enforceAdaptivePacketCap || mergedPlans.length <= adaptivePacketLimit.maxPlansPerPacket;

            if (withinDepLimit && withinContextLimit && withinPacketPlanLimit) {
              const remaining = selection.usableContextTokens - mergedTokens;
              if (remaining < bestFitRemaining) {
                bestFitIndex = ci;
                bestFitRemaining = remaining;
              }
            }
          }

          if (bestFitIndex >= 0) {
            const target = compactedBatches[bestFitIndex];
            const merged = [...(target.plans as any[]), ...currentPlans];
            target.plans = merged;
            target.estimatedTokens = estimateBatchTokens(merged);
          } else {
            compactedBatches.push(batch);
          }
        }

        // ── Actionable-steps cap enforcement ─────────────────────────────
        // The pre-dispatch governance gate (Gate 12: OVERSIZED_PACKET) is the
        // primary hard-admission check when maxActionableStepsPerPacket is configured.
        // If the gate passed and a batch still exceeds the cap here, it indicates
        // a misconfiguration or a code path that bypassed the gate.  In that case
        // we surface a warning but do NOT auto-split — the caller must fix the plan
        // decomposition.  Auto-splitting silently hides oversized packets from
        // operators and was the advisory fallback this gate replaces.
        const rawActionableCap = Number((config as any)?.planner?.maxActionableStepsPerPacket);
        const actionableCap = Number.isFinite(rawActionableCap) && rawActionableCap > 0
          ? Math.floor(rawActionableCap)
          : 0; // 0 = disabled (default — preserves backward-compatible behaviour)

        const actionableBatches: Array<{ plans: unknown[]; estimatedTokens: number }> = [];
        for (const batch of compactedBatches) {
          const batchPlans = batch.plans as any[];
          if (actionableCap > 0 && batchPlans.length > actionableCap) {
            // Reached here despite the pre-dispatch gate — emit a deterministic warning.
            // Do NOT auto-split: the plan must be decomposed before dispatch.
            const violation = checkPacketSizeCap(batchPlans, actionableCap);
            if (typeof console !== "undefined") {
              // eslint-disable-next-line no-console
              console.warn(`[worker_batch_planner] OVERSIZED_PACKET safety-net: ${violation}. ` +
                "Pre-dispatch governance gate should have blocked this. Decompose the plan.");
            }
          }
          actionableBatches.push(batch);
        }

        actionableBatches.forEach((batch, index) => {
          const utilization = selection.usableContextTokens > 0
            ? Math.round((batch.estimatedTokens / selection.usableContextTokens) * 100)
            : 0;
          flattened.push({
            role: roleName,
            plans: batch.plans,
            model: selection.model,
            contextWindowTokens: selection.contextWindowTokens,
            usableContextTokens: selection.usableContextTokens,
            estimatedTokens: batch.estimatedTokens,
            contextUtilizationPercent: utilization,
            taskKind,
            modelRouting: selection.economicsRouting,
            adaptivePacketCap: adaptivePacketLimit.maxPlansPerPacket,
            adaptivePacketCapReasons: adaptivePacketLimit.reasonCodes,
            sharedBranch,
            wave: waveNum,
            roleBatchIndex: index + 1,
            roleBatchTotal: actionableBatches.length,
            githubFinalizer: index === actionableBatches.length - 1,
          });
        });
      }
    }
  }

  // ── Lane diversity enforcement ───────────────────────────────────────────────
  // When a capabilityPoolResult is available (computed by capability_pool before
  // dispatch), enforce the minimum lane diversity threshold.  A violation is
  // advisory — it does NOT block scheduling — but it is surfaced on every batch
  // descriptor so the orchestrator or cycle-analytics can observe and react.
  //
  // Configurable via config.runtime.minDiversityLanes (default: 2).
  const minDiversityLanes = Number(
    (config as any)?.runtime?.minDiversityLanes ?? 2
  );
  const diversityCheck = capabilityPoolResult
    ? enforceLaneDiversity(capabilityPoolResult, { minLanes: minDiversityLanes })
    : { meetsMinimum: true, activeLaneCount: 0, warning: "" };

  const diversityViolation = !diversityCheck.meetsMinimum
    ? { activeLaneCount: diversityCheck.activeLaneCount, minRequired: minDiversityLanes, warning: diversityCheck.warning }
    : null;

  // Sort by wave so that sequential dispatch (orchestrator's for-loop) respects the
  // global wave boundary across roles.  Without this, role-grouped insertion order
  // produces [A-wave1, A-wave2, B-wave1, B-wave2] — causing wave-2 work to start
  // before all wave-1 work is globally complete.
  flattened.sort((a, b) => (a.wave as number) - (b.wave as number));
  const topologyPlans = flattened.flatMap((batch) => Array.isArray(batch?.plans) ? batch.plans : []);
  const workerTopology = buildWorkerTopologyContract(topologyPlans);
  const executionPattern = selectExecutionPatternForPlans(topologyPlans, {
    workerTopology,
    uncertainty: resolveBatchPlanningUncertainty(topologyPlans),
  });

  return flattened.map((batch, index) => ({
    ...batch,
    bundleIndex: index + 1,
    totalBundles: flattened.length,
    executionPattern,
    workerTopology,
    diversityViolation,
    orderedStepCount: computeBatchOrderedStepCount(batch.plans as any[]),
    estimatedDurationMinutes: computeBatchEstimatedDurationMinutes(batch.plans as any[]),
  }));
}

/**
 * Token-first global batching.
 *
 * Unlike buildRoleExecutionBatches (which applies role bucketing, optional lane
 * conflict splitting and additional reshaping), this function performs a direct
 * token-first pack with strict role isolation:
 *  - never merge different roles into one batch
 *  - within each role bucket, fill context capacity before opening the next batch
 *
 * Wave barriers are disabled — all plans are packed into the fewest batches
 * possible regardless of wave assignments.  Dependency ordering is enforced
 * via the worker prompt (execution order within a batch) instead of code-level
 * wave boundaries.
 *
 * This minimises premium request consumption by filling each model context window
 * before opening a new batch.  3 small tasks with no dependencies → 1 batch.
 *
 * @param plans  — normalized plan objects (after role normalization)
 * @param config — BOX config
 * @param opts   — optional: { calibrationState } for token estimate calibration
 * @returns flattened batch array in dispatch order, same shape as buildRoleExecutionBatches
 */
export function buildTokenFirstBatches(
  plans: any[],
  config?: object,
  opts?: { calibrationState?: { globalCoefficient?: number; roleCoefficients?: Record<string, number> } }
): ReturnType<typeof buildRoleExecutionBatches> {
  if (!Array.isArray(plans) || plans.length === 0) return [];

  // ── Wave-topology preservation ────────────────────────────────────────────
  // Wave barriers are preserved so that dependency-ordered plans from different
  // waves are never co-packed into the same context batch.  Token packing is
  // applied WITHIN each wave group, not across wave boundaries.
  // This supersedes the previous unconditional wave=1 collapse which broke
  // dependency ordering when callers supplied multi-wave plan sets.
  const workingPlans: any[] = plans.map(p => ({ ...p }));
  const telemetry = loadCycleAnalyticsTelemetry(config);
  const laneTelemetry = telemetry?.lastCycle?.laneTelemetry ?? {};
  const lanePerformance = buildLanePerformanceFromCycleTelemetry(laneTelemetry);
  const laneTelemetrySignals = buildLaneTelemetrySignals(laneTelemetry);
  // Load reroute penalty history from disk and build per-lane ledger.
  // Specialists that have been repeatedly rerouted face a raised fill threshold
  // (reason-code weighted), not only the lane performance adjustment.
  const rerouteHistoryRecords = loadRerouteHistory(config);
  const reroutePenaltyLedger: ReroutePenaltyLedger = buildReroutePenaltyLedger(rerouteHistoryRecords);
  const specialistFitThreshold = resolveSpecialistFitThreshold(config);
  const configuredMinSpecializedShare = Number((config as any)?.workerPool?.specializationTargets?.minSpecializedShare ?? 0.35);
  // Use the canonical adaptive share target from capability_pool so that
  // token-first, Athena-prebatched, and role-split paths all derive the same
  // value and scoreboard / gate telemetry stay aligned with workerPool policy.
  const adaptiveMinSpecializedShare = computeAdaptiveSpecializedShareTarget(configuredMinSpecializedShare, lanePerformance);
  const requiredSpecializedCount = Math.max(0, Math.ceil(workingPlans.length * adaptiveMinSpecializedShare));
  let specialistAssignedCount = 0;
  const specialistRebalanceCandidates: Array<{
    plan: any;
    selection: { role: string; lane: string; fitScore: number };
    laneFitThreshold: number;
  }> = [];
  let rebalancedCount = 0;
  const laneUtilizationTargets = Object.fromEntries(
    SPECIALIST_LANE_RESERVATION_ORDER.map((lane) => {
      const signal = laneTelemetrySignals[lane] ?? { completionRate: 0, roi: 0 };
      return [lane, {
        fitScoreThreshold: computeSpecialistFitThreshold(specialistFitThreshold, lane, laneTelemetrySignals),
        fitEligibleCount: 0,
        achievedSpecializedCount: 0,
        completionRate: signal.completionRate,
        roi: signal.roi,
        reservedLane: false,
      }];
    })
  ) as Record<string, {
    fitScoreThreshold: number;
    fitEligibleCount: number;
    achievedSpecializedCount: number;
    completionRate: number;
    roi: number;
    reservedLane: boolean;
  }>;

  // Dispatch-time specialist utilization target:
  // lock specialist routing when fit score clears the configured threshold.
  for (const plan of workingPlans) {
    const selection = selectWorkerByFitScore(plan, config, lanePerformance);
    const laneFitThreshold = computeSpecialistFitThreshold(
      specialistFitThreshold,
      selection.lane,
      laneTelemetrySignals
    );
    plan._fitScore = selection.fitScore;
    plan._fitLane = selection.lane;
    plan._fitScoreThreshold = laneFitThreshold;
    if (selection.role !== "evolution-worker" && selection.fitScore >= laneFitThreshold) {
      if (laneUtilizationTargets[selection.lane]) {
        laneUtilizationTargets[selection.lane].fitEligibleCount += 1;
      }
      plan._originalRole = plan.role;
      plan.role = selection.role;
      plan._specialistFitLocked = true;
      specialistAssignedCount += 1;
      if (laneUtilizationTargets[selection.lane]) {
        laneUtilizationTargets[selection.lane].achievedSpecializedCount += 1;
      }
    } else if (selection.role !== "evolution-worker") {
      specialistRebalanceCandidates.push({
        plan,
        selection: { role: selection.role, lane: selection.lane, fitScore: selection.fitScore },
        laneFitThreshold,
      });
    }
  }

  // Dispatch admission rebalancing: when specialist utilization is below target,
  // promote top-fit specialist candidates before token-first role packing.
  if (specialistAssignedCount < requiredSpecializedCount && specialistRebalanceCandidates.length > 0) {
    const needed = requiredSpecializedCount - specialistAssignedCount;
    const reservedPromotions = [];
    for (const lane of SPECIALIST_LANE_RESERVATION_ORDER) {
      if ((laneUtilizationTargets[lane]?.fitEligibleCount || 0) === 0) continue;
      if ((laneUtilizationTargets[lane]?.achievedSpecializedCount || 0) > 0) continue;
      const candidate = specialistRebalanceCandidates
        .filter((entry) => entry.selection.lane === lane)
        .sort((a, b) => b.selection.fitScore - a.selection.fitScore)[0];
      if (!candidate || reservedPromotions.includes(candidate)) continue;
      reservedPromotions.push(candidate);
      laneUtilizationTargets[lane].reservedLane = true;
      if (reservedPromotions.length >= needed) break;
    }
    const promoted = [
      ...reservedPromotions,
      ...specialistRebalanceCandidates
        .filter((candidate) => !reservedPromotions.includes(candidate))
        .sort((a, b) => b.selection.fitScore - a.selection.fitScore),
    ].slice(0, needed);
    for (const candidate of promoted) {
      candidate.plan._originalRole = candidate.plan.role;
      candidate.plan.role = candidate.selection.role;
      candidate.plan._specialistFitLocked = true;
      candidate.plan._specialistRebalanced = true;
      candidate.plan._reservedSpecialistLane = candidate.selection.lane;
      candidate.plan._fitLane = candidate.selection.lane;
      candidate.plan._fitScore = candidate.selection.fitScore;
      candidate.plan._fitScoreThreshold = candidate.laneFitThreshold;
      specialistAssignedCount += 1;
      rebalancedCount += 1;
      if (laneUtilizationTargets[candidate.selection.lane]) {
        laneUtilizationTargets[candidate.selection.lane].achievedSpecializedCount += 1;
      }
    }
  }

  // ── Group by role ─────────────────────────────────────────────────────────
  // Different roles must never be merged into the same worker batch.
  const byRole = new Map<string, { role: string; plans: any[] }>();
  for (const plan of workingPlans) {
    const role = String(plan.role || "evolution-worker").trim() || "evolution-worker";
    if (!byRole.has(role)) byRole.set(role, { role, plans: [] });
    byRole.get(role)!.plans.push(plan);
  }

  const defaultModel = (config as any)?.copilot?.defaultModel || "Claude Sonnet 4.6";
  const contextWindowTokens = getModelContextWindowTokens(config, defaultModel);
  const usableTokens = getUsableModelContextTokens(config, defaultModel);
  const flattened: any[] = [];

  // ── Calibration coefficient resolver ──────────────────────────────────────
  const calState = opts?.calibrationState;
  const getCoeff = (role: string): number => {
    if (!calState) return 1.0;
    const roleCoeff = calState.roleCoefficients?.[role];
    if (Number.isFinite(roleCoeff) && (roleCoeff as number) > 0) return roleCoeff as number;
    const g = calState.globalCoefficient;
    return (Number.isFinite(g) && (g as number) > 0) ? g as number : 1.0;
  };

  // ── Specialist-threshold routing ──────────────────────────────────────────
  // For each role group where the role is a specialist (not evolution-worker),
  // check if total estimated tokens fill at least the adaptive fill threshold of
  // usable context.  If not, reroute those plans to evolution-worker for co-packing.
  // The threshold is adapted per lane: lanes with strong performance records get a
  // lower threshold (less gatekeeping), degraded lanes get a higher threshold.
  const specialistThreshold = resolveSpecialistFillThreshold(config);
  const reroutedRoles: string[] = [];
  const specialistRerouteReasons: SpecialistRerouteReason[] = [];

  for (const [key, group] of byRole) {
    if (SPECIALIST_EXEMPT_ROLES.has(group.role)) continue;
    const hasLockedSpecialistPlan = group.plans.some((plan: any) => plan?._specialistFitLocked === true);
    if (hasLockedSpecialistPlan) continue;
    const groupCoeff = getCoeff(group.role);
    const groupTokens = group.plans.reduce((sum, p) => sum + estimatePlanTokens(p, groupCoeff), 0);

    // Resolve the canonical lane for this role group.
    const groupLane = String(group.plans.find((p: any) => p._fitLane)?._fitLane || "implementation");
    // Compute per-lane adaptive fill threshold: good lane → lower bar (specialist stays);
    // degraded lane → higher bar (specialist rerouted to evo-worker more readily).
    // Reroute penalty history further raises the bar for lanes with repeated reroutes.
    const adaptiveFillThreshold = computeAdaptiveSpecialistFillThreshold(
      specialistThreshold,
      groupLane,
      lanePerformance,
      reroutePenaltyLedger,
    );
    const minSpecialistTokens = Math.floor(usableTokens * adaptiveFillThreshold);

    if (groupTokens < minSpecialistTokens) {
      // Below adaptive threshold — reroute to evolution-worker and record reason.
      const laneScore = getLaneScore(lanePerformance, groupLane);
      const fillRatio = usableTokens > 0
        ? Math.round((groupTokens / usableTokens) * 1000) / 1000
        : 0;
      const collapseTriggered =
        (laneUtilizationTargets[groupLane]?.fitEligibleCount || 0) > 0
        && (laneUtilizationTargets[groupLane]?.achievedSpecializedCount || 0) === 0;
      const rerouteReason: SpecialistRerouteReason = {
        role: group.role,
        lane: groupLane,
        tokens: groupTokens,
        thresholdTokens: minSpecialistTokens,
        fillRatio,
        adaptiveFillThreshold,
        reasonCode: collapseTriggered
          ? SPECIALIST_REROUTE_REASON_CODE.FALLBACK_TO_GENERALIST_COLLAPSE
          : SPECIALIST_REROUTE_REASON_CODE.BELOW_FILL_THRESHOLD,
        laneScore,
      };
      reroutedRoles.push(`${group.role}(${groupTokens}tok,adaptive=${adaptiveFillThreshold},lane=${groupLane})`);
      specialistRerouteReasons.push(rerouteReason);
      const evoKey = "evolution-worker";
      if (!byRole.has(evoKey)) {
        byRole.set(evoKey, { role: "evolution-worker", plans: [] });
      }
      // Tag plans with original role and reroute reason for observability, then move them
      for (const plan of group.plans) {
        plan._originalSpecialistRole = group.role;
        plan._rerouteReason = rerouteReason.reasonCode;
        plan._rerouteLane = groupLane;
        plan._rerouteLaneScore = laneScore;
        plan.role = "evolution-worker";
        byRole.get(evoKey)!.plans.push(plan);
      }
      byRole.delete(key);
    }
  }

  // Sort groups: ascending role name (deterministic)
  const sortedGroups = [...byRole.values()].sort((a, b) =>
    a.role.localeCompare(b.role)
  );

  for (const group of sortedGroups) {
    const { role, plans: groupPlans } = group;

    // Sort by priority within group (lower number = higher priority = dispatched first)
    groupPlans.sort((a, b) => Number(a.priority ?? 99) - Number(b.priority ?? 99));

    // ── Greedy token-first packing within the group (wave-aware) ──────────
    // Plans in a group share the same role.  Wave topology is preserved:
    // plans from different waves are never co-packed into the same batch.
    // Within each wave, batches are filled greedily by token capacity.
    const roleCoeff = getCoeff(role);

    // Group plans by wave number (preserving insertion order within each wave)
    const plansByWave = new Map<number, any[]>();
    for (const plan of groupPlans) {
      const waveNum = Number.isFinite(Number(plan.wave)) && Number(plan.wave) > 0
        ? Number(plan.wave)
        : 1;
      if (!plansByWave.has(waveNum)) plansByWave.set(waveNum, []);
      plansByWave.get(waveNum)!.push(plan);
    }
    const sortedWaveNums = [...plansByWave.keys()].sort((a, b) => a - b);

    for (const waveNum of sortedWaveNums) {
      const wavePlans = plansByWave.get(waveNum)!;
      const batches: Array<{ plans: any[]; tokens: number }> = [];
      for (const plan of wavePlans) {
        const planTokens = estimatePlanTokens(plan, roleCoeff);
        let placed = false;
        for (const batch of batches) {
          const hasConflict = batch.plans.some(existing => hasConflictFiles(plan, existing));
          if (!hasConflict && batch.tokens + planTokens <= usableTokens) {
            batch.plans.push(plan);
            batch.tokens += planTokens;
            placed = true;
            break;
          }
        }
        if (!placed) {
          batches.push({ plans: [plan], tokens: planTokens });
        }
      }

      batches.forEach((batch, index) => {
        const taskKind = String(
          batch.plans[0]?.taskKind || batch.plans[0]?.kind || "implementation"
        );
        const sharedBranch = buildSharedBranchName(role, batch.plans);
        const utilization = usableTokens > 0
          ? Math.round((batch.tokens / usableTokens) * 100)
          : 0;

        flattened.push({
          role,
          plans: batch.plans,
          model: defaultModel,
          contextWindowTokens,
          usableContextTokens: usableTokens,
          estimatedTokens: batch.tokens,
          contextUtilizationPercent: utilization,
          taskKind,
          sharedBranch,
          wave: waveNum,
          roleBatchIndex: index + 1,
          roleBatchTotal: batches.length,
          githubFinalizer: index === batches.length - 1,
          tokenFirstPacked: true,
          diversityViolation: null,
        });
      });
    }
  }

  const reservedSpecialistLanes = SPECIALIST_LANE_RESERVATION_ORDER.filter(
    (lane) => (laneUtilizationTargets[lane]?.fitEligibleCount || 0) > 0
  );
  const effectiveSpecialistLanes = SPECIALIST_LANE_RESERVATION_ORDER.filter((lane) =>
    [...byRole.values()].some((group) => group.role !== "evolution-worker" && getLaneForWorkerName(group.role, "implementation") === lane)
  );
  const collapsedReservedLanes = reservedSpecialistLanes.filter((lane) => !effectiveSpecialistLanes.includes(lane));
  const fallbackCollapseCount = specialistRerouteReasons.filter((reason) =>
    reason.reasonCode === SPECIALIST_REROUTE_REASON_CODE.FALLBACK_TO_GENERALIST_COLLAPSE
  ).length;
  const fallbackCollapseRate = reservedSpecialistLanes.length > 0
    ? Math.round((fallbackCollapseCount / reservedSpecialistLanes.length) * 1000) / 1000
    : 0;

  const mapped = flattened.map((batch, index) => ({
    ...batch,
    bundleIndex: index + 1,
    totalBundles: flattened.length,
    specialistUtilizationTarget: {
      fitScoreThreshold: specialistFitThreshold,
      minSpecializedShare: configuredMinSpecializedShare,
      adaptiveMinSpecializedShare,
      requiredSpecializedCount,
      achievedSpecializedCount: specialistAssignedCount,
      targetMet: specialistAssignedCount >= requiredSpecializedCount,
      rebalancedCount,
      rebalanceApplied: rebalancedCount > 0,
      laneUtilizationTargets: Object.fromEntries(
        Object.entries(laneUtilizationTargets).map(([lane, target]) => [lane, {
          ...target,
          targetMet: target.achievedSpecializedCount >= target.fitEligibleCount,
        }])
      ),
      reservedSpecialistLaneCount: reservedSpecialistLanes.length,
      reservedSpecialistLanes,
      effectiveSpecialistLaneCount: effectiveSpecialistLanes.length,
      effectiveSpecialistLanes,
      fallbackCollapseCount,
      fallbackCollapseRate,
      collapsedReservedLanes,
      laneTelemetrySignals,
    },
    ...(reroutedRoles.length > 0 ? { specialistReroutes: reroutedRoles } : {}),
    ...(specialistRerouteReasons.length > 0 ? { specialistRerouteReasons } : {}),
  }));
  const topologyPlans = mapped.flatMap((batch) => Array.isArray(batch?.plans) ? batch.plans : []);
  const workerTopology = buildWorkerTopologyContract(topologyPlans);
  const executionPattern = selectExecutionPatternForPlans(topologyPlans, {
    workerTopology,
    uncertainty: resolveBatchPlanningUncertainty(topologyPlans),
  });

  // ── DAG parallelism bound ──────────────────────────────────────────────────
  // Compute a safe concurrency cap from wave topology: max wave number is a
  // proxy for critical-path depth.  Stamp on the first batch for orchestrator
  // observability without changing dispatch behavior.
  const waveNumbers = workingPlans.map((p: any) => Number(p.wave) || 1).filter(Number.isFinite);
  const maxWave = waveNumbers.length > 0 ? Math.max(...waveNumbers) : 1;
  const dagParallelismBound = computeWaveParallelismBound(workingPlans.length, maxWave);

  return mapped.map((batch, index) => ({
    ...batch,
    bundleIndex: index + 1,
    totalBundles: mapped.length,
    executionPattern,
    workerTopology,
    orderedStepCount: computeBatchOrderedStepCount(batch.plans as any[]),
    estimatedDurationMinutes: computeBatchEstimatedDurationMinutes(batch.plans as any[]),
    ...(index === 0 ? { dagParallelismBound } : {}),
  }));
}

/**
 * Build execution batches using fit-score-based worker assignment.
 *
 * Alternative entry point to buildRoleExecutionBatches for callers that want
 * worker-task fit scoring (selectWorkerByFitScore) rather than relying solely on
 * the plan's `role` field.
 *
 * Each plan is assigned the highest-scoring worker (deterministic tie-breaking)
 * and its `role` field is set accordingly before delegating to
 * buildRoleExecutionBatches.
 *
 * @param plans          — plan objects to assign and batch
 * @param config         — BOX config
 * @param lanePerformance — optional historical lane outcomes for fit scoring
 * @returns same shape as buildRoleExecutionBatches
 */
export function buildFitScoredBatches(
  plans: any[],
  config?: object,
  lanePerformance?: LanePerformanceLedger
) {
  if (!Array.isArray(plans) || plans.length === 0) {
    return buildRoleExecutionBatches([], config);
  }

  const assignedPlans = plans.map(plan => {
    const selection = selectWorkerByFitScore(plan, config, lanePerformance);
    return { ...plan, role: selection.role };
  });

  return buildRoleExecutionBatches(assignedPlans, config);
}

// ── Wave-boundary idle gap instrumentation ─────────────────────────────────────
//
// Measures elapsed time at wave boundaries (when the orchestrator transitions
// from one wave to the next) and provides a packing heuristic to reduce stall
// time without violating dependency ordering.

/**
 * Canonical idle-gap record emitted at each wave boundary crossing.
 * Persisted to state/wave_boundary_idle.jsonl for observability.
 */
export interface WaveBoundaryIdleRecord {
  /** Wave number that just completed. */
  waveFrom: number;
  /** Wave number about to start. */
  waveTo: number;
  /** ISO timestamp when the last batch of waveFrom completed. */
  idleStartedAt: string;
  /** ISO timestamp when the first batch of waveTo started dispatching. */
  idleEndedAt: string;
  /** Idle duration in milliseconds. */
  idleMs: number;
  /** Total number of batches dispatched during the completed wave. */
  batchCount: number;
}

/**
 * Construct a WaveBoundaryIdleRecord from measured timestamps.
 *
 * Pure function — no I/O.
 *
 * @param waveFrom   - wave number that just finished
 * @param waveTo     - wave number about to start
 * @param startMs    - ms timestamp when idle period began (last batch of waveFrom done)
 * @param endMs      - ms timestamp when idle period ended (first batch of waveTo starting)
 * @param batchCount - number of batches in the completed wave
 */
export function measureWaveBoundaryIdleGap(
  waveFrom: number,
  waveTo: number,
  startMs: number,
  endMs: number,
  batchCount: number,
): WaveBoundaryIdleRecord {
  const idleMs = Math.max(0, endMs - startMs);
  return {
    waveFrom,
    waveTo,
    idleStartedAt: new Date(startMs).toISOString(),
    idleEndedAt: new Date(endMs).toISOString(),
    idleMs,
    batchCount: Math.max(0, batchCount),
  };
}

/**
 * Wave-packing heuristic: returns true when the last batch in waveFrom consists
 * of exactly one singleton plan AND no plan in waveTo declares a dependency on
 * that singleton.
 *
 * When true, the wave boundary stall can be avoided by co-packing the singleton
 * into waveTo.  The caller is responsible for performing the actual repack; this
 * function only signals whether it is safe.
 *
 * Returns false conservatively whenever dependency analysis is uncertain.
 *
 * @param waveFromBatches - all batches assigned to the completing wave
 * @param waveToBatches   - all batches assigned to the next wave
 */
export function shouldPackAcrossWaveBoundary(
  waveFromBatches: Array<{ plans: any[] }>,
  waveToBatches: Array<{ plans: any[] }>,
): boolean {
  if (!Array.isArray(waveFromBatches) || waveFromBatches.length === 0) return false;
  if (!Array.isArray(waveToBatches) || waveToBatches.length === 0) return false;

  const lastFromBatch = waveFromBatches[waveFromBatches.length - 1];
  const fromPlans = Array.isArray(lastFromBatch?.plans) ? lastFromBatch.plans : [];
  // Only co-pack when the completing wave has exactly one singleton plan remaining
  if (fromPlans.length !== 1) return false;

  const fromPlanId = String(
    fromPlans[0]?.task_id || fromPlans[0]?.id || fromPlans[0]?.task || "",
  );
  if (!fromPlanId) return false;

  // Conservatively reject if any plan in waveTo depends on the singleton
  for (const batch of waveToBatches) {
    const toPlans = Array.isArray(batch?.plans) ? batch.plans : [];
    for (const plan of toPlans) {
      const deps = Array.isArray(plan?.dependencies) ? plan.dependencies : [];
      if (deps.map(String).includes(fromPlanId)) return false;
    }
  }

  return true;
}

