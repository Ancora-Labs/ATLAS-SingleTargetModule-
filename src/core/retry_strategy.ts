/**
 * retry_strategy.js — Adaptive retry strategy router for BOX.
 *
 * Replaces uniform retry behavior with per-failure-class policies that route
 * blocked/failed tasks to the correct remediation path: cooldown, rework,
 * role reassignment, task split, or escalation.
 *
 * ── Feature flag (rollback strategy) ─────────────────────────────────────────
 *   config.runtime.retryStrategy = "adaptive" | "uniform"
 *   Setting "uniform" restores legacy flat-retry behavior.
 *   Default: "adaptive"
 *
 * ── Failure class taxonomy ────────────────────────────────────────────────────
 *   Defined in failure_classifier.js as FAILURE_CLASS enum:
 *     environment   — OS/filesystem/network/infra failures
 *     policy        — Policy gate rejections, access violations
 *     verification  — Verification gate failures, rework exhausted
 *     model         — AI model errors, rate limits, quota exceeded
 *     external_api  — GitHub/external API failures
 *     logic_defect  — Code bugs, logic errors, unexpected behaviour
 *
 * ── RETRY_ACTION enum ─────────────────────────────────────────────────────────
 *   retry          — immediate retry (uniform path or low-attempt cases)
 *   cooldown_retry — wait cooldownMs, then retry (environment/model/external_api)
 *   rework         — re-dispatch with verification-backed rework instruction (logic_defect/verification)
 *   reassign       — route to a different worker role (policy, < reassignBeforeAttempt)
 *   split          — split task into sub-tasks (policy, >= splitAfterAttempt)
 *   escalate       — escalate to escalationTarget (any class when attempts exhausted)
 *
 * ── Default policy values (AC#12 / Athena missing item #2) ───────────────────
 *   environment:  cooldownMs=30min, maxRetries=3, escalationTarget="daemon_queue"
 *   logic_defect: maxReworkAttempts=2, reworkQueue="rework_queue", verificationStep="verification_gate"
 *   policy:       reassignBeforeAttempt=2, splitAfterAttempt=2, escalateAfter=3
 *   verification: maxReworkAttempts=2, reworkQueue="rework_queue", verificationStep="verification_gate"
 *   model:        cooldownMs=15min, maxRetries=3, escalationTarget="daemon_queue"
 *   external_api: cooldownMs=10min, maxRetries=3, escalationTarget="daemon_queue"
 *
 * ── Decision predicate for policy violations (AC#14 / Athena missing item #4) ─
 *   attempts < policy.reassignBeforeAttempt  → REASSIGN
 *   attempts < policy.escalateAfter          → SPLIT
 *   attempts >= policy.escalateAfter         → ESCALATE
 *
 * ── Retry state schema (AC#8 / AC#18 / Athena missing item #8) ───────────────
 *   RETRY_STATE_SCHEMA  — required fields for a persisted retry state record
 *   RETRY_METRIC_SCHEMA — required fields for a retry outcome metric record
 *
 * ── Metrics schema (AC#5 / AC#15 / Athena missing item #5) ──────────────────
 *   Named fields: schemaVersion, taskId, failureClass, retryAction, attempts,
 *   strategyUsed, cooldownMs, escalationTarget, decidedAt
 *
 * ── Validation (AC#9) ────────────────────────────────────────────────────────
 *   resolveRetryAction distinguishes missing/invalid failureClass from missing
 *   attempts with explicit RETRY_RESOLVE_REASON codes.
 *
 * ── No silent fallback (AC#10) ───────────────────────────────────────────────
 *   Invalid/unknown failureClass → ok=false with code=UNKNOWN_FAILURE_CLASS.
 *   Missing required parameters  → ok=false with code=MISSING_PARAM.
 *
 * Risk: MEDIUM — integrates into worker_runner.js (hot path). All resolveRetryAction
 *   calls are non-fatal in worker_runner — failure returns a safe RETRY decision.
 */

import { FAILURE_CLASS } from "./failure_classifier.js";

// ── Schema version ────────────────────────────────────────────────────────────

/** Integer schema version for retry state and metric records. Bump on incompatible schema change. */
export const RETRY_STRATEGY_SCHEMA_VERSION = 1;

// ── Feature flag enum ─────────────────────────────────────────────────────────

/**
 * Strategy modes for the retry router.
 *
 * adaptive — class-specific policies (new behavior, default)
 * uniform  — legacy flat retry with no class routing (rollback path)
 *
 * Rollback: set config.runtime.retryStrategy = "uniform" to restore legacy behavior.
 */
export const RETRY_STRATEGY = Object.freeze({
  ADAPTIVE: "adaptive",
  UNIFORM:  "uniform",
});

// ── Retry action enum ─────────────────────────────────────────────────────────

/**
 * Exhaustive set of retry actions returned by resolveRetryAction.
 * Every resolved retry decision receives exactly one action value from this enum.
 *
 *   retry          — immediate retry (uniform path or minimal attempt cases)
 *   cooldown_retry — wait cooldownMs before retrying (environment/model/external_api blockers)
 *   rework         — re-dispatch with verification-backed rework (logic_defect/verification)
 *   reassign       — route to a different worker role (policy violations, early attempts)
 *   split          — split task into sub-tasks (policy violations, mid-range attempts)
 *   escalate       — escalate to human or daemon queue (any class when attempts exhausted)
 */
export const RETRY_ACTION = Object.freeze({
  RETRY:          "retry",
  COOLDOWN_RETRY: "cooldown_retry",
  REWORK:         "rework",
  REASSIGN:       "reassign",
  SPLIT:          "split",
  ESCALATE:       "escalate",
});

// ── Worker step state enum ────────────────────────────────────────────────────

/**
 * Explicit step-state contract for worker execution turns.
 * Attached to retry decisions so orchestration logic can distinguish the
 * semantic reason a worker turn ended without a FINAL_OUTPUT.
 *
 *   RUN_AGAIN      — the worker completed a turn and should continue to the next
 *   HANDOFF        — the worker explicitly hands off to a downstream role
 *   FINAL_OUTPUT   — the worker produced its terminal output (done/partial/blocked)
 *   INTERRUPTION   — the worker was interrupted mid-turn (timeout, signal, error)
 */
export const WORKER_STEP_STATE = Object.freeze({
  RUN_AGAIN:    "RUN_AGAIN",
  HANDOFF:      "HANDOFF",
  FINAL_OUTPUT: "FINAL_OUTPUT",
  INTERRUPTION: "INTERRUPTION",
});

// ── Validation reason codes ───────────────────────────────────────────────────

/**
 * Machine-readable reason codes for resolveRetryAction validation failures.
 *
 * AC#9 (Athena missing item #8): distinguishes missing from invalid input.
 */
export const RETRY_RESOLVE_REASON = Object.freeze({
  /** Required parameter is null/undefined/absent. */
  MISSING_PARAM:         "MISSING_PARAM",
  /** failureClass value is not a member of FAILURE_CLASS enum. */
  UNKNOWN_FAILURE_CLASS: "UNKNOWN_FAILURE_CLASS",
  /** attempts is not a non-negative integer. */
  INVALID_ATTEMPTS:      "INVALID_ATTEMPTS",
});

/**
 * Sentinel constant indicating that runtime hook denial blocks are always
 * non-retryable. Hook denials require policy change or role-access adjustment,
 * not re-execution — the correct retry action is ESCALATE immediately.
 *
 * Consumers that detect a "runtime_hook_denied:" dispatchBlockReason should
 * short-circuit retry logic and escalate directly rather than cycling through
 * REASSIGN or SPLIT attempts.
 */
export const HOOK_DENIAL_NON_RETRYABLE = Object.freeze({
  retryAction:   "escalate",
  retryable:     false,
  reason:        "runtime_hook_denied_always_non_retryable",
  escalateAfter: 0,
});

// ── Default retry policies per failure class (AC#12) ─────────────────────────

/**
 * Default per-failure-class retry policies with concrete numeric thresholds.
 *
 * AC#12 / Athena missing item #2: All values are explicit and machine-checkable.
 *
 * cooldownMinutes  — minutes to wait before retrying (cooldown_retry actions)
 * maxRetries       — maximum retry attempts before escalating (cooldown classes)
 * maxReworkAttempts — maximum rework attempts before escalating (rework classes)
 * reassignBeforeAttempt — attempt index below which REASSIGN is chosen over SPLIT
 * splitAfterAttempt     — attempt index at/above which SPLIT is chosen over REASSIGN
 * escalateAfter    — attempt index at/above which ESCALATE is chosen
 * escalationTarget — named target for escalation (machine-readable)
 * reworkQueue      — named queue for rework dispatch (AC#13 / Athena missing item #3)
 * verificationStep — named verification step that backs rework dispatch (AC#13)
 */
export const DEFAULT_RETRY_POLICIES = Object.freeze({
  [FAILURE_CLASS.ENVIRONMENT]: Object.freeze({
    action:            RETRY_ACTION.COOLDOWN_RETRY,
    cooldownMinutes:   30,
    maxRetries:        3,
    escalateAfter:     3,
    escalationTarget:  "daemon_queue",
  }),
  [FAILURE_CLASS.LOGIC_DEFECT]: Object.freeze({
    action:            RETRY_ACTION.REWORK,
    maxReworkAttempts: 2,
    escalateAfter:     2,
    reworkQueue:       "rework_queue",
    verificationStep:  "verification_gate",
    escalationTarget:  "daemon_queue",
  }),
  [FAILURE_CLASS.POLICY]: Object.freeze({
    action:                RETRY_ACTION.REASSIGN,
    reassignBeforeAttempt: 2,
    splitAfterAttempt:     2,
    escalateAfter:         3,
    escalationTarget:      "daemon_queue",
  }),
  [FAILURE_CLASS.VERIFICATION]: Object.freeze({
    action:            RETRY_ACTION.REWORK,
    maxReworkAttempts: 2,
    escalateAfter:     2,
    reworkQueue:       "rework_queue",
    verificationStep:  "verification_gate",
    escalationTarget:  "daemon_queue",
  }),
  [FAILURE_CLASS.MODEL]: Object.freeze({
    action:           RETRY_ACTION.COOLDOWN_RETRY,
    cooldownMinutes:  15,
    maxRetries:       3,
    escalateAfter:    3,
    escalationTarget: "daemon_queue",
  }),
  [FAILURE_CLASS.EXTERNAL_API]: Object.freeze({
    action:           RETRY_ACTION.COOLDOWN_RETRY,
    cooldownMinutes:  10,
    maxRetries:       3,
    escalateAfter:    3,
    escalationTarget: "daemon_queue",
  }),
});

// ── Retry state schema (AC#8 / AC#18) ────────────────────────────────────────

/**
 * Canonical schema for a persisted retry state record.
 *
 * AC#8 / AC#18 / Athena missing item #8: required fields and explicit enums defined here.
 *
 * Required fields:
 *   schemaVersion    {number}       = RETRY_STRATEGY_SCHEMA_VERSION (1)
 *   taskId           {string|null}
 *   failureClass     {string}       — one of FAILURE_CLASS values
 *   attempts         {number}       — zero-based attempt index
 *   retryAction      {string}       — one of RETRY_ACTION values
 *   cooldownUntilMs  {number|null}  — epoch ms for cooldown expiry, or null
 *   escalationTarget {string|null}  — named escalation target, or null
 *   reworkQueue      {string|null}  — named rework queue, or null
 *   verificationStep {string|null}  — named verification step, or null
 *   strategyUsed     {string}       — one of RETRY_STRATEGY values
 *   reason           {string}       — human-readable decision rationale
 *   decidedAt        {string}       — ISO 8601 timestamp
 */
export const RETRY_STATE_SCHEMA = Object.freeze({
  schemaVersion: RETRY_STRATEGY_SCHEMA_VERSION,
  required: Object.freeze([
    "schemaVersion",
    "taskId",
    "failureClass",
    "attempts",
    "retryAction",
    "cooldownUntilMs",
    "escalationTarget",
    "reworkQueue",
    "verificationStep",
    "strategyUsed",
    "reason",
    "decidedAt",
  ]),
  retryActionEnum:    Object.freeze(Object.values(RETRY_ACTION)),
  failureClassEnum:   Object.freeze(Object.values(FAILURE_CLASS)),
  retryStrategyEnum:  Object.freeze(Object.values(RETRY_STRATEGY)),
});

// ── Retry metric schema (AC#5 / AC#15) ───────────────────────────────────────

/**
 * Canonical schema for a retry outcome metric record.
 *
 * AC#5 / AC#15 / Athena missing item #5: named fields and output artifact defined here.
 * These records are appended to state/retry_metrics.jsonl (one JSON object per line).
 *
 * Required fields:
 *   schemaVersion    {number}       = RETRY_STRATEGY_SCHEMA_VERSION (1)
 *   taskId           {string|null}
 *   failureClass     {string}       — one of FAILURE_CLASS values
 *   retryAction      {string}       — one of RETRY_ACTION values
 *   attempts         {number}
 *   strategyUsed     {string}       — one of RETRY_STRATEGY values
 *   cooldownMs       {number|null}  — cooldown duration in ms (null for non-cooldown actions)
 *   escalationTarget {string|null}
 *   decidedAt        {string}       — ISO 8601 timestamp
 */
export const RETRY_METRIC_SCHEMA = Object.freeze({
  schemaVersion: RETRY_STRATEGY_SCHEMA_VERSION,
  required: Object.freeze([
    "schemaVersion",
    "taskId",
    "failureClass",
    "retryAction",
    "attempts",
    "strategyUsed",
    "cooldownMs",
    "escalationTarget",
    "decidedAt",
  ]),
  outputArtifact: "state/retry_metrics.jsonl",
  retryActionEnum:  Object.freeze(Object.values(RETRY_ACTION)),
  failureClassEnum: Object.freeze(Object.values(FAILURE_CLASS)),
});

// ── Policy resolution helpers ─────────────────────────────────────────────────

const _VALID_FAILURE_CLASSES = new Set(Object.values(FAILURE_CLASS));

/**
 * Map a retry action to its corresponding worker step state.
 * Used to annotate resolved retry decisions with execution semantics.
 */
function _retryActionToStepState(retryAction: string): string {
  switch (retryAction) {
    case RETRY_ACTION.RETRY:
    case RETRY_ACTION.COOLDOWN_RETRY:
    case RETRY_ACTION.REWORK:
      return WORKER_STEP_STATE.RUN_AGAIN;
    case RETRY_ACTION.REASSIGN:
    case RETRY_ACTION.SPLIT:
      return WORKER_STEP_STATE.HANDOFF;
    case RETRY_ACTION.ESCALATE:
      return WORKER_STEP_STATE.INTERRUPTION;
    default:
      return WORKER_STEP_STATE.INTERRUPTION;
  }
}

/**
 * Merge config-provided adaptive retry overrides over the default policy for a class.
 * Config overrides live at config.runtime.adaptiveRetry[failureClass].
 *
 * @param {string} failureClass
 * @param {object} config
 * @returns {object} merged policy
 */
function resolvePolicy(failureClass, config) {
  const defaultPolicy = DEFAULT_RETRY_POLICIES[failureClass];
  const configOverride = config?.runtime?.adaptiveRetry?.[failureClass];
  if (!configOverride || typeof configOverride !== "object") return defaultPolicy;

  const merged = { ...defaultPolicy };
  // Only merge known numeric/string keys to prevent prototype pollution
  for (const key of Object.keys(defaultPolicy)) {
    if (Object.prototype.hasOwnProperty.call(configOverride, key)) {
      const v = configOverride[key];
      const defaultV = defaultPolicy[key];
      if (typeof v === typeof defaultV) {
        merged[key] = v;
      }
    }
  }
  // cooldownMinutes can come from config as numeric
  if (typeof configOverride.cooldownMinutes === "number") {
    merged.cooldownMinutes = configOverride.cooldownMinutes;
  }
  return merged;
}

// ── Main router ───────────────────────────────────────────────────────────────

/**
 * Resolve the retry action for a failed task based on its failure class and attempt count.
 *
 * In "adaptive" mode: routes to the class-specific policy.
 * In "uniform" mode:  always returns RETRY_ACTION.RETRY (legacy behavior).
 *
 * Decision predicate for POLICY class (AC#14 / Athena missing item #4):
 *   attempts < policy.reassignBeforeAttempt  → REASSIGN
 *   attempts < policy.escalateAfter          → SPLIT
 *   attempts >= policy.escalateAfter         → ESCALATE
 *
 * @param {string}      failureClass — one of FAILURE_CLASS values
 * @param {number}      attempts     — zero-based attempt count (0 = first failure)
 * @param {object}      [config]     — BOX config (reads runtime.retryStrategy + adaptiveRetry)
 * @param {string|null} [taskId]     — task identifier (for state/metric records)
 *
 * @returns {{ ok: true,  decision: RetryDecision } |
 *           { ok: false, code: string, field?: string, message: string }}
 *
 * RetryDecision fields (all required, per RETRY_STATE_SCHEMA):
 *   schemaVersion    {number}
 *   taskId           {string|null}
 *   failureClass     {string}
 *   attempts         {number}
 *   retryAction      {string}       — one of RETRY_ACTION values
 *   cooldownUntilMs  {number|null}  — epoch ms when cooldown expires, or null
 *   cooldownMs       {number|null}  — cooldown duration in ms, or null
 *   escalationTarget {string|null}
 *   reworkQueue      {string|null}
 *   verificationStep {string|null}
 *   strategyUsed     {string}       — "adaptive" or "uniform"
 *   reason           {string}
 *   decidedAt        {string}
 */
export function resolveRetryAction(failureClass, attempts, config = {}, taskId = null) {
  // ── Input validation (AC#9 / AC#10) ──────────────────────────────────────
  if (failureClass === null || failureClass === undefined) {
    return {
      ok: false,
      code: RETRY_RESOLVE_REASON.MISSING_PARAM,
      field: "failureClass",
      message: "failureClass is required (got null/undefined)",
    };
  }
  if (!_VALID_FAILURE_CLASSES.has(failureClass)) {
    return {
      ok: false,
      code: RETRY_RESOLVE_REASON.UNKNOWN_FAILURE_CLASS,
      field: "failureClass",
      message: `failureClass '${failureClass}' is not a valid FAILURE_CLASS value`,
    };
  }
  if (attempts === null || attempts === undefined) {
    return {
      ok: false,
      code: RETRY_RESOLVE_REASON.MISSING_PARAM,
      field: "attempts",
      message: "attempts is required (got null/undefined)",
    };
  }
  const attemptNum = Number(attempts);
  if (!Number.isInteger(attemptNum) || attemptNum < 0) {
    return {
      ok: false,
      code: RETRY_RESOLVE_REASON.INVALID_ATTEMPTS,
      field: "attempts",
      message: `attempts must be a non-negative integer; got ${JSON.stringify(attempts)}`,
    };
  }

  const decidedAt = new Date().toISOString();
  const taskIdStr = taskId != null ? String(taskId) : null;

  // ── Uniform mode (rollback path) ─────────────────────────────────────────
  const strategyMode = String((config as any)?.runtime?.retryStrategy || RETRY_STRATEGY.ADAPTIVE).toLowerCase();
  if (strategyMode === RETRY_STRATEGY.UNIFORM) {
    return {
      ok: true,
      decision: {
        schemaVersion:    RETRY_STRATEGY_SCHEMA_VERSION,
        taskId:           taskIdStr,
        failureClass,
        attempts:         attemptNum,
        retryAction:      RETRY_ACTION.RETRY,
        workerStepState:  WORKER_STEP_STATE.RUN_AGAIN,
        cooldownUntilMs:  null,
        cooldownMs:       null,
        escalationTarget: null,
        reworkQueue:      null,
        verificationStep: null,
        strategyUsed:     RETRY_STRATEGY.UNIFORM,
        reason:           "uniform retry strategy active — retrying immediately",
        decidedAt,
      },
    };
  }

  // ── Adaptive mode — resolve per-class policy ──────────────────────────────
  const policy = resolvePolicy(failureClass, config);

  let retryAction;
  let cooldownMs  = null;
  let cooldownUntilMs = null;
  // escalationTarget is always set in every adaptive branch below (no null init needed)
  let escalationTarget;
  let reworkQueue      = null;
  let verificationStep = null;
  let reason;

  // ── Environment / Model / External_API: cooldown or escalate ─────────────
  if (
    failureClass === FAILURE_CLASS.ENVIRONMENT ||
    failureClass === FAILURE_CLASS.MODEL ||
    failureClass === FAILURE_CLASS.EXTERNAL_API
  ) {
    const escalateAfter = Number(policy.escalateAfter ?? 3);
    if (attemptNum >= escalateAfter) {
      retryAction      = RETRY_ACTION.ESCALATE;
      escalationTarget = policy.escalationTarget || "daemon_queue";
      reason = `${failureClass} blocker: attempt ${attemptNum} >= escalateAfter(${escalateAfter}) — escalating to ${escalationTarget}`;
    } else {
      retryAction          = RETRY_ACTION.COOLDOWN_RETRY;
      const cooldownMinutes = Number(policy.cooldownMinutes ?? 30);
      cooldownMs           = cooldownMinutes * 60 * 1000;
      cooldownUntilMs      = Date.now() + cooldownMs;
      escalationTarget     = policy.escalationTarget || "daemon_queue";
      reason = `${failureClass} blocker: cooldown ${cooldownMinutes}min, attempt ${attemptNum}/${escalateAfter - 1} — retrying after cooldown`;
    }
  }

  // ── Logic defect / Verification: rework or escalate ──────────────────────
  else if (
    failureClass === FAILURE_CLASS.LOGIC_DEFECT ||
    failureClass === FAILURE_CLASS.VERIFICATION
  ) {
    const escalateAfter = Number(policy.escalateAfter ?? 2);
    if (attemptNum >= escalateAfter) {
      retryAction      = RETRY_ACTION.ESCALATE;
      escalationTarget = policy.escalationTarget || "daemon_queue";
      reason = `${failureClass}: rework attempts exhausted (${attemptNum} >= escalateAfter(${escalateAfter})) — escalating to ${escalationTarget}`;
    } else {
      retryAction      = RETRY_ACTION.REWORK;
      reworkQueue      = policy.reworkQueue      || "rework_queue";
      verificationStep = policy.verificationStep || "verification_gate";
      escalationTarget = policy.escalationTarget || "daemon_queue";
      reason = `${failureClass}: routing to verification-backed rework via ${reworkQueue} (step: ${verificationStep}), attempt ${attemptNum}/${escalateAfter - 1}`;
    }
  }

  // ── Policy: reassign → split → escalate (AC#14) ──────────────────────────
  else if (failureClass === FAILURE_CLASS.POLICY) {
    const reassignBefore = Number(policy.reassignBeforeAttempt ?? 2);
    const splitAfter     = Number(policy.splitAfterAttempt     ?? 2);
    const escalateAfter  = Number(policy.escalateAfter         ?? 3);
    escalationTarget     = policy.escalationTarget || "daemon_queue";

    if (attemptNum >= escalateAfter) {
      retryAction = RETRY_ACTION.ESCALATE;
      reason = `policy violation: attempt ${attemptNum} >= escalateAfter(${escalateAfter}) — escalating to ${escalationTarget}`;
    } else if (attemptNum >= splitAfter) {
      // Decision predicate: reassign exhausted → split
      retryAction = RETRY_ACTION.SPLIT;
      reason = `policy violation: attempt ${attemptNum} >= splitAfterAttempt(${splitAfter}) — splitting task`;
    } else {
      // Decision predicate: first failure(s) → reassign role
      retryAction = RETRY_ACTION.REASSIGN;
      reason = `policy violation: attempt ${attemptNum} < reassignBeforeAttempt(${reassignBefore}) — reassigning worker role`;
    }
  }

  // ── Unreachable: caught by validation above ───────────────────────────────
  else {
    // AC#10: no silent fallback — this branch should never be reached
    return {
      ok: false,
      code: RETRY_RESOLVE_REASON.UNKNOWN_FAILURE_CLASS,
      field: "failureClass",
      message: `unreachable: unhandled failureClass '${failureClass}'`,
    };
  }

  return {
    ok: true,
    decision: {
      schemaVersion:    RETRY_STRATEGY_SCHEMA_VERSION,
      taskId:           taskIdStr,
      failureClass,
      attempts:         attemptNum,
      retryAction,
      workerStepState:  _retryActionToStepState(retryAction),
      cooldownUntilMs,
      cooldownMs,
      escalationTarget: escalationTarget ?? null,
      reworkQueue,
      verificationStep,
      strategyUsed:     RETRY_STRATEGY.ADAPTIVE,
      reason,
      decidedAt,
    },
  };
}

// ── Metric persistence ────────────────────────────────────────────────────────

/**
 * Build a retry metric record from a resolved retry decision.
 *
 * AC#5 / AC#15 / Athena missing item #5: produces a machine-readable metric
 * conforming to RETRY_METRIC_SCHEMA. The caller persists this to
 * state/retry_metrics.jsonl (one JSON per line).
 *
 * @param {object} decision — RetryDecision from resolveRetryAction
 * @returns {object} metric record conforming to RETRY_METRIC_SCHEMA
 */
export function buildRetryMetric(decision) {
  return {
    schemaVersion:    RETRY_STRATEGY_SCHEMA_VERSION,
    taskId:           decision.taskId ?? null,
    failureClass:     decision.failureClass,
    retryAction:      decision.retryAction,
    attempts:         decision.attempts,
    strategyUsed:     decision.strategyUsed,
    cooldownMs:       decision.cooldownMs ?? null,
    escalationTarget: decision.escalationTarget ?? null,
    decidedAt:        decision.decidedAt,
  };
}

/**
 * Recommend deliberation mode for a retry path.
 * Keeps routine retries single-pass while escalating complex retries to
 * bounded multi-attempt mode.
 */
export function recommendRetryDeliberationMode(decision: {
  retryAction?: string;
  failureClass?: string;
  attempts?: number;
}) {
  const action = String(decision?.retryAction || "");
  const failureClass = String(decision?.failureClass || "");
  const attempts = Number(decision?.attempts || 0);
  const hardAction = action === RETRY_ACTION.REWORK || action === RETRY_ACTION.SPLIT;
  const highAttempts = attempts >= 1;

  const candidateFirstMoves = hardAction
    ? [
        {
          key: "retry_artifact_review",
          summary: "Inspect the last failure artifact and identify the smallest reversible correction.",
          rationale: `Retry action ${action} indicates the next pass should start from explicit failure evidence.`,
          cheapSignals: [
            failureClass ? `failureClass=${failureClass}` : "failure evidence available",
            `retryAction=${action}`,
          ],
          score: 0.9,
        },
        {
          key: "targeted_retry_verification",
          summary: "Re-run the narrowest verification slice that can confirm the retry path.",
          rationale: "Cheap verification should validate the next move before the worker spends another deep pass.",
          cheapSignals: [`attempt=${attempts + 1}`, "bounded retry verification"],
          score: 0.82,
        },
      ]
    : highAttempts
      ? [
          {
            key: "retry_surface_map",
            summary: "Map the failure surface before repeating the same execution path.",
            rationale: "A repeated attempt should narrow scope instead of replaying the full path blindly.",
            cheapSignals: [`attempt=${attempts + 1}`, "single focused repository search"],
            score: 0.74,
          },
        ]
      : [];

  if (hardAction || highAttempts) {
    return {
      mode: "multi-attempt",
      reflection: true,
      searchBudget: hardAction ? 2 : 1,
      uncertaintyLevel: hardAction ? "high" : "moderate",
      candidateFirstMoves,
      recommendedFirstMove: candidateFirstMoves[0] ?? null,
    };
  }

  return {
    mode: "single-pass",
    reflection: false,
    searchBudget: 0,
    uncertaintyLevel: "low",
    candidateFirstMoves: [],
    recommendedFirstMove: null,
  };
}

// ── Retry ROI gate ────────────────────────────────────────────────────────────

/**
 * Apply a retry ROI gate to a resolved retry decision.
 *
 * When the ROI signal indicates that another retry attempt is not economically
 * worthwhile (`allowRetry=false`), any retryable action (retry, cooldown_retry,
 * rework) is overridden to ESCALATE so that the orchestrator stops consuming
 * premium budget on diminishing-return retries.
 *
 * Non-retryable actions (escalate, reassign, split) are always passed through
 * unchanged — they are already directing work away from the current worker.
 *
 * @param decision  — resolved retry decision from resolveRetryAction
 * @param retryROI  — ROI signal from assessRetryExpectedROI
 * @returns decision with retryAction potentially overridden to ESCALATE
 */
export function applyRetryROIGate(
  decision: { retryAction: string; reason: string; [key: string]: unknown },
  retryROI: { allowRetry: boolean; expectedGain: number; threshold: number; reason: string },
): { retryAction: string; reason: string; roiGateApplied: boolean; [key: string]: unknown } {
  const passThrough = [RETRY_ACTION.ESCALATE, RETRY_ACTION.REASSIGN, RETRY_ACTION.SPLIT];
  if (retryROI.allowRetry || passThrough.includes(decision.retryAction as any)) {
    return { ...decision, roiGateApplied: false };
  }
  return {
    ...decision,
    retryAction: RETRY_ACTION.ESCALATE,
    reason: `${decision.reason} [roi-gate: allowRetry=false expectedGain=${retryROI.expectedGain.toFixed(3)} threshold=${retryROI.threshold.toFixed(3)} reason=${retryROI.reason}]`,
    roiGateApplied: true,
  };
}

export interface RetrySignalTuningInput {
  promptCacheHitRate?: number;
  promptCacheSavedTokens?: number;
  retryExpectedGain?: number;
  retryThreshold?: number;
  lowRoiSignalCount?: number;
  latestFailureClass?: string | null;
  latestFinishCode?: string | null;
}

function clampCooldownMs(value: number): number {
  const rounded = Math.round(value / 60_000) * 60_000;
  return Math.max(60_000, Math.min(24 * 60 * 60 * 1000, rounded));
}

export function applyRetrySignalTuning(
  decision: { retryAction: string; cooldownMs?: number | null; cooldownUntilMs?: number | null; reason: string; failureClass?: string | null; [key: string]: unknown },
  tuning: RetrySignalTuningInput = {},
): { cooldownTuning: string; retryAction: string; reason: string; [key: string]: unknown } {
  const baseCooldownMs = Number(decision.cooldownMs);
  if (decision.retryAction !== RETRY_ACTION.COOLDOWN_RETRY || !Number.isFinite(baseCooldownMs) || baseCooldownMs <= 0) {
    return { ...decision, cooldownTuning: "none" };
  }
  const promptCacheHitRate = Number.isFinite(Number(tuning.promptCacheHitRate))
    ? Math.max(0, Math.min(1, Number(tuning.promptCacheHitRate)))
    : 0;
  const promptCacheSavedTokens = Number.isFinite(Number(tuning.promptCacheSavedTokens))
    ? Math.max(0, Math.round(Number(tuning.promptCacheSavedTokens)))
    : 0;
  const retryExpectedGain = Number.isFinite(Number(tuning.retryExpectedGain))
    ? Math.max(0, Number(tuning.retryExpectedGain))
    : null;
  const retryThreshold = Number.isFinite(Number(tuning.retryThreshold))
    ? Math.max(0, Number(tuning.retryThreshold))
    : null;
  const lowRoiSignalCount = Math.max(0, Math.floor(Number(tuning.lowRoiSignalCount || 0)));
  const latestFailureClass = String(tuning.latestFailureClass || decision.failureClass || "").trim().toLowerCase();
  const latestFinishCode = String(tuning.latestFinishCode || "").trim().toLowerCase();
  let multiplier = 1;
  const reasons: string[] = [];
  if (promptCacheHitRate >= 0.60 || promptCacheSavedTokens >= 180) {
    multiplier -= 0.25;
    reasons.push("cache-cheap");
  }
  if (retryExpectedGain !== null && retryThreshold !== null && retryExpectedGain > retryThreshold + 0.12) {
    multiplier -= 0.10;
    reasons.push("retry-roi-strong");
  }
  if (retryExpectedGain !== null && retryThreshold !== null && retryExpectedGain < retryThreshold) {
    multiplier += 0.35;
    reasons.push("retry-roi-weak");
  }
  if (lowRoiSignalCount > 0) {
    multiplier += Math.min(0.45, lowRoiSignalCount * 0.15);
    reasons.push(`lineage-low-roi=${lowRoiSignalCount}`);
  }
  if (
    latestFailureClass === FAILURE_CLASS.MODEL
    || latestFailureClass === FAILURE_CLASS.EXTERNAL_API
    || /rate|quota|429|503|timeout|provider/.test(latestFinishCode)
  ) {
    multiplier += 0.25;
    reasons.push("provider-backoff");
  } else if (
    latestFailureClass === FAILURE_CLASS.ENVIRONMENT
    || /network|filesystem|permission|dns|infra/.test(latestFinishCode)
  ) {
    multiplier += 0.15;
    reasons.push("environment-backoff");
  }
  const nextCooldownMs = clampCooldownMs(baseCooldownMs * Math.max(0.5, Math.min(2.5, multiplier)));
  if (nextCooldownMs === baseCooldownMs) {
    return { ...decision, cooldownTuning: reasons.join("+") || "none" };
  }
  return {
    ...decision,
    cooldownMs: nextCooldownMs,
    cooldownUntilMs: Date.now() + nextCooldownMs,
    cooldownTuning: reasons.join("+") || "adjusted",
    reason: `${decision.reason} [cooldown-tuned: ${reasons.join(", ") || "adjusted"} -> ${Math.round(nextCooldownMs / 60_000)}min]`,
  };
}

// ── Per-step retryability class ───────────────────────────────────────────────

/**
 * Canonical classification of pipeline steps by their retryability semantics.
 *
 * Each orchestration step belongs to exactly one class:
 *
 *   retryable       — step can be fully retried with preserved state
 *                     (e.g. worker_execution, rework_dispatch)
 *   idempotent      — re-running produces the same result; safe to repeat
 *                     (e.g. checkpoint_write)
 *   non_retryable   — step must not be retried without an explicit rework
 *                     instruction from the verification gate
 *                     (e.g. verification, artifact_gate, policy_gate)
 *   cancellable     — step must abort immediately on a cancellation signal;
 *                     no retry is meaningful
 *                     (e.g. cancellation_check)
 *
 * Consumers query this enum via classifyStepRetryClass(stepName).
 */
export const STEP_RETRY_CLASS = Object.freeze({
  RETRYABLE:     "retryable",
  IDEMPOTENT:    "idempotent",
  NON_RETRYABLE: "non_retryable",
  CANCELLABLE:   "cancellable",
} as const);

export type StepRetryClass = typeof STEP_RETRY_CLASS[keyof typeof STEP_RETRY_CLASS];

/**
 * Authoritative step-name → STEP_RETRY_CLASS mapping.
 *
 * Step names are lowercase_snake_case strings used in log telemetry, span events,
 * and retry routing.  When a step name is unrecognised the function falls back to
 * RETRYABLE (fail-open) and sets `known: false` so callers can emit a warning.
 */
const _STEP_RETRY_CLASS_MAP: Readonly<Record<string, StepRetryClass>> = Object.freeze({
  worker_execution:   STEP_RETRY_CLASS.RETRYABLE,
  rework_dispatch:    STEP_RETRY_CLASS.RETRYABLE,
  checkpoint_write:   STEP_RETRY_CLASS.IDEMPOTENT,
  verification:       STEP_RETRY_CLASS.NON_RETRYABLE,
  artifact_gate:      STEP_RETRY_CLASS.NON_RETRYABLE,
  policy_gate:        STEP_RETRY_CLASS.NON_RETRYABLE,
  cancellation_check: STEP_RETRY_CLASS.CANCELLABLE,
});

/**
 * Classify a named pipeline step by its retryability semantics.
 *
 * @param stepName — canonical step name (e.g. "worker_execution", "verification")
 * @returns { class: StepRetryClass, known: boolean }
 *   `known=false` means the name was not in the map; class defaults to RETRYABLE.
 */
export function classifyStepRetryClass(stepName: string): { class: StepRetryClass; known: boolean } {
  const normalized = String(stepName || "").toLowerCase().trim();
  const cls = _STEP_RETRY_CLASS_MAP[normalized];
  if (cls !== undefined) return { class: cls, known: true };
  return { class: STEP_RETRY_CLASS.RETRYABLE, known: false };
}

// ── State persistence helpers ─────────────────────────────────────────────────

import path from "node:path";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";

/**
 * Append a retry metric record to state/retry_metrics.jsonl (one JSON per line).
 *
 * Non-fatal: errors are caught and never propagate to callers.
 *
 * AC#5 / AC#15: output artifact path is RETRY_METRIC_SCHEMA.outputArtifact.
 *
 * @param {object} config
 * @param {object} decision — RetryDecision from resolveRetryAction
 */
export function persistRetryMetric(config, decision) {
  try {
    const stateDir = config?.paths?.stateDir || "state";
    const metricsPath = path.join(stateDir, "retry_metrics.jsonl");
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    const metric = buildRetryMetric(decision);
    appendFileSync(metricsPath, JSON.stringify(metric) + "\n", "utf8");
  } catch {
    // Non-fatal: metric persistence must never block orchestration
  }
}

// ── Typed attempt-policy contract ─────────────────────────────────────────────

/**
 * Typed per-failure-class attempt-policy contract.
 * Resolved once per attempt and included in every AttemptArtifact for full
 * traceability of what policy thresholds governed the retry decision.
 */
export interface AttemptPolicyContract {
  failureClass: string;
  attempts: number;
  action: string;
  cooldownMinutes?: number;
  maxRetries?: number;
  maxReworkAttempts?: number;
  reassignBeforeAttempt?: number;
  splitAfterAttempt?: number;
  escalateAfter: number;
  escalationTarget: string;
  reworkQueue?: string;
  verificationStep?: string;
  resolvedAt: string;
}

/** Schema version for AttemptArtifact records. */
export const ATTEMPT_ARTIFACT_SCHEMA_VERSION = 1 as const;

/**
 * Typed per-attempt outcome artifact produced deterministically after each attempt.
 * Captures the outcome, failure class, retry decision, and the concrete policy
 * that was applied so the learning loop can retrieve and compare class-specific history.
 */
export interface AttemptArtifact {
  schemaVersion: typeof ATTEMPT_ARTIFACT_SCHEMA_VERSION;
  runId: string;
  attempt: number;
  taskId: string | null;
  failureClass: string | null;
  retryAction: string | null;
  policyApplied: AttemptPolicyContract | null;
  decidedAt: string;
  firstAttemptAt: string;
  outcome: string;
  phaseRetryState: Record<string, unknown> | null;
}

/**
 * Build a deterministic AttemptArtifact from the attempt's resolved retry decision.
 *
 * Produces a compact, typed record per attempt that:
 *   - links attempt lineage via runId and attempt number
 *   - captures the primary routing keys (failureClass, retryAction)
 *   - carries the numeric thresholds actually applied (policyApplied)
 *   - records the terminal worker status (outcome)
 *
 * @param runId          - short hex run identifier
 * @param attempt        - zero-based attempt index
 * @param taskId         - task identifier, or null
 * @param outcome        - terminal worker status (done/partial/blocked/error)
 * @param failureClass   - failure class from classifyFailure, or null
 * @param retryDecision  - resolved retry decision from resolveRetryAction, or null
 * @param firstAttemptAt - ISO timestamp of the first attempt in this lineage
 * @param phaseRetryState - structured phase-aware retry state captured for the attempt
 * @returns AttemptArtifact conforming to ATTEMPT_ARTIFACT_SCHEMA_VERSION
 */
export function buildAttemptArtifact(
  runId: string,
  attempt: number,
  taskId: string | null,
  outcome: string,
  failureClass: string | null,
  retryDecision: { retryAction?: string; [key: string]: unknown } | null,
  firstAttemptAt: string,
  phaseRetryState: Record<string, unknown> | null = null,
): AttemptArtifact {
  const decidedAt = new Date().toISOString();
  let policyApplied: AttemptPolicyContract | null = null;

  if (failureClass && Object.prototype.hasOwnProperty.call(DEFAULT_RETRY_POLICIES, failureClass)) {
    try {
      const policy = DEFAULT_RETRY_POLICIES[failureClass] as Record<string, unknown>;
      policyApplied = {
        failureClass,
        attempts: attempt,
        action:                   String(policy.action || ""),
        cooldownMinutes:          typeof policy.cooldownMinutes === "number" ? policy.cooldownMinutes : undefined,
        maxRetries:               typeof policy.maxRetries === "number" ? policy.maxRetries : undefined,
        maxReworkAttempts:        typeof policy.maxReworkAttempts === "number" ? policy.maxReworkAttempts : undefined,
        reassignBeforeAttempt:    typeof policy.reassignBeforeAttempt === "number" ? policy.reassignBeforeAttempt : undefined,
        splitAfterAttempt:        typeof policy.splitAfterAttempt === "number" ? policy.splitAfterAttempt : undefined,
        escalateAfter:            Number(policy.escalateAfter ?? 3),
        escalationTarget:         String(policy.escalationTarget || "daemon_queue"),
        reworkQueue:              typeof policy.reworkQueue === "string" ? policy.reworkQueue : undefined,
        verificationStep:         typeof policy.verificationStep === "string" ? policy.verificationStep : undefined,
        resolvedAt:               decidedAt,
      };
    } catch {
      // policyApplied remains null if lookup fails — artifact is still useful
    }
  }

  return {
    schemaVersion:  ATTEMPT_ARTIFACT_SCHEMA_VERSION,
    runId:          String(runId || ""),
    attempt:        Number(attempt),
    taskId:         taskId != null ? String(taskId) : null,
    failureClass:   failureClass ?? null,
    retryAction:    retryDecision?.retryAction ? String(retryDecision.retryAction) : null,
    policyApplied,
    decidedAt,
    firstAttemptAt: String(firstAttemptAt || decidedAt),
    outcome:        String(outcome || "unknown"),
    phaseRetryState: phaseRetryState && typeof phaseRetryState === "object"
      ? { ...phaseRetryState }
      : null,
  };
}
