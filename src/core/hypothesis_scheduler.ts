/**
 * Hypothesis Scheduler — Autonomous Experiment Scheduling Gate (T-021)
 *
 * Schedules one bounded hypothesis experiment per cycle with dependency awareness
 * and budget constraints.
 *
 * ## Definitions (resolving Athena AC1–AC5 gaps)
 *
 * ### Scope Tier (AC1)
 *   Four-value enum controlling how many concurrent experiments are allowed per tier.
 *   Tier is carried on each experiment as `scopeTier` (required field).
 *
 *   critical — core runtime modules (orchestrator, policy_engine, task_queue)
 *              Default slot limit: 1 active experiment
 *   high     — self-improvement, worker management, scheduling infrastructure
 *              Default slot limit: 1 active experiment
 *   medium   — config tuning, prompts, non-core modules
 *              Default slot limit: 2 active experiments
 *   low      — docs, tests, scripts, helpers
 *              Default slot limit: 3 active experiments
 *
 * ### High-Impact Threshold (AC1)
 *   An experiment is "high-impact" when:
 *     experiment.impactScore >= selfImprovement.scheduler.highImpactScoreThreshold (default 0.7)
 *     OR experiment.scopeTier is "critical" or "high"
 *
 * ### Budget Config Keys (AC2)
 *   selfImprovement.scheduler.maxActiveExperimentsPerTier  — per-tier slot map (overrides defaults)
 *   selfImprovement.scheduler.maxTotalActiveExperiments    — global cap (default 3)
 *   runtime.maxParallelWorkers                            — existing worker limit (consulted)
 *   runtime.runtimeBudget.maxWorkerSpawnsPerCycle         — existing spawn limit (consulted)
 *
 * ### Baseline Metric Snapshot (AC3)
 *   Required before an experiment starts.
 *   Schema: state/hypothesis_baselines.json (array of BaselineSnapshot)
 *   Fields: schemaVersion, experimentId, capturedAt, metrics{5 required keys}
 *
 * ### Conflict Detection (AC4)
 *   Layer 1: interventionScope path overlap — already enforced by experiment_registry.js
 *            (two experiments share ≥1 config path in interventionScope)
 *   Layer 2: tier-slot exhaustion — no new experiment starts if its tier's slot limit is full
 *   Layer 3: global active cap — no new experiment starts if maxTotalActiveExperiments is reached
 *
 * ### Rationale Output (AC5)
 *   Written to state/scheduler_rationale.json (array, most recent appended last)
 *   Schema: SchedulerRationale typedef below
 *
 * State files:
 *   state/hypothesis_baselines.json   — baseline metric snapshots
 *   state/scheduler_rationale.json    — selection rationale log
 *
 * Rollback: disable by setting selfImprovement.experimentEngineEnabled = false
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";
import { loadRegistry, detectConflicts, getExperimentsByStatus } from "./experiment_registry.js";
import { warn } from "./logger.js";

// ── Enums ──────────────────────────────────────────────────────────────────────

/**
 * @typedef {"critical"|"high"|"medium"|"low"} ScopeTier
 *
 * critical — core runtime modules (orchestrator, policy_engine, task_queue)
 * high     — self-improvement, workers, scheduling infrastructure
 * medium   — config tuning, prompts, non-core modules
 * low      — docs, tests, scripts, helpers
 */

/** @type {ReadonlySet<ScopeTier>} */
export const VALID_SCOPE_TIERS = Object.freeze(new Set(["critical", "high", "medium", "low"]));

/**
 * @typedef {"selected"|"deferred"|"no_candidates"|"budget_exhausted"|"error"} SelectionStatus
 */

/** @type {ReadonlySet<SelectionStatus>} */
export const VALID_SELECTION_STATUSES = Object.freeze(
  new Set(["selected", "deferred", "no_candidates", "budget_exhausted", "error"])
);

/**
 * Default per-tier slot limits.
 * critical and high: only 1 concurrent experiment (highest risk tiers).
 * medium: 2 concurrent.
 * low: 3 concurrent.
 * @type {Record<ScopeTier, number>}
 */
export const DEFAULT_TIER_SLOTS = Object.freeze({
  critical: 1,
  high:     1,
  medium:   2,
  low:      3
});

/**
 * High-impact score threshold (0–1 scale).
 * Experiments with impactScore >= this value are classified as "high-impact".
 * Tiers "critical" and "high" are always treated as high-impact regardless of score.
 */
export const HIGH_IMPACT_SCORE_THRESHOLD = 0.7;

const DEFAULT_HYPOTHESIS_CANDIDATE_LIMIT = 3;
const HYPOTHESIS_CANDIDATE_SCORE_WEIGHTS = Object.freeze({
  uncertaintyReduction: 0.45,
  cheapVerification: 0.35,
  executionLeverage: 0.20,
});

export interface HypothesisCandidateSignalScores {
  uncertaintyReduction: number;
  cheapVerification: number;
  executionLeverage: number;
}

export interface HypothesisCandidateInput {
  key?: unknown;
  summary?: unknown;
  rationale?: unknown;
  cheapSignals?: unknown;
  signalScores?: Partial<HypothesisCandidateSignalScores> | null;
}

export interface ScheduledHypothesisCandidate {
  key: string;
  summary: string;
  rationale: string;
  cheapSignals: string[];
  signalScores: HypothesisCandidateSignalScores;
  score: number;
}

// ── Typedefs ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} BaselineMetrics
 * @property {number|null} cycleSuccessRate    Fraction [0,1] of cycles that completed without error
 * @property {number|null} workerTimeoutRate   Fraction [0,1] of worker tasks that timed out
 * @property {number|null} taskCompletionRate  Fraction [0,1] of tasks that completed successfully
 * @property {number|null} decisionQualityScore Weighted decision quality score [0,1]
 * @property {number|null} systemHealthScore   System health 0–100
 */

/**
 * @typedef {object} BaselineSnapshot
 * @property {number}          schemaVersion  Always 1
 * @property {string}          experimentId   Experiment this baseline belongs to
 * @property {string}          capturedAt     ISO timestamp
 * @property {BaselineMetrics} metrics        Required metric values (null = not available)
 */

/**
 * @typedef {object} BudgetSnapshot
 * @property {number} maxTotalActiveExperiments  Global cap from config
 * @property {number} currentActiveCount         Currently running experiments
 * @property {number} maxParallelWorkers         From runtime config
 * @property {number} maxWorkerSpawnsPerCycle    From runtime.runtimeBudget
 * @property {Record<ScopeTier, number>} tierSlotLimits   Per-tier max
 * @property {Record<ScopeTier, number>} tierSlotUsed     Per-tier currently used
 */

/**
 * @typedef {object} SchedulerRationale
 * @property {number}          schemaVersion
 * @property {string}          scheduledAt           ISO timestamp
 * @property {string|null}     selectedExperimentId  null if nothing was selected
 * @property {SelectionStatus} selectionStatus
 * @property {string}          rationale             Human-readable explanation
 * @property {number}          selectedFromCount     How many candidates were evaluated
 * @property {string[]}        deferredExperimentIds IDs of experiments that were deferred
 * @property {Record<string,string>} deferralReasons  experimentId → reason code
 * @property {BudgetSnapshot}  budgetSnapshot
 * @property {boolean}         baselineCaptured      Whether baseline was written this cycle
 * @property {string|null}     baselineExperimentId  Experiment whose baseline was captured
 */

// ── Validation ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} SchedulerValidationError
 * @property {string}                         field
 * @property {"MISSING_FIELD"|"INVALID_VALUE"} code
 * @property {string}                         message
 */

/**
 * Validate a schedulable experiment candidate.
 *
 * Checks that the experiment includes the fields required by the scheduler
 * (scopeTier, impactScore) in addition to the base experiment fields.
 *
 * Distinguishes missing fields (MISSING_FIELD) from invalid values (INVALID_VALUE).
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, errors: SchedulerValidationError[] }}
 */
export function validateSchedulerCandidate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ field: "root", code: "MISSING_FIELD", message: "candidate must be a non-null object" }]
    };
  }

  const c = /** @type {Record<string, unknown>} */ (input);
  const errors = /** @type {SchedulerValidationError[]} */ ([]);

  // experimentId
  if (!("experimentId" in c) || c.experimentId == null) {
    errors.push({ field: "experimentId", code: "MISSING_FIELD", message: "experimentId is required" });
  } else if (typeof c.experimentId !== "string" || String(c.experimentId).trim() === "") {
    errors.push({ field: "experimentId", code: "INVALID_VALUE", message: "experimentId must be a non-empty string" });
  }

  // scopeTier
  if (!("scopeTier" in c) || c.scopeTier == null) {
    errors.push({ field: "scopeTier", code: "MISSING_FIELD", message: "scopeTier is required" });
  } else if (!VALID_SCOPE_TIERS.has(/** @type {any} */ (c.scopeTier))) {
    errors.push({
      field: "scopeTier",
      code: "INVALID_VALUE",
      message: `scopeTier must be one of: ${[...VALID_SCOPE_TIERS].join(", ")}`
    });
  }

  // impactScore
  if (!("impactScore" in c) || c.impactScore == null) {
    errors.push({ field: "impactScore", code: "MISSING_FIELD", message: "impactScore is required" });
  } else if (
    typeof c.impactScore !== "number" ||
    !Number.isFinite(c.impactScore) ||
    c.impactScore < 0 ||
    c.impactScore > 1
  ) {
    errors.push({ field: "impactScore", code: "INVALID_VALUE", message: "impactScore must be a finite number in [0, 1]" });
  }

  // interventionScope
  if (!("interventionScope" in c) || c.interventionScope == null) {
    errors.push({ field: "interventionScope", code: "MISSING_FIELD", message: "interventionScope is required" });
  } else if (!Array.isArray(c.interventionScope) || c.interventionScope.length === 0) {
    errors.push({ field: "interventionScope", code: "INVALID_VALUE", message: "interventionScope must be a non-empty array" });
  }

  return { ok: errors.length === 0, errors };
}

function clamp01(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(1, numeric));
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeCheapSignals(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of input) {
    const text = String(entry || "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    normalized.push(text);
    if (normalized.length >= DEFAULT_HYPOTHESIS_CANDIDATE_LIMIT) {
      break;
    }
  }
  return normalized;
}

/**
 * Rank a bounded set of candidate first moves using cheap deterministic signals.
 *
 * This helper is intentionally generic so other bounded-deliberation controllers
 * can reuse the same scoring contract without re-implementing tie-breaking.
 */
export function scheduleBoundedHypothesisCandidates(
  candidates: HypothesisCandidateInput[],
  options: { limit?: number } = {},
): ScheduledHypothesisCandidate[] {
  const requestedLimit = Math.floor(Number(options?.limit ?? DEFAULT_HYPOTHESIS_CANDIDATE_LIMIT));
  const limit = Math.max(0, Math.min(DEFAULT_HYPOTHESIS_CANDIDATE_LIMIT, requestedLimit));
  if (!Array.isArray(candidates) || limit === 0) {
    return [];
  }

  const scored = candidates
    .map((candidate, index) => {
      const key = String(candidate?.key || "").trim();
      const summary = String(candidate?.summary || "").trim();
      if (!key || !summary) {
        return null;
      }
      const rationale = String(candidate?.rationale || "").trim();
      const signalScores: HypothesisCandidateSignalScores = {
        uncertaintyReduction: clamp01(candidate?.signalScores?.uncertaintyReduction),
        cheapVerification: clamp01(candidate?.signalScores?.cheapVerification),
        executionLeverage: clamp01(candidate?.signalScores?.executionLeverage),
      };
      const score = roundScore(
        (signalScores.uncertaintyReduction * HYPOTHESIS_CANDIDATE_SCORE_WEIGHTS.uncertaintyReduction)
        + (signalScores.cheapVerification * HYPOTHESIS_CANDIDATE_SCORE_WEIGHTS.cheapVerification)
        + (signalScores.executionLeverage * HYPOTHESIS_CANDIDATE_SCORE_WEIGHTS.executionLeverage)
      );
      return {
        index,
        candidate: {
          key,
          summary,
          rationale,
          cheapSignals: normalizeCheapSignals(candidate?.cheapSignals),
          signalScores,
          score,
        } satisfies ScheduledHypothesisCandidate,
      };
    })
    .filter((entry): entry is { index: number; candidate: ScheduledHypothesisCandidate } => entry !== null);

  scored.sort((left, right) => {
    const scoreDelta = right.candidate.score - left.candidate.score;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const verificationDelta =
      right.candidate.signalScores.cheapVerification - left.candidate.signalScores.cheapVerification;
    if (verificationDelta !== 0) {
      return verificationDelta;
    }
    const leverageDelta =
      right.candidate.signalScores.executionLeverage - left.candidate.signalScores.executionLeverage;
    if (leverageDelta !== 0) {
      return leverageDelta;
    }
    const keyDelta = left.candidate.key.localeCompare(right.candidate.key);
    if (keyDelta !== 0) {
      return keyDelta;
    }
    return left.index - right.index;
  });

  return scored.slice(0, limit).map((entry) => entry.candidate);
}

// ── High-Impact Classification ─────────────────────────────────────────────────

/**
 * Determine whether an experiment is "high-impact".
 *
 * An experiment is high-impact when:
 *   - impactScore >= threshold (default HIGH_IMPACT_SCORE_THRESHOLD = 0.7), OR
 *   - scopeTier is "critical" or "high"
 *
 * @param {{ scopeTier: ScopeTier, impactScore: number }} experiment
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function isHighImpact(experiment, threshold = HIGH_IMPACT_SCORE_THRESHOLD) {
  return (
    experiment.impactScore >= threshold ||
    experiment.scopeTier === "critical" ||
    experiment.scopeTier === "high"
  );
}

// ── Baseline Metrics ───────────────────────────────────────────────────────────

/**
 * Build a baseline metrics snapshot from a cycle outcomes object.
 * Metrics not available in the outcomes object are set to null.
 *
 * Required metric keys (AC3 schema contract):
 *   cycleSuccessRate, workerTimeoutRate, taskCompletionRate,
 *   decisionQualityScore, systemHealthScore
 *
 * @param {object} outcomes  Object from collectCycleOutcomes (or similar shape)
 * @returns {BaselineMetrics}
 */
export function buildBaselineMetrics(outcomes) {
  const o = outcomes && typeof outcomes === "object" ? outcomes : {};

  // workerTimeoutRate: timeouts / totalDispatches across all workers
  let workerTimeoutRate = null;
  if (Array.isArray(o.workerOutcomes) && o.workerOutcomes.length > 0) {
    const totalDispatches = o.workerOutcomes.reduce((sum, w) => sum + (w.totalDispatches || 0), 0);
    const totalTimeouts = o.workerOutcomes.reduce((sum, w) => sum + (w.timeouts || 0), 0);
    workerTimeoutRate = totalDispatches > 0 ? totalTimeouts / totalDispatches : 0;
  }

  // taskCompletionRate: completedCount / totalPlans
  let taskCompletionRate = null;
  if (typeof o.totalPlans === "number" && o.totalPlans > 0) {
    taskCompletionRate = (o.completedCount || 0) / o.totalPlans;
  }

  // cycleSuccessRate: derived from projectHealth string
  let cycleSuccessRate = null;
  const healthMap = { good: 1.0, warning: 0.5, degraded: 0.2, unknown: null };
  if (typeof o.projectHealth === "string" && o.projectHealth in healthMap) {
    cycleSuccessRate = healthMap[o.projectHealth];
  }

  const decisionQualityScore =
    typeof o.decisionQuality?.score === "number" ? o.decisionQuality.score : null;

  const systemHealthScore =
    typeof o.systemHealthScore === "number" ? o.systemHealthScore : null;

  return {
    cycleSuccessRate,
    workerTimeoutRate,
    taskCompletionRate,
    decisionQualityScore,
    systemHealthScore
  };
}

/**
 * Capture and persist a baseline snapshot for an experiment.
 *
 * Appends to state/hypothesis_baselines.json (creates the file if absent).
 * Only one baseline per experimentId is stored; if one already exists it is
 * replaced to keep the file from growing unbounded.
 *
 * @param {string}       stateDir
 * @param {string}       experimentId
 * @param {BaselineMetrics} metrics
 * @returns {Promise<BaselineSnapshot>}
 */
export async function captureBaseline(stateDir, experimentId, metrics) {
  const baselines = await loadBaselines(stateDir);
  const snapshot = /** @type {BaselineSnapshot} */ ({
    schemaVersion: 1,
    experimentId,
    capturedAt: new Date().toISOString(),
    metrics
  });

  // Replace existing baseline for this experiment if present
  const idx = baselines.findIndex(b => b.experimentId === experimentId);
  if (idx >= 0) {
    baselines[idx] = snapshot;
  } else {
    baselines.push(snapshot);
  }

  await writeJson(path.join(stateDir, "hypothesis_baselines.json"), baselines);
  return snapshot;
}

/**
 * Load all baseline snapshots from disk.
 * Returns empty array if file does not exist.
 * @param {string} stateDir
 * @returns {Promise<BaselineSnapshot[]>}
 */
export async function loadBaselines(stateDir) {
  return readJson(path.join(stateDir, "hypothesis_baselines.json"), []);
}

/**
 * Load the baseline snapshot for a specific experiment.
 * Returns null if no baseline exists.
 * @param {string} stateDir
 * @param {string} experimentId
 * @returns {Promise<BaselineSnapshot|null>}
 */
export async function getBaseline(stateDir, experimentId) {
  const baselines = await loadBaselines(stateDir);
  return baselines.find(b => b.experimentId === experimentId) ?? null;
}

// ── Rationale Persistence ─────────────────────────────────────────────────────

/**
 * Append a scheduler rationale record to state/scheduler_rationale.json.
 * Keeps at most 100 records (trims oldest).
 *
 * @param {string}            stateDir
 * @param {SchedulerRationale} rationale
 */
export async function appendRationale(stateDir, rationale) {
  const existing = await readJson(path.join(stateDir, "scheduler_rationale.json"), []);
  existing.push(rationale);
  // Cap at 100 records
  const trimmed = existing.length > 100 ? existing.slice(-100) : existing;
  await writeJson(path.join(stateDir, "scheduler_rationale.json"), trimmed);
}

/**
 * Load all rationale records.
 * @param {string} stateDir
 * @returns {Promise<SchedulerRationale[]>}
 */
export async function loadRationale(stateDir) {
  return readJson(path.join(stateDir, "scheduler_rationale.json"), []);
}

// ── Budget Snapshot ───────────────────────────────────────────────────────────

/**
 * Build a budget snapshot from the runtime config.
 * Reflects the current active experiment counts vs limits.
 *
 * @param {object}  config          box.config.json contents
 * @param {object}  registry        Loaded experiment registry
 * @returns {BudgetSnapshot}
 */
export function buildBudgetSnapshot(config, registry) {
  const schedulerCfg = config.selfImprovement?.scheduler || {};
  const runtimeCfg   = config.runtime || {};

  const maxTotal = typeof schedulerCfg.maxTotalActiveExperiments === "number"
    ? schedulerCfg.maxTotalActiveExperiments
    : 3;

  const maxParallelWorkers      = runtimeCfg.maxParallelWorkers ?? config.maxParallelWorkers ?? 10;
  const maxWorkerSpawnsPerCycle = runtimeCfg.runtimeBudget?.maxWorkerSpawnsPerCycle ?? 12;

  // Per-tier slot limits from config (merge with defaults)
  const configTierSlots = schedulerCfg.maxActiveExperimentsPerTier || {};
  const tierSlotLimits = /** @type {Record<ScopeTier, number>} */ ({});
  for (const tier of VALID_SCOPE_TIERS) {
    tierSlotLimits[tier] = typeof configTierSlots[tier] === "number"
      ? configTierSlots[tier]
      : DEFAULT_TIER_SLOTS[tier];
  }

  // Count currently running experiments per tier
  const running = getExperimentsByStatus(registry, "running");
  const currentActiveCount = running.length;
  const tierSlotUsed = /** @type {Record<ScopeTier, number>} */ ({});
  for (const tier of VALID_SCOPE_TIERS) tierSlotUsed[tier] = 0;
  for (const exp of running) {
    const tier = /** @type {ScopeTier} */ (exp.scopeTier);
    if (tier && VALID_SCOPE_TIERS.has(tier)) {
      tierSlotUsed[tier] = (tierSlotUsed[tier] || 0) + 1;
    }
  }

  return {
    maxTotalActiveExperiments: maxTotal,
    currentActiveCount,
    maxParallelWorkers,
    maxWorkerSpawnsPerCycle,
    tierSlotLimits,
    tierSlotUsed
  };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Schedule one experiment for the current cycle.
 *
 * Algorithm:
 *   1. Validate config input — return error status with reason code if missing/invalid.
 *   2. Load experiment registry.
 *   3. Collect all "planned" experiments from registry.
 *   4. Build budget snapshot from config + registry state.
 *   5. For each planned candidate (sorted by impactScore desc, then createdAt asc):
 *      a. Validate scheduler fields (scopeTier, impactScore, interventionScope).
 *      b. Check global active cap (budget_exhausted if over limit).
 *      c. Check tier-slot availability (deferred with TIER_SLOT_FULL reason).
 *      d. Check interventionScope conflict with running experiments (deferred with CONFLICT).
 *   6. Select the first eligible candidate.
 *   7. Capture baseline metrics snapshot for selected candidate.
 *   8. Emit rationale record to state/scheduler_rationale.json.
 *   9. Return structured scheduling result.
 *
 * This function does NOT transition the experiment to "running" — that is the
 * caller's responsibility after confirming worker capacity externally.
 * This keeps the scheduler pure and testable without needing worker I/O.
 *
 * @param {object} config    box.config.json contents
 * @param {object} [cycleOutcomes]  Optional cycle outcomes for baseline capture
 * @returns {Promise<ScheduleResult>}
 */

/**
 * @typedef {object} ScheduleResult
 * @property {"selected"|"deferred"|"no_candidates"|"budget_exhausted"|"error"} status
 * @property {string|null}     experimentId   Selected experiment ID (null if not selected)
 * @property {string}          rationale      Human-readable explanation
 * @property {string|null}     errorCode      Machine-readable error/defer reason (null if ok)
 * @property {string[]}        deferredIds    IDs of experiments that were considered but deferred
 * @property {BudgetSnapshot}  budgetSnapshot Current budget state
 * @property {boolean}         baselineCaptured Whether baseline was written this call
 */
export async function scheduleNextExperiment(config, cycleOutcomes = null) {
  const siConfig = config?.selfImprovement || {};
  const stateDir = config?.paths?.stateDir || "state";

  // Guard: scheduler feature flag
  if (!siConfig.experimentEngineEnabled) {
    return {
      status: "error",
      experimentId: null,
      rationale: "Experiment engine disabled (selfImprovement.experimentEngineEnabled=false)",
      errorCode: "ENGINE_DISABLED",
      deferredIds: [],
      budgetSnapshot: buildEmptyBudgetSnapshot(config),
      baselineCaptured: false
    };
  }

  // Load registry
  let registry;
  try {
    registry = await loadRegistry(stateDir);
  } catch (err) {
    const reason = `Failed to load experiment registry: ${String(err?.message || err)}`;
    warn(`[hypothesis-scheduler] ${reason}`);
    return {
      status: "error",
      experimentId: null,
      rationale: reason,
      errorCode: "REGISTRY_LOAD_FAILED",
      deferredIds: [],
      budgetSnapshot: buildEmptyBudgetSnapshot(config),
      baselineCaptured: false
    };
  }

  const budgetSnapshot = buildBudgetSnapshot(config, registry);

  // Include bounded search controls in rationale for high-impact scheduling decisions.
  // This keeps scheduler outcomes deterministic and explicit for downstream runners.
  const schedulerSearchBudget = Number(config?.selfImprovement?.scheduler?.searchBudget ?? 2);
  const schedulerDeliberationMode = String(config?.selfImprovement?.scheduler?.deliberationMode || "single-pass");
  const candidates = getExperimentsByStatus(registry, "planned");

  if (candidates.length === 0) {
    const rationale = makeRationale("no_candidates", null, null, 0, [], {}, budgetSnapshot);
    await appendRationale(stateDir, rationale);
    return {
      status: "no_candidates",
      experimentId: null,
      rationale: "No planned experiments available to schedule",
      errorCode: null,
      deferredIds: [],
      budgetSnapshot,
      baselineCaptured: false
    };
  }

  // Global active cap check
  if (budgetSnapshot.currentActiveCount >= budgetSnapshot.maxTotalActiveExperiments) {
    const deferredIds = candidates.map(c => c.experimentId);
    const deferralReasons = Object.fromEntries(deferredIds.map(id => [id, "GLOBAL_ACTIVE_CAP"]));
    const rationaleMsg = `Global active cap reached (${budgetSnapshot.currentActiveCount}/${budgetSnapshot.maxTotalActiveExperiments}) — all candidates deferred`;
    const rationaleRecord = makeRationale(
      "budget_exhausted", null, rationaleMsg, candidates.length,
      deferredIds, deferralReasons, budgetSnapshot
    );
    await appendRationale(stateDir, rationaleRecord);
    return {
      status: "budget_exhausted",
      experimentId: null,
      rationale: rationaleMsg,
      errorCode: "GLOBAL_ACTIVE_CAP",
      deferredIds,
      budgetSnapshot,
      baselineCaptured: false
    };
  }

  // Evaluate candidates sorted by impactScore desc, then createdAt asc (oldest first for ties)
  const sorted = [...candidates].sort((a, b) => {
    const scoreDiff = (b.impactScore ?? 0) - (a.impactScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (a.createdAt || "").localeCompare(b.createdAt || "");
  });

  let selected = null;
  const deferredIds = [];
  const deferralReasons = /** @type {Record<string, string>} */ ({});

  for (const candidate of sorted) {
    const validation = validateSchedulerCandidate(candidate);
    if (!validation.ok) {
      deferredIds.push(candidate.experimentId || "unknown");
      deferralReasons[candidate.experimentId || "unknown"] =
        `INVALID_CANDIDATE:${validation.errors[0]?.code}:${validation.errors[0]?.field}`;
      continue;
    }

    const tier = /** @type {ScopeTier} */ (candidate.scopeTier);
    const tierUsed  = budgetSnapshot.tierSlotUsed[tier]  ?? 0;
    const tierLimit = budgetSnapshot.tierSlotLimits[tier] ?? DEFAULT_TIER_SLOTS[tier];

    // Tier-slot check
    if (tierUsed >= tierLimit) {
      deferredIds.push(candidate.experimentId);
      deferralReasons[candidate.experimentId] = `TIER_SLOT_FULL:${tier}:${tierUsed}/${tierLimit}`;
      continue;
    }

    // Conflict check (interventionScope path overlap with running experiments)
    const conflict = detectConflicts(registry, candidate);
    if (conflict.hasConflict) {
      deferredIds.push(candidate.experimentId);
      deferralReasons[candidate.experimentId] =
        `CONFLICT:${conflict.conflictsWith.join(",")}:paths:${conflict.sharedPaths.join(",")}`;
      continue;
    }

    // First eligible candidate wins — remaining candidates are implicitly deferred (not_selected)
    selected = candidate;
    // Mark all remaining (unevaluated) candidates as deferred with NOT_SELECTED reason
    const selectedIdx = sorted.indexOf(candidate);
    for (let i = selectedIdx + 1; i < sorted.length; i++) {
      const remaining = sorted[i];
      const rid = remaining.experimentId || "unknown";
      if (!deferredIds.includes(rid)) {
        deferredIds.push(rid);
        deferralReasons[rid] = "NOT_SELECTED:outranked_by_higher_priority_candidate";
      }
    }
    break;
  }

  if (!selected) {
    const rationaleMsg = deferredIds.length > 0
      ? `All ${deferredIds.length} candidate(s) deferred: ${Object.values(deferralReasons).join("; ")}`
      : "No eligible candidates after evaluation";
    const rationaleRecord = makeRationale(
      "deferred", null, rationaleMsg, sorted.length, deferredIds, deferralReasons, budgetSnapshot
    );
    await appendRationale(stateDir, rationaleRecord);
    return {
      status: "deferred",
      experimentId: null,
      rationale: rationaleMsg,
      errorCode: "ALL_DEFERRED",
      deferredIds,
      budgetSnapshot,
      baselineCaptured: false
    };
  }

  // Capture baseline for selected experiment
  let baselineCaptured = false;
  const existingBaseline = await getBaseline(stateDir, selected.experimentId);
  if (!existingBaseline) {
    const metrics = buildBaselineMetrics(cycleOutcomes || {});
    await captureBaseline(stateDir, selected.experimentId, metrics);
    baselineCaptured = true;
  }

  const highImpact = isHighImpact({ scopeTier: selected.scopeTier, impactScore: selected.impactScore ?? 0 });
  const rationaleMsg = [
    `Selected experiment ${selected.experimentId}`,
    `tier=${selected.scopeTier}`,
    `impactScore=${selected.impactScore ?? "n/a"}`,
    `highImpact=${highImpact}`,
    `tierSlots=${budgetSnapshot.tierSlotUsed[selected.scopeTier]}/${budgetSnapshot.tierSlotLimits[selected.scopeTier]}`,
    `globalActive=${budgetSnapshot.currentActiveCount}/${budgetSnapshot.maxTotalActiveExperiments}`,
    deferredIds.length > 0 ? `deferred=${deferredIds.length}` : null,
    `deliberationMode=${schedulerDeliberationMode}`,
    `searchBudget=${schedulerSearchBudget}`,
  ].filter(Boolean).join("; ");

  const rationaleRecord = makeRationale(
    "selected", selected.experimentId, rationaleMsg,
    sorted.length, deferredIds, deferralReasons, budgetSnapshot,
    baselineCaptured, selected.experimentId
  );
  await appendRationale(stateDir, rationaleRecord);

  return {
    status: "selected",
    experimentId: selected.experimentId,
    rationale: rationaleMsg,
    errorCode: null,
    deferredIds,
    budgetSnapshot,
    baselineCaptured
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Build an empty budget snapshot when the registry is unavailable.
 * @param {object} config
 * @returns {BudgetSnapshot}
 */
function buildEmptyBudgetSnapshot(config) {
  const schedulerCfg = config?.selfImprovement?.scheduler || {};
  const runtimeCfg   = config?.runtime || {};
  const tierSlotLimits = /** @type {Record<ScopeTier, number>} */ ({});
  const tierSlotUsed   = /** @type {Record<ScopeTier, number>} */ ({});
  const configTierSlots = schedulerCfg.maxActiveExperimentsPerTier || {};
  for (const tier of VALID_SCOPE_TIERS) {
    tierSlotLimits[tier] = typeof configTierSlots[tier] === "number"
      ? configTierSlots[tier]
      : DEFAULT_TIER_SLOTS[tier];
    tierSlotUsed[tier] = 0;
  }
  return {
    maxTotalActiveExperiments: schedulerCfg.maxTotalActiveExperiments ?? 3,
    currentActiveCount: 0,
    maxParallelWorkers: runtimeCfg.maxParallelWorkers ?? config?.maxParallelWorkers ?? 10,
    maxWorkerSpawnsPerCycle: runtimeCfg.runtimeBudget?.maxWorkerSpawnsPerCycle ?? 12,
    tierSlotLimits,
    tierSlotUsed
  };
}

/**
 * Construct a SchedulerRationale record.
 *
 * @param {SelectionStatus} selectionStatus
 * @param {string|null}     selectedExperimentId
 * @param {string}          rationale
 * @param {number}          selectedFromCount
 * @param {string[]}        deferredExperimentIds
 * @param {Record<string,string>} deferralReasons
 * @param {BudgetSnapshot}  budgetSnapshot
 * @param {boolean}         [baselineCaptured]
 * @param {string|null}     [baselineExperimentId]
 * @returns {SchedulerRationale}
 */
function makeRationale(
  selectionStatus,
  selectedExperimentId,
  rationale,
  selectedFromCount,
  deferredExperimentIds,
  deferralReasons,
  budgetSnapshot,
  baselineCaptured = false,
  baselineExperimentId = null
) {
  return {
    schemaVersion: 1,
    scheduledAt: new Date().toISOString(),
    selectedExperimentId: selectedExperimentId ?? null,
    selectionStatus,
    rationale: rationale || "",
    selectedFromCount,
    deferredExperimentIds: deferredExperimentIds || [],
    deferralReasons: deferralReasons || {},
    budgetSnapshot,
    baselineCaptured,
    baselineExperimentId: baselineExperimentId ?? null
  };
}
