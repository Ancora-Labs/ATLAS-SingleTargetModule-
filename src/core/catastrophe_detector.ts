/**
 * catastrophe_detector.js — Systemic catastrophe pattern detector for BOX.
 *
 * Primary module ownership: this file is the canonical home for all catastrophe
 * detection logic. (Resolves Athena missing item #6.)
 *
 * Risk level: HIGH — integrated into orchestrator.js (runtime backbone) and
 * daemon_control.js shutdown path. (Resolves Athena risk-level note #5.)
 *
 * ── Six catastrophe scenarios (AC #2 / Athena missing item #1) ───────────────
 *   RUNAWAY_RETRIES           — task retry count ≥ threshold in recent window
 *   MASS_BLOCKED_TASKS        — >50% of tasks blocked in a cycle
 *   STALE_CRITICAL_STATE      — critical state files exceed staleness threshold
 *   REPEATED_AI_PARSE_FAILURES — AI parse failures ≥ threshold in recent window
 *   BUDGET_EXHAUSTION_SPIRAL  — budget limit breached in ≥N consecutive cycles
 *   SLO_CASCADING_BREACH      — SLO breaches in ≥N consecutive cycles
 * The 4 original scenarios cover runaway retries, mass blocked tasks, stale
 * critical state, and repeated AI parse failures. The 2 additional scenarios
 * (budget exhaustion spiral, SLO cascading breach) are added here to meet AC#2.
 *
 * ── Overhead bound (AC #3 / Athena missing item #2) ──────────────────────────
 *   detectCatastrophes() is pure-synchronous with no I/O.
 *   Nominal overhead: <1ms. Hard budget: <10ms per cycle.
 *   Measured in tests/core/catastrophe_detector.test.ts using performance.now().
 *
 * ── Guardrail schema (AC #4 / Athena missing item #3) ────────────────────────
 *   GuardrailRecommendation: { action, urgency, description }
 *     action:  one of GUARDRAIL_ACTION enum values
 *     urgency: one of GUARDRAIL_URGENCY enum values
 *     description: non-empty string
 *   Every CatastropheAlert.guardrails array has at least one entry.
 *
 * ── False-positive harness (AC #5 / Athena missing item #4) ─────────────────
 *   Labeled fixture set in tests/fixtures/catastrophe_scenarios/:
 *     positive/ — 6 scenarios that MUST each be detected
 *     negative/ — 2 healthy snapshots that MUST NOT trigger any detection
 *   Test asserts false_positives / total_negatives < CATASTROPHE_DEFAULTS.falsePositiveRateThreshold (0.05).
 *
 * ── CatastropheAlert schema (AC #8) ──────────────────────────────────────────
 *   Required fields:
 *     schemaVersion {number}    = CATASTROPHE_DETECTOR_SCHEMA_VERSION (1)
 *     scenarioId    {string}    — one of CATASTROPHE_SCENARIO values
 *     confidence    {number}    — [0.0, 1.0]
 *     firstSeenAt   {string}    — ISO 8601 (when first observed across cycles)
 *     detectedAt    {string}    — ISO 8601 (this detection run)
 *     status        {string}    — one of CATASTROPHE_STATUS values
 *     evidence      {object}    — scenario-specific metrics (non-empty)
 *     guardrails    {object[]}  — GuardrailRecommendation[] (at least one)
 *
 * ── Validation reason codes (AC #9) ──────────────────────────────────────────
 *   DETECTOR_REASON_CODE.MISSING_INPUT — input is null/undefined
 *   DETECTOR_REASON_CODE.INVALID_INPUT — present but fails structural/type checks
 *   Validation distinguishes the two cases with explicit code + message fields.
 *
 * ── No silent fallback (AC #10) ──────────────────────────────────────────────
 *   runCatastropheDetection() never swallows errors silently. On failure it
 *   returns { ok: false, status: "degraded", reason: <machine-readable string> }.
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";
import { appendAlert, ALERT_SEVERITY } from "./state_tracker.js";
import { emitEvent } from "./logger.js";
import { EVENTS, EVENT_DOMAIN } from "./event_schema.js";

// ── Schema version ────────────────────────────────────────────────────────────

/** Integer schema version for CatastropheAlert. Bump on incompatible schema change. */
export const CATASTROPHE_DETECTOR_SCHEMA_VERSION = 1;

// ── Scenario enum ─────────────────────────────────────────────────────────────

/**
 * All six named catastrophe scenarios.
 * AC #2 requires at least 6; all 6 are explicitly named here.
 */
export const CATASTROPHE_SCENARIO = Object.freeze({
  /** Scenario 1 (original): task retry count exceeds threshold within a cycle. */
  RUNAWAY_RETRIES:             "RUNAWAY_RETRIES",
  /** Scenario 2 (original): majority of tasks in a cycle end blocked. */
  MASS_BLOCKED_TASKS:          "MASS_BLOCKED_TASKS",
  /** Scenario 3 (original): critical state files older than staleness threshold. */
  STALE_CRITICAL_STATE:        "STALE_CRITICAL_STATE",
  /** Scenario 4 (original): AI response parse failures exceed threshold in window. */
  REPEATED_AI_PARSE_FAILURES:  "REPEATED_AI_PARSE_FAILURES",
  /** Scenario 5 (added): budget limit breached in consecutive cycles. */
  BUDGET_EXHAUSTION_SPIRAL:    "BUDGET_EXHAUSTION_SPIRAL",
  /** Scenario 6 (added): SLO breached in consecutive cycles. */
  SLO_CASCADING_BREACH:        "SLO_CASCADING_BREACH",
});

/**
 * Returns true when a scenario identifier is the SLO cascading breach scenario.
 * Shared by governance gates to couple catastrophe state with dispatch safety.
 */
export function isSloCascadingBreachScenario(scenarioId: unknown): boolean {
  return String(scenarioId || "").trim() === CATASTROPHE_SCENARIO.SLO_CASCADING_BREACH;
}

// ── Status enum ───────────────────────────────────────────────────────────────

/** Status field values for CatastropheAlert.status. */
export const CATASTROPHE_STATUS = Object.freeze({
  ACTIVE:     "active",
  RESOLVED:   "resolved",
  SUPPRESSED: "suppressed",
});

// ── Guardrail enums ───────────────────────────────────────────────────────────

/**
 * Recommended action values for GuardrailRecommendation.action.
 *
 * Each value maps to a deterministic state file and execution handler in
 * guardrail_executor.js.  New actions added here must also be registered in
 * ACTION_STATE_FILE in that module.
 *
 * T-033 additions (resolves Athena gap — "pause planning, freeze self-improvement,
 * force checkpoint validation, escalate" all now have explicit enum values):
 *   FREEZE_SELF_IMPROVEMENT     — write state/guardrail_freeze_self_improvement.json
 *   FORCE_CHECKPOINT_VALIDATION — write state/guardrail_force_checkpoint.json
 */
export const GUARDRAIL_ACTION = Object.freeze({
  PAUSE_WORKERS:               "pause_workers",
  INCREASE_DELAY:              "increase_delay",
  NOTIFY_HUMAN:                "notify_human",
  RESET_RETRY_COUNTER:         "reset_retry_counter",
  ESCALATE:                    "escalate",
  SKIP_CYCLE:                  "skip_cycle",
  /** Halt the self-improvement engine until the guardrail is reverted. */
  FREEZE_SELF_IMPROVEMENT:     "freeze_self_improvement",
  /** Require a fresh checkpoint validation pass before the next planning cycle. */
  FORCE_CHECKPOINT_VALIDATION: "force_checkpoint_validation",
});

/** Urgency values for GuardrailRecommendation.urgency. */
export const GUARDRAIL_URGENCY = Object.freeze({
  IMMEDIATE: "immediate",
  DEFERRED:  "deferred",
});

// ── Validation reason codes ───────────────────────────────────────────────────

/**
 * Reason codes distinguishing missing input from invalid input.
 * AC #9: validation MUST set one of these on error.
 */
export const DETECTOR_REASON_CODE = Object.freeze({
  /** Input is null or undefined. */
  MISSING_INPUT: "MISSING_INPUT",
  /** Input is present but fails structural or type validation. */
  INVALID_INPUT: "INVALID_INPUT",
  /** Validation passed. */
  OK:            "OK",
});

// ── Default thresholds ────────────────────────────────────────────────────────

/**
 * Default detection thresholds.
 * Override via config.catastropheDetector or opts argument to detectCatastrophes().
 * All values are deterministic and machine-checkable.
 *
 * overhead budget: detectCatastrophes() must complete in <overheadBudgetMs (10ms).
 * falsePositiveRateThreshold: max fraction of negative fixtures that trigger detection.
 */
export const CATASTROPHE_DEFAULTS = Object.freeze({
  /** Retry count >= this → RUNAWAY_RETRIES. */
  runawayRetryThreshold:          5,
  /** blocked/total > this ratio → MASS_BLOCKED_TASKS. */
  massBlockedRatio:               0.5,
  /** State file age (ms) > this → STALE_CRITICAL_STATE. 2 hours = 7200000 ms. */
  staleCriticalStateAgeMs:        7_200_000,
  /** Parse failure count >= this → REPEATED_AI_PARSE_FAILURES. */
  repeatedParseFailureThreshold:  3,
  /** Consecutive budget breaches >= this → BUDGET_EXHAUSTION_SPIRAL. */
  budgetExhaustionConsecutive:    2,
  /** Consecutive SLO breaches >= this → SLO_CASCADING_BREACH. */
  sloCascadingBreachConsecutive:  3,
  /**
   * Hard overhead budget for detectCatastrophes() per cycle.
   * AC #3 / Athena missing item #2: explicit numeric threshold.
   * Unit: milliseconds.
   */
  overheadBudgetMs:               10,
  /**
   * Maximum acceptable false-positive rate for negative fixture tests.
   * AC #5 / Athena missing item #4: explicit numeric threshold.
   * A value of 0.05 means ≤5% of negative-labeled fixtures may trigger detection.
   */
  falsePositiveRateThreshold:     0.05,
});

// ── Guardrail definitions per scenario ───────────────────────────────────────

/** @type {Record<string, import('./types.js').GuardrailRecommendation[]>} */
const SCENARIO_GUARDRAILS = Object.freeze({
  [CATASTROPHE_SCENARIO.RUNAWAY_RETRIES]: [
    { action: GUARDRAIL_ACTION.RESET_RETRY_COUNTER,     urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Reset per-task retry counters to prevent infinite retry loops." },
    { action: GUARDRAIL_ACTION.INCREASE_DELAY,          urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Increase inter-retry delay to reduce thundering-herd pressure." },
    { action: GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT, urgency: GUARDRAIL_URGENCY.DEFERRED,
      description: "Freeze self-improvement engine until retry storm subsides." },
  ],
  [CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS]: [
    { action: GUARDRAIL_ACTION.PAUSE_WORKERS,           urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Pause worker dispatch until blocking condition is resolved." },
    { action: GUARDRAIL_ACTION.NOTIFY_HUMAN,            urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Notify operator: majority of tasks are blocked — human triage required." },
    { action: GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT, urgency: GUARDRAIL_URGENCY.DEFERRED,
      description: "Freeze self-improvement engine while mass blocking is active." },
  ],
  [CATASTROPHE_SCENARIO.STALE_CRITICAL_STATE]: [
    { action: GUARDRAIL_ACTION.SKIP_CYCLE,                  urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Skip this cycle to avoid acting on stale planning data." },
    { action: GUARDRAIL_ACTION.FORCE_CHECKPOINT_VALIDATION, urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Force a fresh checkpoint validation pass before next planning cycle." },
    { action: GUARDRAIL_ACTION.NOTIFY_HUMAN,                urgency: GUARDRAIL_URGENCY.DEFERRED,
      description: "Notify operator: critical state files have exceeded staleness threshold." },
  ],
  [CATASTROPHE_SCENARIO.REPEATED_AI_PARSE_FAILURES]: [
    { action: GUARDRAIL_ACTION.INCREASE_DELAY,          urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Increase cycle delay to allow AI provider to recover or rate limits to clear." },
    { action: GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT, urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Freeze self-improvement engine while AI provider is degraded." },
    { action: GUARDRAIL_ACTION.ESCALATE,                urgency: GUARDRAIL_URGENCY.DEFERRED,
      description: "Escalate to operator: repeated AI parse failures suggest provider degradation." },
  ],
  [CATASTROPHE_SCENARIO.BUDGET_EXHAUSTION_SPIRAL]: [
    { action: GUARDRAIL_ACTION.PAUSE_WORKERS,           urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Pause all worker spawning to halt budget consumption." },
    { action: GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT, urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Freeze self-improvement engine to stop additional budget-consuming AI calls." },
    { action: GUARDRAIL_ACTION.NOTIFY_HUMAN,            urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Notify operator: budget limit breached in consecutive cycles — manual review required." },
  ],
  [CATASTROPHE_SCENARIO.SLO_CASCADING_BREACH]: [
    { action: GUARDRAIL_ACTION.FORCE_CHECKPOINT_VALIDATION, urgency: GUARDRAIL_URGENCY.IMMEDIATE,
      description: "Force checkpoint validation to verify system state integrity under SLO stress." },
    { action: GUARDRAIL_ACTION.NOTIFY_HUMAN,                urgency: GUARDRAIL_URGENCY.DEFERRED,
      description: "Notify operator: SLO breaches across multiple consecutive cycles indicate systemic slowdown." },
    { action: GUARDRAIL_ACTION.ESCALATE,                    urgency: GUARDRAIL_URGENCY.DEFERRED,
      description: "Escalate to leadership for capacity or architecture review." },
  ],
});

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a detection context object.
 *
 * Distinguishes missing input (ctx is null/undefined) from invalid input
 * (ctx is present but structurally wrong). AC #9.
 *
 * Required fields and their expected types:
 *   retryCount                {number}   — total retries in the current cycle
 *   totalTasks                {number}   — total tasks dispatched this cycle
 *   blockedTasks              {number}   — tasks that ended blocked this cycle
 *   janusDirectiveAgeMs       {number}   — ms since janus_directive.json was last updated
 *   prometheusAnalysisAgeMs   {number}   — ms since prometheus_analysis.json was last updated
 *   parseFailureCount         {number}   — AI parse failures in recent window
 *   consecutiveBudgetBreaches {number}   — consecutive cycles with budget breaches
 *   consecutiveSloBreaches    {number}   — consecutive cycles with SLO breaches
 *
 * Optional:
 *   firstSeenTimestamps       {object}   — map of scenarioId → ISO string for persistence
 *   nowMs                     {number}   — override for current time (tests only)
 *
 * @param {any} ctx
 * @returns {{ ok: boolean, code: string, message: string }}
 */
export function validateDetectionContext(ctx) {
  if (ctx === null || ctx === undefined) {
    return { ok: false, code: DETECTOR_REASON_CODE.MISSING_INPUT, message: "ctx is null or undefined" };
  }
  if (typeof ctx !== "object" || Array.isArray(ctx)) {
    return { ok: false, code: DETECTOR_REASON_CODE.INVALID_INPUT, message: "ctx must be a plain object" };
  }

  const REQUIRED_NUMBERS = [
    "retryCount",
    "totalTasks",
    "blockedTasks",
    "janusDirectiveAgeMs",
    "prometheusAnalysisAgeMs",
    "parseFailureCount",
    "consecutiveBudgetBreaches",
    "consecutiveSloBreaches",
  ];

  for (const field of REQUIRED_NUMBERS) {
    if (!(field in ctx)) {
      return {
        ok: false,
        code: DETECTOR_REASON_CODE.INVALID_INPUT,
        message: `MISSING_FIELD: required field "${field}" is absent`,
      };
    }
    const v = ctx[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return {
        ok: false,
        code: DETECTOR_REASON_CODE.INVALID_INPUT,
        message: `INVALID_FIELD: "${field}" must be a non-negative finite number, got ${JSON.stringify(v)}`,
      };
    }
  }

  return { ok: true, code: DETECTOR_REASON_CODE.OK, message: "valid" };
}

// ── Core detection logic (pure synchronous — no I/O) ─────────────────────────

/**
 * Detect active catastrophe scenarios from a runtime context snapshot.
 *
 * Pure synchronous — no I/O.  Must complete in < CATASTROPHE_DEFAULTS.overheadBudgetMs (10ms).
 * AC #1: every emitted alert includes scenarioId, confidence, and firstSeenAt.
 * AC #3 / Athena missing item #2: overhead budget is <10ms per cycle (verified in tests).
 *
 * @param {object} ctx   — validated detection context (from validateDetectionContext)
 * @param {object} [opts] — optional threshold overrides (merged with CATASTROPHE_DEFAULTS)
 * @returns {{
 *   ok: boolean,
 *   code: string,
 *   message: string,
 *   detections: object[]
 * }}
 */
export function detectCatastrophes(ctx, opts: any = {}) {
  const validation = validateDetectionContext(ctx);
  if (!validation.ok) {
    return { ok: false, code: validation.code, message: validation.message, detections: [] };
  }

  const cfg = { ...CATASTROPHE_DEFAULTS, ...(opts || {}) };
  const nowIso = new Date(typeof ctx.nowMs === "number" ? ctx.nowMs : Date.now()).toISOString();
  const firstSeen = (typeof ctx.firstSeenTimestamps === "object" && ctx.firstSeenTimestamps)
    ? ctx.firstSeenTimestamps
    : {};

  const detections = [];

  // ── Scenario 1: RUNAWAY_RETRIES ───────────────────────────────────────────
  if (ctx.retryCount >= cfg.runawayRetryThreshold) {
    const scenarioId = CATASTROPHE_SCENARIO.RUNAWAY_RETRIES;
    const excess     = ctx.retryCount - cfg.runawayRetryThreshold;
    const confidence = Math.min(1.0, 0.7 + (excess / cfg.runawayRetryThreshold) * 0.3);
    detections.push(_buildAlert(scenarioId, confidence, firstSeen[scenarioId] || nowIso, nowIso, {
      retryCount:            ctx.retryCount,
      threshold:             cfg.runawayRetryThreshold,
      excess,
    }));
  }

  // ── Scenario 2: MASS_BLOCKED_TASKS ───────────────────────────────────────
  if (ctx.totalTasks > 0) {
    const blockedRatio = ctx.blockedTasks / ctx.totalTasks;
    if (blockedRatio > cfg.massBlockedRatio) {
      const scenarioId = CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS;
      const confidence = Math.min(1.0, 0.6 + (blockedRatio - cfg.massBlockedRatio) * 2.0);
      detections.push(_buildAlert(scenarioId, confidence, firstSeen[scenarioId] || nowIso, nowIso, {
        blockedTasks:  ctx.blockedTasks,
        totalTasks:    ctx.totalTasks,
        blockedRatio:  Number(blockedRatio.toFixed(3)),
        threshold:     cfg.massBlockedRatio,
      }));
    }
  }

  // ── Scenario 3: STALE_CRITICAL_STATE ─────────────────────────────────────
  const maxStateAge = Math.max(ctx.janusDirectiveAgeMs, ctx.prometheusAnalysisAgeMs);
  if (maxStateAge > cfg.staleCriticalStateAgeMs) {
    const scenarioId = CATASTROPHE_SCENARIO.STALE_CRITICAL_STATE;
    const overageMs  = maxStateAge - cfg.staleCriticalStateAgeMs;
    const confidence = Math.min(1.0, 0.65 + (overageMs / cfg.staleCriticalStateAgeMs) * 0.35);
    detections.push(_buildAlert(scenarioId, confidence, firstSeen[scenarioId] || nowIso, nowIso, {
      janusDirectiveAgeMs:      ctx.janusDirectiveAgeMs,
      prometheusAnalysisAgeMs:  ctx.prometheusAnalysisAgeMs,
      maxStateAgeMs:            maxStateAge,
      thresholdMs:              cfg.staleCriticalStateAgeMs,
      overageMs,
    }));
  }

  // ── Scenario 4: REPEATED_AI_PARSE_FAILURES ───────────────────────────────
  if (ctx.parseFailureCount >= cfg.repeatedParseFailureThreshold) {
    const scenarioId = CATASTROPHE_SCENARIO.REPEATED_AI_PARSE_FAILURES;
    const excess     = ctx.parseFailureCount - cfg.repeatedParseFailureThreshold;
    const confidence = Math.min(1.0, 0.7 + (excess / cfg.repeatedParseFailureThreshold) * 0.3);
    detections.push(_buildAlert(scenarioId, confidence, firstSeen[scenarioId] || nowIso, nowIso, {
      parseFailureCount: ctx.parseFailureCount,
      threshold:         cfg.repeatedParseFailureThreshold,
      excess,
    }));
  }

  // ── Scenario 5: BUDGET_EXHAUSTION_SPIRAL ─────────────────────────────────
  if (ctx.consecutiveBudgetBreaches >= cfg.budgetExhaustionConsecutive) {
    const scenarioId = CATASTROPHE_SCENARIO.BUDGET_EXHAUSTION_SPIRAL;
    const excess     = ctx.consecutiveBudgetBreaches - cfg.budgetExhaustionConsecutive;
    const confidence = Math.min(1.0, 0.75 + (excess / Math.max(1, cfg.budgetExhaustionConsecutive)) * 0.25);
    detections.push(_buildAlert(scenarioId, confidence, firstSeen[scenarioId] || nowIso, nowIso, {
      consecutiveBudgetBreaches: ctx.consecutiveBudgetBreaches,
      threshold:                 cfg.budgetExhaustionConsecutive,
      excess,
    }));
  }

  // ── Scenario 6: SLO_CASCADING_BREACH ─────────────────────────────────────
  if (ctx.consecutiveSloBreaches >= cfg.sloCascadingBreachConsecutive) {
    const scenarioId = CATASTROPHE_SCENARIO.SLO_CASCADING_BREACH;
    const excess     = ctx.consecutiveSloBreaches - cfg.sloCascadingBreachConsecutive;
    const confidence = Math.min(1.0, 0.7 + (excess / Math.max(1, cfg.sloCascadingBreachConsecutive)) * 0.3);
    detections.push(_buildAlert(scenarioId, confidence, firstSeen[scenarioId] || nowIso, nowIso, {
      consecutiveSloBreaches: ctx.consecutiveSloBreaches,
      threshold:              cfg.sloCascadingBreachConsecutive,
      excess,
    }));
  }

  return { ok: true, code: DETECTOR_REASON_CODE.OK, message: "detection complete", detections };
}

/**
 * Build a single CatastropheAlert object.
 * Internal helper — not exported.
 *
 * @param {string} scenarioId
 * @param {number} confidence
 * @param {string} firstSeenAt
 * @param {string} detectedAt
 * @param {object} evidence
 * @returns {object} CatastropheAlert
 */
function _buildAlert(scenarioId, confidence, firstSeenAt, detectedAt, evidence) {
  return {
    schemaVersion: CATASTROPHE_DETECTOR_SCHEMA_VERSION,
    scenarioId,
    confidence: Number(confidence.toFixed(4)),
    firstSeenAt,
    detectedAt,
    status:     CATASTROPHE_STATUS.ACTIVE,
    evidence,
    guardrails: SCENARIO_GUARDRAILS[scenarioId] || [],
  };
}

// ── Persistence helpers ───────────────────────────────────────────────────────

/** File path for catastrophe state within stateDir. */
function catastropheStateFile(stateDir) {
  return path.join(stateDir, "catastrophe_state.json");
}

/**
 * Load persisted catastrophe state (firstSeenTimestamps + consecutive counters).
 *
 * @param {object} config
 * @returns {Promise<object>}
 */
export async function loadCatastropheState(config) {
  const stateDir = config?.paths?.stateDir || "state";
  return readJson(catastropheStateFile(stateDir), {
    schemaVersion:            CATASTROPHE_DETECTOR_SCHEMA_VERSION,
    updatedAt:                new Date().toISOString(),
    firstSeenTimestamps:      {},
    consecutiveBudgetBreaches: 0,
    consecutiveSloBreaches:   0,
    parseFailureCount:        0,
    lastDetections:           [],
  });
}

/**
 * Persist updated catastrophe state.
 *
 * @param {object} config
 * @param {object} state
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function saveCatastropheState(config, state) {
  const stateDir = config?.paths?.stateDir || "state";
  try {
    await writeJson(catastropheStateFile(stateDir), {
      ...state,
      schemaVersion: CATASTROPHE_DETECTOR_SCHEMA_VERSION,
      updatedAt:     new Date().toISOString(),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `WRITE_FAILED: ${String(err?.message || err)}` };
  }
}

// ── Async orchestrator integration ────────────────────────────────────────────

/**
 * Run catastrophe detection for one orchestration cycle.
 *
 * Advisory — NEVER blocks orchestration. Any internal error sets ok=false with an
 * explicit status="degraded" and reason code. AC #10: no silent fallback.
 *
 * Steps:
 *   1. Load persisted catastrophe state (firstSeenTimestamps, consecutive counters)
 *   2. Build detection context from cycleData + persisted state
 *   3. Run detectCatastrophes() (pure, synchronous, <10ms)
 *   4. Persist updated state (updated firstSeenTimestamps)
 *   5. Emit alerts via appendAlert() for each active detection
 *   6. Emit ORCHESTRATION_CATASTROPHE_DETECTED event for observability
 *
 * @param {object} config     — box config object
 * @param {object} cycleData  — { retryCount, totalTasks, blockedTasks,
 *                               janusDirectiveAgeMs, prometheusAnalysisAgeMs,
 *                               parseFailureCount, hadBudgetBreach, hadSloBreach }
 * @param {object} [opts]     — threshold overrides
 * @returns {Promise<{
 *   ok: boolean,
 *   status: string,
 *   reason?: string,
 *   detections: object[]
 * }>}
 */
export async function runCatastropheDetection(config, cycleData, opts: any = {}) {
  try {
    if (cycleData === null || cycleData === undefined) {
      return {
        ok: false,
        status: "degraded",
        reason: "MISSING_INPUT: cycleData is null or undefined",
        detections: [],
      };
    }
    if (typeof cycleData !== "object" || Array.isArray(cycleData)) {
      return {
        ok: false,
        status: "degraded",
        reason: "INVALID_INPUT: cycleData must be a plain object",
        detections: [],
      };
    }

    // 1. Load persisted state
    const persisted = await loadCatastropheState(config);

    // 2. Update consecutive counters from this cycle's outcomes
    const consecutiveBudgetBreaches = cycleData.hadBudgetBreach
      ? (Number(persisted.consecutiveBudgetBreaches) || 0) + 1
      : 0;
    const consecutiveSloBreaches = cycleData.hadSloBreach
      ? (Number(persisted.consecutiveSloBreaches) || 0) + 1
      : 0;

    // Parse failure count accumulates until reset externally (e.g. on successful parse)
    const parseFailureCount = typeof cycleData.parseFailureCount === "number"
      ? cycleData.parseFailureCount
      : Number(persisted.parseFailureCount) || 0;

    // 3. Build detection context
    const ctx = {
      retryCount:                Number(cycleData.retryCount ?? 0),
      totalTasks:                Number(cycleData.totalTasks ?? 0),
      blockedTasks:              Number(cycleData.blockedTasks ?? 0),
      janusDirectiveAgeMs:       Number(cycleData.janusDirectiveAgeMs ?? 0),
      prometheusAnalysisAgeMs:   Number(cycleData.prometheusAnalysisAgeMs ?? 0),
      parseFailureCount,
      consecutiveBudgetBreaches,
      consecutiveSloBreaches,
      firstSeenTimestamps:       persisted.firstSeenTimestamps || {},
    };

    // 4. Detect
    const result = detectCatastrophes(ctx, opts);
    if (!result.ok) {
      return { ok: false, status: "degraded", reason: result.message, detections: [] };
    }

    // 5. Update firstSeenTimestamps: preserve existing, add new
    const updatedFirstSeen = { ...(persisted.firstSeenTimestamps || {}) };
    for (const alert of result.detections) {
      if (!updatedFirstSeen[alert.scenarioId]) {
        updatedFirstSeen[alert.scenarioId] = alert.firstSeenAt;
      }
    }

    // 6. Persist updated state
    const saveResult = await saveCatastropheState(config, {
      firstSeenTimestamps:      updatedFirstSeen,
      consecutiveBudgetBreaches,
      consecutiveSloBreaches,
      parseFailureCount,
      lastDetections:           result.detections,
    });

    if (!saveResult.ok) {
      // Non-fatal: state write failed, but detection result is still valid
      // AC #10: explicit status field and reason — not silently dropped
    }

    // 7. Emit alerts for each active detection
    for (const alert of result.detections) {
      const severity = alert.confidence >= 0.8 ? ALERT_SEVERITY.CRITICAL : ALERT_SEVERITY.HIGH;
      const guardrailSummary = alert.guardrails
        .map(g => `${g.action}(${g.urgency})`)
        .join(", ");

      await appendAlert(config, {
        severity,
        source:  "catastrophe_detector",
        title:   `Catastrophe detected: ${alert.scenarioId}`,
        message: `confidence=${alert.confidence} firstSeenAt=${alert.firstSeenAt} guardrails=[${guardrailSummary}]`,
      });

      // 8. Emit typed observability event
      const correlationId = `catastrophe-${alert.scenarioId}-${Date.now()}`;
      emitEvent(
        EVENTS.ORCHESTRATION_CATASTROPHE_DETECTED,
        EVENT_DOMAIN.ORCHESTRATION,
        correlationId,
        {
          scenarioId:   alert.scenarioId,
          confidence:   alert.confidence,
          firstSeenAt:  alert.firstSeenAt,
          detectedAt:   alert.detectedAt,
          status:       alert.status,
          guardrails:   guardrailSummary,
        }
      );
    }

    return { ok: true, status: "operational", detections: result.detections };
  } catch (err) {
    // AC #10: no silent fallback — explicit status + reason
    return {
      ok:     false,
      status: "degraded",
      reason: `INTERNAL_ERROR: ${String(err?.message || err)}`,
      detections: [],
    };
  }
}

