/**
 * Athena — Quality Gate & Postmortem Reviewer
 *
 * Athena is called at two points in every cycle:
 *
 *   1. PRE-WORK (Plan Review): After Prometheus produces a plan,
 *      Athena validates it: "Is the goal measurable? Are success criteria clear?
 *      Are acceptance tests defined?" If not, she rejects it back to Prometheus.
 *
 *   2. POST-WORK (Postmortem): After a worker finishes (merge/PR),
 *      Athena runs a short postmortem: "What was expected? What actually happened?
 *      What did we learn?" She records lessons for future cycles.
 *
 * Athena uses exactly 1 premium request per invocation (single-prompt, no autopilot).
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { readJson, writeJson, spawnAsync } from "./fs_utils.js";
import { appendProgress, appendAlert, ALERT_SEVERITY } from "./state_tracker.js";
import { getRoleRegistry, getLaneForWorkerName } from "./role_registry.js";
import { buildAgentArgs, parseAgentOutput, logAgentThinking } from "./agent_loader.js";
import { chatLog } from "./logger.js";
import { rankLessonsByRelevance } from "./lesson_halflife.js";
import { detectRecurrences } from "./recurrence_detector.js";
import {
  addSchemaVersion,
  extractPostmortemEntries,
  migrateData,
  recordMigrationTelemetry,
  STATE_FILE_TYPE,
  MIGRATION_REASON,
  backfillDecisionQualityLabel,
} from "./schema_registry.js";
import {
  AUTONOMY_EXECUTION_GATE_REASON_CODE,
  resolveAutonomyExecutionGateBlockReason,
} from "./governance_contract.js";
import {
  validateLeadershipContract,
  LEADERSHIP_CONTRACT_TYPE,
  TRUST_BOUNDARY_ERROR,
} from "./trust_boundary.js";
import { checkForbiddenCommands, normalizeCommandBatch } from "./verification_command_registry.js";
import { buildWorkerExecutionReportArtifact, validateEvidenceEnvelope } from "./evidence_envelope.js";
import type { DispatchContractSnapshot, EvidenceEnvelope } from "./evidence_envelope.js";
import { isEnvelopeUnambiguous } from "./evidence_envelope.js";
import {
  buildAthenaReviewFindingArtifact,
  derivePlanContinuationFamilyKey,
  extractImplementationEvidencePaths,
  getPrometheusPlanArtifact,
  normalizePlanIdentity,
  POSTMORTEM_LIFECYCLE_STATE,
} from "./plan_lifecycle_contract.js";
import type { PostmortemLifecycleEvidenceEnvelope } from "./plan_lifecycle_contract.js";
import { buildTaskFingerprint } from "./lineage_graph.js";
import {
  loadLedgerMeta,
  autoCloseVerifiedDebt,
  saveLedgerFull,
  compressLedger,
  shouldBlockOnDebt,
} from "./carry_forward_ledger.js";
import { isFreezeActive } from "./governance_freeze.js";
import { isGovernanceCanaryBreachActive } from "./governance_canary.js";
import { readForceCheckpointValidationContract } from "./guardrail_executor.js";
import { isSloCascadingBreachScenario } from "./catastrophe_detector.js";
import {
  estimatePlanTokens as _estimatePlanTokens,
  getUsableModelContextTokens as _getUsableModelContextTokens,
} from "./worker_batch_planner.js";
import { buildSpanEvent, EVENTS, EVENT_DOMAIN, SPAN_CONTRACT } from "./event_schema.js";
import { buildPromptAssemblyPrompt, resolvePromptTargetRepo } from "./prompt_overlay.js";

// ── Span contract emitter ─────────────────────────────────────────────────────

/** Canonical agent identifier for Athena in span events. */
export const ATHENA_AGENT_ID = "athena";
const ATHENA_PLAN_REVIEW_TIMEOUT_MS = 12 * 60 * 1000;
const ATHENA_REVIEW_HEARTBEAT_MS = 60_000;

/**
 * Reason codes emitted by the deterministic auto-approve (fast-path) gate.
 * Exported so callers can track fast-path telemetry without string literals.
 *
 * @enum {string}
 */
export const ATHENA_FAST_PATH_REASON = Object.freeze({
  /**
   * All plans are low-risk and the batch fingerprint matches the last approved review.
   * The AI review call was skipped and the cached result was returned.
   */
  LOW_RISK_UNCHANGED: "LOW_RISK_UNCHANGED",
  /**
   * All plans are low-risk and every plan scores at or above the high-quality threshold
   * in the deterministic quality pre-gate.  The AI review call was skipped.
   * Requires no prior cached fingerprint — high plan quality is sufficient evidence.
   */
  HIGH_QUALITY_LOW_RISK: "HIGH_QUALITY_LOW_RISK",
  /**
   * All plans are low-risk and every plan scores at or above the delta-review threshold.
   * A prior cached review exists but the fingerprint changed (i.e. the batch changed).
   * The AI review call is skipped because the delta does not rise to material risk.
   * Reserves full AI review capacity for genuinely changed or high-risk packets.
   */
  DELTA_REVIEW_APPROVED: "DELTA_REVIEW_APPROVED",
  /**
   * Main CI is green and all stale automated PR debt is already in a terminal
   * state (applyState === "superseded" | "applied").  Worker dispatch is skipped
   * and the cycle is closed via the stale-artifact closure fastpath.
   */
  STALE_SUPERSEDED_CI_GREEN: "STALE_SUPERSEDED_CI_GREEN",
} as const);

function stampAthenaArtifactTargetSession(config: any, artifact: any): any {
  if (!artifact || typeof artifact !== "object") return artifact;

  if (
    config?.platformModeState?.currentMode !== "single_target_delivery"
    || !config?.activeTargetSession?.sessionId
  ) {
    if (artifact.targetSession) {
      delete artifact.targetSession;
    }
    return artifact;
  }

  artifact.targetSession = {
    projectId: config.activeTargetSession.projectId,
    sessionId: config.activeTargetSession.sessionId,
    currentStage: config.activeTargetSession.currentStage,
    repoUrl: config.activeTargetSession.repo?.repoUrl || null,
  };
  return artifact;
}

export function isAthenaReviewAlignedToTargetSession(config: any, review: any): boolean {
  const runtimeSingleTarget = config?.platformModeState?.currentMode === "single_target_delivery"
    && Boolean(config?.activeTargetSession?.sessionId);
  const reviewTargetSession = review?.targetSession && typeof review.targetSession === "object"
    ? review.targetSession
    : null;

  if (!runtimeSingleTarget) {
    return !reviewTargetSession;
  }
  if (!reviewTargetSession) {
    return false;
  }

  return String(reviewTargetSession.projectId || "") === String(config?.activeTargetSession?.projectId || "")
    && String(reviewTargetSession.sessionId || "") === String(config?.activeTargetSession?.sessionId || "");
}

// ── Deterministic plan-batch fingerprinting ───────────────────────────────────

/**
 * Compute a stable 16-hex-char fingerprint of a plan batch.
 *
 * Only semantic fields that define plan intent are hashed (task, role, wave,
 * riskLevel, verification, acceptance_criteria). Runtime metadata
 * (analyzedAt, owner, etc.) is excluded so that re-runs with the same
 * logical plan batch produce the same fingerprint.
 *
 * Used by the auto-approve path: if the batch is unchanged and all plans
 * are low-risk, AI review can be skipped when the last review was approved.
 */
export function computePlanBatchFingerprint(plans: any[]): string {
  if (!Array.isArray(plans) || plans.length === 0) return "";
  const stableFields = plans.map(p => ({
    task: String(p.task || "").trim(),
    role: String(p.role || "").trim(),
    wave: Number(p.wave) || 1,
    riskLevel: String(p.riskLevel || "low").trim().toLowerCase(),
    verification: String(p.verification || "").trim(),
    acceptance_criteria: (Array.isArray(p.acceptance_criteria) ? p.acceptance_criteria : [])
      .map((c: any) => String(c || "").trim())
      .filter(Boolean)
      .sort(),
  }));
  const serialized = JSON.stringify(stableFields);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

function resolveAthenaPlanReviewTimeoutMs(config): number {
  const raw = Number(
    config?.runtime?.athenaPlanReviewTimeoutMs
    ?? config?.runtime?.athenaReviewTimeoutMs
    ?? ATHENA_PLAN_REVIEW_TIMEOUT_MS
  );
  if (!Number.isFinite(raw) || raw <= 0) {
    return ATHENA_PLAN_REVIEW_TIMEOUT_MS;
  }
  return Math.floor(raw);
}

function resolveAthenaReviewHeartbeatMs(config): number {
  const raw = Number(config?.runtime?.athenaReviewHeartbeatMs ?? ATHENA_REVIEW_HEARTBEAT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return ATHENA_REVIEW_HEARTBEAT_MS;
  }
  return Math.floor(raw);
}

/**
 * Build a PLANNING_STAGE_TRANSITION span event for Athena.
 * Conforms to SPAN_CONTRACT: stamps spanId, parentSpanId, traceId, agentId.
 *
 * @param correlationId — non-empty cycle trace ID
 * @param stageFrom     — stage being left (one of ORCHESTRATION_LOOP_STEPS)
 * @param stageTo       — stage being entered
 * @param opts          — optional parentSpanId, durationMs
 * @returns validated event envelope
 */
export function emitAthenaSpanTransition(
  correlationId: string,
  stageFrom: string,
  stageTo: string,
  opts: { parentSpanId?: string | null; durationMs?: number | null } = {},
) {
  return buildSpanEvent(
    EVENTS.PLANNING_STAGE_TRANSITION,
    EVENT_DOMAIN.PLANNING,
    correlationId,
    { agentId: ATHENA_AGENT_ID, parentSpanId: opts.parentSpanId ?? null },
    {
      [SPAN_CONTRACT.stageTransition.taskId]:     null,
      [SPAN_CONTRACT.stageTransition.stageFrom]:  stageFrom,
      [SPAN_CONTRACT.stageTransition.stageTo]:    stageTo,
      [SPAN_CONTRACT.stageTransition.durationMs]: opts.durationMs ?? null,
    },
  );
}

/**
 * Build a PLANNING_TASK_DROPPED span event for Athena (plan rejection path).
 * Conforms to SPAN_CONTRACT.dropReason.
 *
 * @param correlationId  — non-empty cycle trace ID
 * @param taskId         — identifier of the dropped task/plan
 * @param reason         — human-readable rejection reason
 * @param dropCode       — machine code from SPAN_CONTRACT.dropCodes (defaults to ATHENA_REJECTED)
 * @param opts           — optional parentSpanId, stageWhenDropped
 * @returns validated event envelope
 */
export function emitAthenaSpanDrop(
  correlationId: string,
  taskId: string,
  reason: string,
  dropCode: string = SPAN_CONTRACT.dropCodes.ATHENA_REJECTED,
  opts: { parentSpanId?: string | null; stageWhenDropped?: string } = {},
) {
  return buildSpanEvent(
    EVENTS.PLANNING_TASK_DROPPED,
    EVENT_DOMAIN.PLANNING,
    correlationId,
    { agentId: ATHENA_AGENT_ID, parentSpanId: opts.parentSpanId ?? null },
    {
      [SPAN_CONTRACT.dropReason.taskId]:           taskId,
      [SPAN_CONTRACT.dropReason.stageWhenDropped]: opts.stageWhenDropped ?? "athena_reviewing",
      [SPAN_CONTRACT.dropReason.reason]:           reason,
      [SPAN_CONTRACT.dropReason.dropCode]:         dropCode,
    },
  );
}

// ── Rubric calibration ───────────────────────────────────────────────────────

/**
 * Taxonomy of rationale classes used in Athena plan review and calibration.
 *
 * Positive classes signal plan quality indicators.
 * Negative classes signal plan deficiency indicators.
 *
 * These values are used in calibration fixtures (expectedRationaleClasses) and in
 * the heuristic scoring function (scoreCalibrationPlan). New values must be added
 * here before being referenced in fixtures or tests.
 *
 * @enum {string}
 */
export const RATIONALE_CLASS = Object.freeze({
  // ── Positive (plan quality indicators) ────────────────────────────────────
  /** Goal expressed in measurable, observable terms */
  MEASURABLE_GOAL:          "MEASURABLE_GOAL",
  /** Success criterion is explicit and unambiguous */
  CLEAR_SUCCESS_CRITERION:  "CLEAR_SUCCESS_CRITERION",
  /** Verification uses a concrete command, test, or check */
  CONCRETE_VERIFICATION:    "CONCRETE_VERIFICATION",
  /** Files, modules, or boundaries are explicitly named */
  SCOPE_DEFINED:            "SCOPE_DEFINED",
  /** Wave/dependency ordering is correct and consistent */
  DEPENDENCY_CORRECT:       "DEPENDENCY_CORRECT",
  // ── Negative (plan deficiency indicators) ─────────────────────────────────
  /** Goal uses vague language (e.g. "improve", "refactor" without specifics) */
  VAGUE_GOAL:               "VAGUE_GOAL",
  /** No verification command, test, or check is provided */
  NO_VERIFICATION:          "NO_VERIFICATION",
  /** No files, modules, or boundaries are specified */
  MISSING_SCOPE:            "MISSING_SCOPE",
  /** Required fields are absent or incomplete */
  SPEC_INCOMPLETE:          "SPEC_INCOMPLETE",
  /** Wave ordering creates circular or contradictory dependencies */
  CIRCULAR_DEPENDENCY:      "CIRCULAR_DEPENDENCY"
});

export const ATHENA_PLAN_REVIEW_REASON_CODE = Object.freeze({
  NO_PLAN_PROVIDED: "NO_PLAN_PROVIDED",
  AI_CALL_FAILED: "AI_CALL_FAILED",
  LOW_PLAN_QUALITY: "LOW_PLAN_QUALITY",
  MISSING_PREMORTEM: "MISSING_PREMORTEM",
  MISSING_ACTIONABLE_PACKET_FIELDS: "MISSING_ACTIONABLE_PACKET_FIELDS",
  MALFORMED_DECISION_PACKET: "MALFORMED_DECISION_PACKET",
  SCORE_CONTRACT_VIOLATION: "SCORE_CONTRACT_VIOLATION",
  TRUST_BOUNDARY_VIOLATION: "TRUST_BOUNDARY_VIOLATION",
  PATCHED_PLAN_VALIDATION_FAILED: "PATCHED_PLAN_VALIDATION_FAILED",
  ATHENA_BATCH_METADATA_MISSING: "ATHENA_BATCH_METADATA_MISSING",
  REVIEW_EXCEPTION: "REVIEW_EXCEPTION",
  ACTIVE_GOVERNANCE_GATE_INFEASIBLE: "ACTIVE_GOVERNANCE_GATE_INFEASIBLE",
  /** One or more mandatory health-audit findings (critical/important) are not covered by the plan. */
  MANDATORY_COVERAGE_INCOMPLETE: "MANDATORY_COVERAGE_INCOMPLETE",
  /** One or more patchedPlan dependencies carry an unresolved cross-cycle pre-condition. */
  CROSS_CYCLE_DEPENDENCY_UNRESOLVED: "CROSS_CYCLE_DEPENDENCY_UNRESOLVED",
});

/** Set of all valid RATIONALE_CLASS values for O(1) lookup. */
export const VALID_RATIONALE_CLASSES = new Set(Object.values(RATIONALE_CLASS));

/**
 * Score categories used in calibration deviation calculation.
 * Maps a numeric heuristic score [0–10] to a verdict category.
 *
 * Formula: score ≥ 7 → "approved" | score ≤ 3 → "rejected" | else → "ambiguous"
 * Range: [0.0, 1.0], unit: fraction (0.0 = no drift, 1.0 = complete drift)
 *
 * @enum {string}
 */
export const CALIBRATION_VERDICT = Object.freeze({
  APPROVED:  "approved",
  AMBIGUOUS: "ambiguous",
  REJECTED:  "rejected"
});

/**
 * Derive the verdict category from a numeric heuristic score.
 * Score thresholds: ≥7 → approved, ≤3 → rejected, 4–6 → ambiguous.
 *
 * @param {number} score - integer 0–10
 * @returns {string} - a CALIBRATION_VERDICT value
 */
export function verdictFromScore(score) {
  if (score >= 7) return CALIBRATION_VERDICT.APPROVED;
  if (score <= 3) return CALIBRATION_VERDICT.REJECTED;
  return CALIBRATION_VERDICT.AMBIGUOUS;
}

/** Words in a task description that signal vague/non-measurable goals. */
const VAGUE_TASK_PATTERNS = [
  /\bimprove\b/i,
  /\brefactor\b(?!\s+\w+\s+to\b)/i,
  /\bclean\s+up\b/i,
  /\benhance\b/i,
  /\boptimize\b(?!\s+[\w.]+\s+from\b)/i,
  /\bfix\s+(the\s+)?codebase\b/i
];

/**
 * Apply heuristic scoring to a single calibration fixture.
 *
 * Scoring rubric (deterministic, no AI):
 *   +2  task field is present, non-empty, and contains no vague patterns
 *   +2  verification field is present, non-empty, and is a concrete command
 *   +2  files array is non-empty (scope defined)
 *   +2  context field describes measurable success criterion (≥20 chars with criterion words)
 *   +1  priority and wave are both defined integers
 *   +1  task mentions a specific file path or function name
 *
 * Total: 0–10. Category: ≥7 → approved, ≤3 → rejected, 4–6 → ambiguous.
 *
 * Returns the assigned rationale classes alongside the numeric score.
 *
 * @param {object} fixture - parsed calibration fixture (schemaVersion 1)
 * @returns {{ score: number, scoreCategory: string, rationaleClasses: string[] }}
 */
export function scoreCalibrationPlan(fixture) {
  if (!fixture || typeof fixture !== "object") {
    return { score: 0, scoreCategory: CALIBRATION_VERDICT.REJECTED, rationaleClasses: [RATIONALE_CLASS.SPEC_INCOMPLETE] };
  }
  const plan = fixture.plan || {};
  const classes = [];
  let score = 0;

  // ── Task quality ──────────────────────────────────────────────────────────
  const task = typeof plan.task === "string" ? plan.task.trim() : "";
  if (task.length > 0) {
    const isVague = VAGUE_TASK_PATTERNS.some(p => p.test(task)) && task.length < 80;
    if (isVague) {
      classes.push(RATIONALE_CLASS.VAGUE_GOAL);
    } else {
      classes.push(RATIONALE_CLASS.MEASURABLE_GOAL);
      score += 2;
    }
  } else {
    classes.push(RATIONALE_CLASS.VAGUE_GOAL);
    classes.push(RATIONALE_CLASS.SPEC_INCOMPLETE);
  }

  // ── Verification ─────────────────────────────────────────────────────────
  const verification = typeof plan.verification === "string" ? plan.verification.trim() : "";
  if (verification.length > 0) {
    classes.push(RATIONALE_CLASS.CONCRETE_VERIFICATION);
    score += 2;
  } else {
    classes.push(RATIONALE_CLASS.NO_VERIFICATION);
  }

  // ── Scope (files) ────────────────────────────────────────────────────────
  const files = Array.isArray(plan.files) ? plan.files.filter(f => typeof f === "string" && f.trim().length > 0) : [];
  if (files.length > 0) {
    classes.push(RATIONALE_CLASS.SCOPE_DEFINED);
    score += 2;
  } else {
    classes.push(RATIONALE_CLASS.MISSING_SCOPE);
  }

  // ── Context / success criterion ───────────────────────────────────────────
  const context = typeof plan.context === "string" ? plan.context.trim() : "";
  const CRITERION_WORDS = /\b(success\s+crit|criterion|criteria|pass|should|must|expect|measur|result|output|retryCount|field|return)\b/i;
  if (context.length >= 20 && CRITERION_WORDS.test(context)) {
    classes.push(RATIONALE_CLASS.CLEAR_SUCCESS_CRITERION);
    score += 2;
  } else if (context.length > 0) {
    // Partial context present but not a clear criterion — no SPEC_INCOMPLETE unless task also vague
    score += 0;
  } else if (!classes.includes(RATIONALE_CLASS.SPEC_INCOMPLETE)) {
    classes.push(RATIONALE_CLASS.SPEC_INCOMPLETE);
  }

  // ── Priority + wave ───────────────────────────────────────────────────────
  if (Number.isInteger(plan.priority) && Number.isInteger(plan.wave)) {
    classes.push(RATIONALE_CLASS.DEPENDENCY_CORRECT);
    score += 1;
  }

  // ── Specific file path or function reference in task ──────────────────────
  if (/\b(src\/|tests\/|\.js\b|\.ts\b|\(\)|function\s|class\s)/.test(task)) {
    score += 1;
  }

  return {
    score: Math.min(10, Math.max(0, score)),
    scoreCategory: verdictFromScore(score),
    rationaleClasses: classes
  };
}

/**
 * Compute the deviation score across a set of calibration fixture results.
 *
 * Formula:
 *   deviationScore = number_of_mismatches / total_fixtures
 *
 * Range: [0.0, 1.0]
 * Unit:  fraction (0.0 = no drift, 1.0 = every fixture produced wrong verdict)
 *
 * A mismatch is when the actualCategory (derived from heuristic score) does not
 * equal fixture.expectedVerdict.
 *
 * @param {{ fixture: object, actualCategory: string }[]} results
 * @returns {{ deviationScore: number, total: number, mismatches: number, details: object[] }}
 */
export function computeCalibrationDeviation(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { deviationScore: 0.0, total: 0, mismatches: 0, details: [] };
  }
  const details = results.map(r => {
    const expected = r.fixture?.expectedVerdict ?? "unknown";
    const actual = r.actualCategory ?? "unknown";
    return {
      fixtureId: r.fixture?.fixtureId ?? "unknown",
      expected,
      actual,
      match: expected === actual
    };
  });
  const mismatches = details.filter(d => !d.match).length;
  const deviationScore = mismatches / results.length;
  return {
    deviationScore: Math.round(deviationScore * 10000) / 10000,
    total: results.length,
    mismatches,
    details
  };
}

/**
 * Run all fixtures through the heuristic scorer and compute deviation.
 * Pure function — no I/O, fully offline.
 *
 * @param {object[]} fixtures - array of parsed calibration fixture objects
 * @returns {{ deviationScore: number, total: number, mismatches: number, details: object[], results: object[] }}
 */
export function runCalibration(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    return { deviationScore: 0.0, total: 0, mismatches: 0, details: [], results: [] };
  }
  const results = fixtures.map(fixture => {
    const scored = scoreCalibrationPlan(fixture);
    return { fixture, ...scored };
  });
  const deviation = computeCalibrationDeviation(
    results.map(r => ({ fixture: r.fixture, actualCategory: r.scoreCategory }))
  );

  // Capacity dimension: track which rationale classes are consistently missed
  const missedClasses = new Map();
  for (const r of results) {
    const expected = r.fixture?.expectedRationaleClasses || [];
    const matched = (r as any).matchedClasses || [];
    const matchedSet = new Set(matched);
    for (const cls of expected) {
      if (!matchedSet.has(cls)) {
        missedClasses.set(cls, (missedClasses.get(cls) || 0) + 1);
      }
    }
  }
  const capacityGaps = [...missedClasses.entries()]
    .filter(([, count]) => count >= 2)
    .map(([cls, count]) => ({ rationaleClass: cls, missedCount: count }))
    .sort((a, b) => b.missedCount - a.missedCount);

  return { ...deviation, results, capacityGaps };
}

/**
 * Task class taxonomy for class-segmented calibration.
 * @enum {string}
 */
export const TASK_CLASS = Object.freeze({
  IMPLEMENTATION: "implementation",
  TEST: "test",
  REFACTOR: "refactor",
  BUGFIX: "bugfix",
  GOVERNANCE: "governance",
  DOCUMENTATION: "documentation",
  INFRASTRUCTURE: "infrastructure",
  UNKNOWN: "unknown",
});

/**
 * Infer task class from a plan fixture.
 *
 * @param {object} fixture
 * @returns {string} one of TASK_CLASS values
 */
export function inferTaskClass(fixture) {
  const task = String(fixture?.plan?.task || "").toLowerCase();
  const role = String(fixture?.plan?.role || "").toLowerCase();
  if (/\btests?\b|\.test\.|spec\b/.test(task) || role === "test" || role === "qa") return TASK_CLASS.TEST;
  if (/\bbug\b|fix\b|patch\b|hotfix/.test(task) || role === "bugfix") return TASK_CLASS.BUGFIX;
  if (/\brefactor\b|cleanup|restructur/.test(task)) return TASK_CLASS.REFACTOR;
  if (/\bdoc\b|readme|documentation/.test(task) || role === "documentation") return TASK_CLASS.DOCUMENTATION;
  if (/\bgovern|policy|compliance|audit/.test(task) || role === "governance") return TASK_CLASS.GOVERNANCE;
  if (/\binfra|docker|ci|deploy|pipeline/.test(task) || role === "devops" || role === "infrastructure") return TASK_CLASS.INFRASTRUCTURE;
  if (/\bimplement|add|create|build|introduce/.test(task) || role === "implementation" || role === "backend" || role === "frontend") return TASK_CLASS.IMPLEMENTATION;
  return TASK_CLASS.UNKNOWN;
}

/**
 * Run calibration segmented by task class.
 * Returns per-class deviation scores and FP/FN rates.
 *
 * @param {object[]} fixtures
 * @returns {{ overall: object, byClass: Record<string, { deviationScore: number, total: number, mismatches: number, falsePositiveRate: number, falseNegativeRate: number }> }}
 */
export function computeCalibrationByTaskClass(fixtures) {
  const overall = runCalibration(fixtures);
  const byClass: Record<string, any> = {};

  // Group fixtures by task class
  const groups = new Map();
  for (const fixture of (fixtures || [])) {
    const cls = inferTaskClass(fixture);
    if (!groups.has(cls)) groups.set(cls, []);
    groups.get(cls).push(fixture);
  }

  for (const [cls, classFixtures] of groups) {
    const results = classFixtures.map(fixture => {
      const scored = scoreCalibrationPlan(fixture);
      return { fixture, ...scored };
    });
    const deviation = computeCalibrationDeviation(
      results.map(r => ({ fixture: r.fixture, actualCategory: r.scoreCategory }))
    );

    // FP = scored as rejected but expected approved; FN = scored as approved but expected rejected
    let fp = 0, fn = 0;
    for (const r of results) {
      const expected = r.fixture?.expectedVerdict;
      if (r.scoreCategory === CALIBRATION_VERDICT.REJECTED && expected === "approved") fp++;
      if (r.scoreCategory === CALIBRATION_VERDICT.APPROVED && expected === "rejected") fn++;
    }

    byClass[cls] = {
      deviationScore: deviation.deviationScore,
      total: deviation.total,
      mismatches: deviation.mismatches,
      falsePositiveRate: results.length > 0 ? Math.round((fp / results.length) * 10000) / 10000 : 0,
      falseNegativeRate: results.length > 0 ? Math.round((fn / results.length) * 10000) / 10000 : 0,
    };
  }

  return { overall, byClass };
}

// ── Canonical postmortem schema ──────────────────────────────────────────────

/**
 * Canonical values for Athena's postmortem `recommendation` field.
 * New schema (written by runAthenaPostmortem since BOX v1).
 *
 * @enum {string}
 */
export const POSTMORTEM_RECOMMENDATION = Object.freeze({
  PROCEED: "proceed",   // task succeeded — count toward completedTasks
  REWORK:  "rework",    // task needs another attempt
  ESCALATE: "escalate"  // task needs human intervention
});

export const POSTMORTEM_REVIEW_STATUS = Object.freeze({
  LEARNING_GRADE: "learning_grade",
  DEGRADED_REVIEW_REQUIRED: "degraded_review_required",
} as const);

export const DEGRADED_POSTMORTEM_REVIEW_REASON = Object.freeze({
  AI_POSTMORTEM_FAILURE: "AI_POSTMORTEM_FAILURE",
  MISSING_CLOSURE_FIELDS: "MISSING_CLOSURE_FIELDS",
} as const);

const REPLAY_OR_MANUAL_COMPLETION_FOLLOW_UP =
  "Run canonical main-branch replay commands (git rev-parse HEAD, git status --porcelain, npm test) and complete expectedOutcome/actualOutcome manually.";
const REQUIRED_MAIN_BRANCH_REPLAY_COMMANDS = Object.freeze([
  "git rev-parse HEAD",
  "git status --porcelain",
  "npm test",
]);

/**
 * Decision quality labels for postmortem entries.
 * Assigned deterministically from the task outcome via LABEL_OUTCOME_MAP.
 *
 * @enum {string}
 */
export const DECISION_QUALITY_LABEL = Object.freeze({
  CORRECT:         "correct",          // outcome==merged — plan executed and merged as expected
  DELAYED_CORRECT: "delayed-correct",  // outcome==reopen — completed after extra iteration
  INCORRECT:       "incorrect",        // outcome==rollback — plan executed but result was rolled back
  INCONCLUSIVE:    "inconclusive"      // outcome==timeout or unknown — result indeterminate
});

/**
 * Reason codes returned by computeDecisionQualityLabel.
 * Distinguishes missing input from invalid input — no silent fallback allowed.
 *
 * @enum {string}
 */
export const DECISION_QUALITY_REASON = Object.freeze({
  OK:            "OK",
  /** outcome field was absent from the worker result */
  MISSING_INPUT: "MISSING_INPUT",
  /** outcome field was present but not a known value in LABEL_OUTCOME_MAP */
  INVALID_INPUT: "INVALID_INPUT"
});

/**
 * Explicit label-to-outcome mapping table.
 * Workers and tests must use this table; do not infer labels from ad-hoc string matching.
 *
 * outcome       → decisionQualityLabel
 * ─────────────────────────────────────
 * merged        → correct
 * reopen        → delayed-correct
 * rollback      → incorrect
 * timeout       → inconclusive
 *
 * All other values → INVALID_INPUT (label=inconclusive, degraded status)
 */
export const LABEL_OUTCOME_MAP = Object.freeze({
  merged:   DECISION_QUALITY_LABEL.CORRECT,
  reopen:   DECISION_QUALITY_LABEL.DELAYED_CORRECT,
  rollback: DECISION_QUALITY_LABEL.INCORRECT,
  timeout:  DECISION_QUALITY_LABEL.INCONCLUSIVE
});

/** All valid outcome keys as a Set for O(1) lookup. */
const VALID_OUTCOMES = new Set(Object.keys(LABEL_OUTCOME_MAP));

/**
 * Compute the decision quality label for a postmortem outcome.
 *
 * Distinguishes:
 *   - Missing input  (outcome is null/undefined) → inconclusive, reason=MISSING_INPUT
 *   - Invalid input  (outcome present but unknown) → inconclusive + degraded status, reason=INVALID_INPUT
 *   - Valid input    → mapped label, reason=OK
 *
 * Never returns a silent fallback — callers must check `reason` before trusting `label`.
 *
 * @param {string|null|undefined} outcome
 * @returns {{ label: string, reason: string, status: "ok"|"degraded" }}
 */
export function computeDecisionQualityLabel(outcome) {
  if (outcome === null || outcome === undefined || outcome === "") {
    return {
      label: DECISION_QUALITY_LABEL.INCONCLUSIVE,
      reason: DECISION_QUALITY_REASON.MISSING_INPUT,
      status: "degraded"
    };
  }
  const key = String(outcome).toLowerCase().trim();
  if (!VALID_OUTCOMES.has(key)) {
    return {
      label: DECISION_QUALITY_LABEL.INCONCLUSIVE,
      reason: DECISION_QUALITY_REASON.INVALID_INPUT,
      status: "degraded"
    };
  }
  return {
    label: LABEL_OUTCOME_MAP[key],
    reason: DECISION_QUALITY_REASON.OK,
    status: "ok"
  };
}

/**
 * Normalize the decisionQualityLabel field on a postmortem entry.
 * For legacy entries that pre-date T-012, the field will be absent — default to inconclusive.
 * For entries written after T-012, the field must be a valid DECISION_QUALITY_LABEL value.
 *
 * @param {object} pm - postmortem record
 * @returns {string} - a DECISION_QUALITY_LABEL value
 */
export function normalizeDecisionQualityLabel(pm) {
  if (!pm || typeof pm !== "object") return DECISION_QUALITY_LABEL.INCONCLUSIVE;
  const existing = pm.decisionQualityLabel;
  if (!existing) return DECISION_QUALITY_LABEL.INCONCLUSIVE;
  const validLabels = new Set(Object.values(DECISION_QUALITY_LABEL));
  return validLabels.has(existing) ? existing : DECISION_QUALITY_LABEL.INCONCLUSIVE;
}

// ── Evidence completeness gate ────────────────────────────────────────────────

/**
 * Reason codes returned by computeDecisionQualityLabelWithEvidence.
 * Extends DECISION_QUALITY_REASON with completeness-specific codes.
 *
 * @enum {string}
 */
export const EVIDENCE_COMPLETENESS_REASON = Object.freeze({
  /** Evidence envelope is null/undefined — cannot assign non-inconclusive label. */
  MISSING_EVIDENCE:    "MISSING_EVIDENCE",
  /** Evidence is present but one or more required fields are absent or invalid. */
  INCOMPLETE_EVIDENCE: "INCOMPLETE_EVIDENCE",
  /** Evidence meets minimum completeness; label derived from outcome. */
  EVIDENCE_COMPLETE:   "EVIDENCE_COMPLETE",
} as const);

/**
 * Minimum evidence fields required for a non-inconclusive decision quality label.
 *
 * A postmortem evidence envelope must have ALL of these fields present and
 * non-empty before Athena can assign "correct", "delayed-correct", or "incorrect".
 * If any field is missing or empty, the label is downgraded to "inconclusive".
 *
 *   roleName         — the worker role that produced the outcome
 *   status           — terminal BOX_STATUS emitted by the worker
 *   summary          — human-readable outcome summary (min 10 chars)
 *   verificationEvidence — slot-level pass/fail evidence (build + tests fields)
 */
const EVIDENCE_REQUIRED_FIELDS = ["roleName", "status", "summary"] as const;
const EVIDENCE_MIN_SUMMARY_LEN = 10;

/**
 * Check whether a postmortem evidence envelope has the minimum completeness
 * required to support a non-inconclusive decision quality label.
 *
 * @param evidence — postmortem evidence object (EvidenceEnvelope or similar)
 * @returns {{ complete: boolean, reason: string, missing: string[] }}
 */
export function computeEvidenceCompleteness(evidence: any): {
  complete: boolean;
  reason: string;
  missing: string[];
} {
  if (evidence === null || evidence === undefined) {
    return { complete: false, reason: EVIDENCE_COMPLETENESS_REASON.MISSING_EVIDENCE, missing: ["evidence"] };
  }
  if (typeof evidence !== "object" || Array.isArray(evidence)) {
    return { complete: false, reason: EVIDENCE_COMPLETENESS_REASON.MISSING_EVIDENCE, missing: ["evidence"] };
  }

  const missing: string[] = [];

  for (const field of EVIDENCE_REQUIRED_FIELDS) {
    const value = evidence[field];
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
      missing.push(field);
    }
  }

  // summary must meet minimum length
  const summary = typeof evidence.summary === "string" ? evidence.summary.trim() : "";
  if (!missing.includes("summary") && summary.length < EVIDENCE_MIN_SUMMARY_LEN) {
    missing.push("summary:too_short");
  }

  // verificationEvidence must be present with at least build and tests fields
  const ve = evidence.verificationEvidence;
  if (!ve || typeof ve !== "object" || Array.isArray(ve)) {
    missing.push("verificationEvidence");
  } else {
    if (!ve.build) missing.push("verificationEvidence.build");
    if (!ve.tests) missing.push("verificationEvidence.tests");
  }

  if (missing.length > 0) {
    return { complete: false, reason: EVIDENCE_COMPLETENESS_REASON.INCOMPLETE_EVIDENCE, missing };
  }

  return { complete: true, reason: EVIDENCE_COMPLETENESS_REASON.EVIDENCE_COMPLETE, missing: [] };
}

/**
 * Compute the decision quality label for a postmortem outcome while enforcing
 * minimum evidence completeness before assigning non-inconclusive labels.
 *
 * Calibration requirement:
 *   A non-inconclusive label (correct, delayed-correct, incorrect) may only be
 *   assigned when the evidence envelope is present and complete.  If evidence is
 *   absent or incomplete, the label is downgraded to "inconclusive" regardless
 *   of the outcome value, and `evidenceComplete=false` is set on the result.
 *
 * @param outcome  — worker result outcome string (merged | reopen | rollback | timeout | ...)
 * @param evidence — optional postmortem evidence envelope
 * @returns {{ label, reason, status, evidenceComplete, evidenceReason, evidenceMissing }}
 */
export function computeDecisionQualityLabelWithEvidence(
  outcome: any,
  evidence?: any,
): {
  label: string;
  reason: string;
  status: "ok" | "degraded";
  evidenceComplete: boolean;
  evidenceReason: string;
  evidenceMissing: string[];
} {
  // Step 1: derive label from outcome (handles null/invalid outcome → inconclusive)
  const base = computeDecisionQualityLabel(outcome);

  // Step 2: if already inconclusive (due to bad outcome), skip evidence check
  if (base.label === DECISION_QUALITY_LABEL.INCONCLUSIVE) {
    const completeness = computeEvidenceCompleteness(evidence);
    return {
      ...base,
      status: base.status as "ok" | "degraded",
      evidenceComplete: completeness.complete,
      evidenceReason: completeness.reason,
      evidenceMissing: completeness.missing,
    };
  }

  // Step 3: non-inconclusive label requires complete evidence
  const completeness = computeEvidenceCompleteness(evidence);
  if (!completeness.complete) {
    // Downgrade to inconclusive — evidence is insufficient to certify this label
    return {
      label: DECISION_QUALITY_LABEL.INCONCLUSIVE,
      reason: DECISION_QUALITY_REASON.OK, // outcome was valid; downgrade is evidence-driven
      status: "degraded",
      evidenceComplete: false,
      evidenceReason: completeness.reason,
      evidenceMissing: completeness.missing,
    };
  }

  return {
    ...base,
    status: base.status as "ok" | "degraded",
    evidenceComplete: true,
    evidenceReason: completeness.reason,
    evidenceMissing: [],
  };
}

/**
 * Reason codes for postmortem closure field validation.
 * Used by validatePostmortemClosureFields to distinguish missing from empty input.
 *
 * @enum {string}
 */
export const POSTMORTEM_CLOSURE_VALIDATION_REASON = Object.freeze({
  /** All required closure fields are non-empty and valid. */
  OK: "OK",
  /** One or more required closure fields are missing entirely. */
  MISSING_FIELD:   "MISSING_FIELD",
  /** One or more required closure fields are present but empty. */
  EMPTY_FIELD:     "EMPTY_FIELD",
} as const);

/**
 * Reason codes for closure boundary violations.
 * Used when the completion-boundary enforcement blocks finalization.
 *
 * @enum {string}
 */
export const CLOSURE_BOUNDARY_VIOLATION_REASON = Object.freeze({
  /** AI retry did not produce valid closure fields — fail-closed. */
  RETRY_FAILED: "RETRY_FAILED",
  /** AI retry call itself failed (network/binary error). */
  RETRY_CALL_FAILED: "RETRY_CALL_FAILED",
} as const);

/**
 * Required non-empty fields in the postmortem closure evidence record.
 * The AI postmortem path must populate all three fields with non-trivial content.
 *
 *   expectedOutcome — what the plan intended to achieve (non-empty string)
 *   actualOutcome   — what actually happened (non-empty string)
 *   deviation       — "none" | "minor" | "major" (non-empty, one of known values)
 */
const POSTMORTEM_CLOSURE_REQUIRED_FIELDS = ["expectedOutcome", "actualOutcome", "deviation"] as const;
const VALID_DEVIATION_VALUES = new Set(["none", "minor", "major"]);

/**
 * Validate that a postmortem record has all required closure evidence fields
 * populated with non-empty, non-trivial values.
 *
 * This gate enforces quality on the AI postmortem closure path before the
 * record is persisted to history.  A postmortem without these fields cannot
 * be used for carry-forward lesson extraction or decision quality scoring.
 *
 * @param postmortem — postmortem object returned by the AI or deterministic path
 * @returns {{ valid: boolean, reason: string, emptyFields: string[] }}
 */
export function validatePostmortemClosureFields(postmortem: any): {
  valid: boolean;
  reason: string;
  emptyFields: string[];
} {
  if (!postmortem || typeof postmortem !== "object") {
    return { valid: false, reason: POSTMORTEM_CLOSURE_VALIDATION_REASON.MISSING_FIELD, emptyFields: ["postmortem"] };
  }

  const emptyFields: string[] = [];

  for (const field of POSTMORTEM_CLOSURE_REQUIRED_FIELDS) {
    const value = postmortem[field];
    if (value === null || value === undefined) {
      emptyFields.push(field);
    } else if (typeof value === "string" && value.trim() === "") {
      emptyFields.push(field);
    }
  }

  // deviation must be one of the known values when present
  const deviation = typeof postmortem.deviation === "string" ? postmortem.deviation.trim() : "";
  if (deviation.length > 0 && !VALID_DEVIATION_VALUES.has(deviation) && !emptyFields.includes("deviation")) {
    // invalid value treated as empty for gating purposes
    emptyFields.push("deviation");
  }

  if (emptyFields.length > 0) {
    return {
      valid: false,
      reason: emptyFields.some(f => postmortem[f] === null || postmortem[f] === undefined)
        ? POSTMORTEM_CLOSURE_VALIDATION_REASON.MISSING_FIELD
        : POSTMORTEM_CLOSURE_VALIDATION_REASON.EMPTY_FIELD,
      emptyFields,
    };
  }

  return { valid: true, reason: POSTMORTEM_CLOSURE_VALIDATION_REASON.OK, emptyFields: [] };
}

export function applyPostmortemLearningGradeStatus(
  postmortem: any,
  opts: {
    closureValidation?: ReturnType<typeof validatePostmortemClosureFields>;
    forceDegraded?: boolean;
    degradedReason?: string;
  } = {},
) {
  const closureValidation = opts.closureValidation ?? validatePostmortemClosureFields(postmortem);
  const forceDegraded = opts.forceDegraded === true;
  const degradedReason = String(opts.degradedReason || "").trim();
  const requiresDegradedReview = forceDegraded || !closureValidation.valid;

  const normalized = {
    ...(postmortem && typeof postmortem === "object" ? postmortem : {}),
    closureFieldsValid: closureValidation.valid,
    closureValidationReason: closureValidation.reason,
    closureValidationEmptyFields: [...closureValidation.emptyFields],
    requiredReplayCommands: [...REQUIRED_MAIN_BRANCH_REPLAY_COMMANDS],
  } as Record<string, any>;

  if (requiresDegradedReview) {
    normalized.reviewStatus = POSTMORTEM_REVIEW_STATUS.DEGRADED_REVIEW_REQUIRED;
    normalized.learningGradeEligible = false;
    normalized.requiresReplayOrManualCompletion = true;
    normalized.degradedReviewReason = degradedReason || DEGRADED_POSTMORTEM_REVIEW_REASON.MISSING_CLOSURE_FIELDS;
    normalized.decisionQualityStatus = "degraded";
    if (normalized.decisionQualityLabel !== DECISION_QUALITY_LABEL.INCONCLUSIVE) {
      normalized.decisionQualityLabel = DECISION_QUALITY_LABEL.INCONCLUSIVE;
    }
    if (!String(normalized.decisionQualityLabelReason || "").trim()) {
      normalized.decisionQualityLabelReason = DECISION_QUALITY_REASON.MISSING_INPUT;
    }
    normalized.followUpNeeded = true;
    if (!String(normalized.followUpTask || "").trim()) {
      normalized.followUpTask = REPLAY_OR_MANUAL_COMPLETION_FOLLOW_UP;
    }
    if (normalized.recommendation !== POSTMORTEM_RECOMMENDATION.ESCALATE) {
      normalized.recommendation = POSTMORTEM_RECOMMENDATION.REWORK;
    }
    return normalized;
  }

  normalized.reviewStatus = POSTMORTEM_REVIEW_STATUS.LEARNING_GRADE;
  normalized.learningGradeEligible = true;
  normalized.requiresReplayOrManualCompletion = false;
  return normalized;
}

/**
 * Returns true when a postmortem carries a closure boundary violation flag.
 * A boundary-violated postmortem must not be used to finalize a worker as done.
 *
 * @param postmortem — postmortem object returned by runAthenaPostmortem
 */
export function isClosureBoundaryViolation(postmortem: any): boolean {
  return postmortem?.closureBoundaryViolation === true;
}

/**
 * Build a targeted retry prompt for Athena when the initial postmortem
 * response is missing required closure fields.
 *
 * @param basePrompt         — original context prompt sent to Athena
 * @param closureValidation  — result of validatePostmortemClosureFields
 * @param partialPostmortem  — the partial postmortem from the first attempt
 */
export function buildPostmortemClosureRetryPrompt(
  basePrompt: string,
  closureValidation: ReturnType<typeof validatePostmortemClosureFields>,
  partialPostmortem: Record<string, any>,
): string {
  const missingList = closureValidation.emptyFields.map((f, i) => `${i + 1}. ${f}`).join("\n");
  const partial = {
    expectedOutcome: partialPostmortem.expectedOutcome || "",
    actualOutcome:   partialPostmortem.actualOutcome   || "",
    deviation:       partialPostmortem.deviation       || "",
  };
  return `${basePrompt}

## RETRY — MISSING REQUIRED CLOSURE FIELDS

Your previous postmortem response was missing required closure fields.
These fields are mandatory for completion-boundary enforcement.

Missing fields:
${missingList}

Current (incomplete) values from your first response:
- expectedOutcome: "${partial.expectedOutcome}"
- actualOutcome:   "${partial.actualOutcome}"
- deviation:       "${partial.deviation}"

Return a corrected ===DECISION=== JSON block that includes non-empty values for:
1. expectedOutcome — concise description of what the task was supposed to achieve
2. actualOutcome   — concise description of what was actually done
3. deviation       — exactly one of: "none" | "minor" | "major"

Do not omit these fields. The postmortem cannot be used for learning without them.`;
}

/**
 */
export const POSTMORTEM_PARSE_REASON = Object.freeze({
  OK: "OK",
  /** Neither `recommendation` nor legacy `verdict` field is present. */
  MISSING_VERDICT: "MISSING_VERDICT",
  /** `recommendation` is present but not a known POSTMORTEM_RECOMMENDATION value. */
  INVALID_RECOMMENDATION: "INVALID_RECOMMENDATION"
});

/** All valid recommendation strings as a Set for O(1) lookup. */
const VALID_RECOMMENDATIONS = new Set(Object.values(POSTMORTEM_RECOMMENDATION));

/**
 * Derive a deterministic postmortem recommendation from the decision quality label.
 *
 * Used as the fallback when the AI omits the `recommendation` field.  Prevents
 * the silent default-to-"proceed" that masks inconclusive or failed outcomes.
 *
 * Derivation rules (in priority order):
 *   incorrect   → escalate  (rollback scenario; human intervention required)
 *   inconclusive → rework   (evidence missing; cannot confirm success)
 *   correct | delayed-correct → proceed (positive outcome with known label)
 *   unknown label → rework  (safe default for any unrecognized label value)
 *
 * @param dqlLabel — label from computeDecisionQualityLabel / computeDecisionQualityLabelWithEvidence
 */
export function deriveDeterministicRecommendation(dqlLabel: string): string {
  if (dqlLabel === DECISION_QUALITY_LABEL.INCORRECT)    return POSTMORTEM_RECOMMENDATION.ESCALATE;
  if (dqlLabel === DECISION_QUALITY_LABEL.INCONCLUSIVE) return POSTMORTEM_RECOMMENDATION.REWORK;
  if (
    dqlLabel === DECISION_QUALITY_LABEL.CORRECT ||
    dqlLabel === DECISION_QUALITY_LABEL.DELAYED_CORRECT
  ) {
    return POSTMORTEM_RECOMMENDATION.PROCEED;
  }
  // Safe default for any future unknown label — never silently proceed.
  return POSTMORTEM_RECOMMENDATION.REWORK;
}

/**
 * Normalize a postmortem record's pass/fail status.
 *
 * Strategy: normalize on read (no silent fallback for critical state).
 *   - New schema  (has `recommendation`): pass iff recommendation === "proceed"
 *   - Legacy schema (has `verdict`, no `recommendation`): pass iff verdict === "pass"
 *   - Unknown (neither field): degrade — pass=false, reason=MISSING_VERDICT
 *
 * @param {object} pm - postmortem record from athena_postmortems.json
 * @returns {{ pass: boolean, schema: "new"|"legacy"|"unknown", reason: string }}
 */
export function normalizePostmortemVerdict(pm) {
  if (!pm || typeof pm !== "object") {
    return { pass: false, schema: "unknown", reason: POSTMORTEM_PARSE_REASON.MISSING_VERDICT };
  }

  // New schema: recommendation field takes precedence
  if ("recommendation" in pm) {
    const rec = pm.recommendation;
    if (!VALID_RECOMMENDATIONS.has(rec)) {
      return { pass: false, schema: "new", reason: POSTMORTEM_PARSE_REASON.INVALID_RECOMMENDATION };
    }
    return { pass: rec === POSTMORTEM_RECOMMENDATION.PROCEED, schema: "new", reason: POSTMORTEM_PARSE_REASON.OK };
  }

  // Legacy schema fallback: verdict field (backward compatibility)
  if ("verdict" in pm) {
    return { pass: pm.verdict === "pass", schema: "legacy", reason: POSTMORTEM_PARSE_REASON.OK };
  }

  // Neither field present — degrade explicitly, never silent
  return { pass: false, schema: "unknown", reason: POSTMORTEM_PARSE_REASON.MISSING_VERDICT };
}

// ── Pre-mortem Schema ────────────────────────────────────────────────────────

/**
 * Risk threshold for pre-mortem requirement.
 * Only HIGH-risk interventions require a pre-mortem before dispatch.
 * Athena hardening note (T-026): task scope mentioned "medium/high" but Athena
 * flagged dispatch pipeline gating as high blast-radius — use "high" only.
 *
 * @enum {string}
 */
export const PREMORTEM_RISK_LEVEL = Object.freeze({
  HIGH: "high"
});

/**
 * Status codes returned by validatePremortem.
 *
 * @enum {string}
 */
export const PREMORTEM_STATUS = Object.freeze({
  /** All required fields present and valid. */
  PASS:       "pass",
  /** Pre-mortem object present but one or more fields are missing or invalid. */
  INCOMPLETE: "incomplete",
  /** Pre-mortem object absent, null, or riskLevel is not "high". */
  BLOCKED:    "blocked"
});

/**
 * Reason codes returned by validatePremortem.
 * Distinguishes missing input from invalid input — no silent fallback.
 *
 * @enum {string}
 */
export const PREMORTEM_VALIDATION_REASON = Object.freeze({
  OK:               "OK",
  /** Pre-mortem object is null/undefined/not-an-object. */
  MISSING_FIELD:    "MISSING_FIELD",
  /** Pre-mortem present but one or more fields fail validation. */
  INVALID_FIELD:    "INVALID_FIELD",
  /** riskLevel field present but not "high". */
  WRONG_RISK_LEVEL: "WRONG_RISK_LEVEL"
});

/**
 * Canonical list of required pre-mortem fields.
 * All fields must be present and valid for status=PASS.
 *
 * Field        Type       Constraint
 * ─────────────────────────────────────────────────────────────────────
 * scenario        string     min 20 chars  — narrative of what could go wrong
 * failurePaths    string[]   min 1 item    — discrete failure modes enumerated
 * mitigations     string[]   min 1 item    — per-failure mitigation strategies
 * detectionSignals string[]  min 1 item    — observable signals of failure onset
 * guardrails      string[]   min 1 item    — checks/gates preventing cascading failure
 * rollbackPlan    string     min 10 chars  — safe rollback procedure
 * riskLevel       "high"                   — must be PREMORTEM_RISK_LEVEL.HIGH
 */
export const PREMORTEM_REQUIRED_FIELDS = Object.freeze([
  "scenario",
  "failurePaths",
  "mitigations",
  "detectionSignals",
  "guardrails",
  "rollbackPlan",
  "riskLevel"
]);

/** Minimum string lengths for pre-mortem string fields. */
const PREMORTEM_MIN_STRLEN = Object.freeze({
  scenario:    20,
  rollbackPlan: 10
});

/** Minimum array lengths for pre-mortem array fields. */
const PREMORTEM_MIN_ARRLEN = Object.freeze({
  failurePaths:     1,
  mitigations:      1,
  detectionSignals: 1,
  guardrails:       1
});

/**
 * Validate a pre-mortem object against the canonical schema.
 *
 * Distinguishes:
 *   - Missing input  (null/undefined/not-object) → BLOCKED,    reason=MISSING_FIELD
 *   - Wrong riskLevel (not "high")               → BLOCKED,    reason=WRONG_RISK_LEVEL
 *   - Invalid/incomplete fields                  → INCOMPLETE, reason=INVALID_FIELD
 *   - All fields present and valid               → PASS,       reason=OK
 *
 * Never returns a silent fallback — callers must check `status` before trusting the result.
 *
 * @param {unknown} input
 * @returns {{ status: string, reason: string, errors: string[] }}
 */
export function validatePremortem(input) {
  if (!input || typeof input !== "object") {
    return {
      status: PREMORTEM_STATUS.BLOCKED,
      reason: PREMORTEM_VALIDATION_REASON.MISSING_FIELD,
      errors: ["pre-mortem must be a non-null object"]
    };
  }

  const pm = input;

  // riskLevel must be "high" — only high-risk plans require pre-mortems
  if (!("riskLevel" in pm)) {
    return {
      status: PREMORTEM_STATUS.BLOCKED,
      reason: PREMORTEM_VALIDATION_REASON.MISSING_FIELD,
      errors: ["riskLevel is required"]
    };
  }
  if (pm.riskLevel !== PREMORTEM_RISK_LEVEL.HIGH) {
    return {
      status: PREMORTEM_STATUS.BLOCKED,
      reason: PREMORTEM_VALIDATION_REASON.WRONG_RISK_LEVEL,
      errors: [`riskLevel must be "${PREMORTEM_RISK_LEVEL.HIGH}", got "${pm.riskLevel}"`]
    };
  }

  const errors = [];

  // Validate string fields with minimum length
  for (const [field, minLen] of Object.entries(PREMORTEM_MIN_STRLEN)) {
    if (!(field in pm)) {
      errors.push(`${field} is required`);
    } else if (typeof pm[field] !== "string" || pm[field].trim().length < minLen) {
      errors.push(`${field} must be a string with at least ${minLen} characters`);
    }
  }

  // Validate array fields with minimum length
  for (const [field, minLen] of Object.entries(PREMORTEM_MIN_ARRLEN)) {
    if (!(field in pm)) {
      errors.push(`${field} is required`);
    } else if (!Array.isArray(pm[field]) || pm[field].length < minLen) {
      errors.push(`${field} must be an array with at least ${minLen} item(s)`);
    }
  }

  if (errors.length > 0) {
    return {
      status: PREMORTEM_STATUS.INCOMPLETE,
      reason: PREMORTEM_VALIDATION_REASON.INVALID_FIELD,
      errors
    };
  }

  return {
    status: PREMORTEM_STATUS.PASS,
    reason: PREMORTEM_VALIDATION_REASON.OK,
    errors: []
  };
}

/**
 * Check all high-risk plans for valid pre-mortems.
 * Returns an array of human-readable violation strings.
 * An empty array means all high-risk plans have valid pre-mortems.
 *
 * A plan is considered high-risk when plan.riskLevel === "high".
 * High-risk plans MUST include a `premortem` section that passes validatePremortem.
 *
 * @param {Array<object>} plans
 * @returns {string[]} violations
 */
export function checkPlanPremortemGate(plans) {
  const violations = [];
  if (!Array.isArray(plans)) return violations;

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (!plan || typeof plan !== "object") continue;
    if (plan.riskLevel !== PREMORTEM_RISK_LEVEL.HIGH) continue;

    const validation = validatePremortem(plan.premortem);
    if (validation.status !== PREMORTEM_STATUS.PASS) {
      const label = plan.task || plan.role || `index ${i}`;
      violations.push(
        `plan[${i}] "${label}": high-risk intervention requires a valid pre-mortem — ${validation.errors.join("; ")}`
      );
    }
  }

  return violations;
}

// ── AI call (single-prompt, 1 request) ──────────────────────────────────────

async function callCopilotAgent(command, agentSlug, contextPrompt, config, model) {
  // Single-prompt mode: no autopilot, no continues — exactly 1 premium request.
  // Hardened behavior: force non-interactive mode and retry once without --agent
  // if the custom-agent invocation stalls or fails.
  const timeoutMs = resolveAthenaPlanReviewTimeoutMs(config);

  const runAttempt = async (useAgent: boolean): Promise<{
    ok: boolean;
    raw: string;
    parsed: any;
    thinking: string;
    error: string;
  }> => {
    const args = buildAgentArgs({
      agentSlug: useAgent ? agentSlug : undefined,
      prompt: contextPrompt,
      model,
      allowAll: false,
      noAskUser: true,
      maxContinues: undefined
    });

    const result: any = await spawnAsync(command, args, {
      env: process.env,
      timeoutMs
    });
    const stdout = String(result?.stdout || "");
    const stderr = String(result?.stderr || "");
    if (result?.timedOut) {
      return {
        ok: false,
        raw: stdout || stderr,
        parsed: null,
        thinking: "",
        error: `timed out after ${Math.round(timeoutMs / 1000)}s`
      };
    }
    if (result.status !== 0) {
      const errPreview = String(stderr || stdout || "").trim().slice(0, 300);
      const errSuffix = errPreview ? `: ${errPreview}` : "";
      return { ok: false, raw: stdout || stderr, parsed: null, thinking: "", error: `exited ${result.status}${errSuffix}` };
    }
    const parsed = parseAgentOutput(stdout || stderr);
    return {
      ok: Boolean(parsed?.ok),
      raw: stdout || stderr,
      parsed: parsed?.parsed || null,
      thinking: String(parsed?.thinking || ""),
      error: parsed?.ok ? "" : "no structured decision returned"
    };
  };

  const primary = await runAttempt(true);
  if (primary.ok && primary.parsed) {
    return primary;
  }

  if (agentSlug) {
    await appendProgress(
      config,
      `[ATHENA][WARN] Agent invocation failed (${primary.error || "unknown error"}) — retrying once with plain model invocation`
    );
    const fallback = await runAttempt(false);
    if (fallback.ok && fallback.parsed) {
      await appendProgress(config, `[ATHENA] Fallback invocation succeeded after primary agent invocation failed`);
      return fallback;
    }
    const fallbackError = fallback.error || "unknown error";
    return {
      ok: false,
      raw: `${String(primary.raw || "")}\n${String(fallback.raw || "")}`.trim(),
      parsed: null,
      thinking: "",
      error: `primary=${primary.error || "unknown"}; fallback=${fallbackError}`
    };
  }

  return primary;
}

function pickReviewerPayload(raw) {
  const candidates = [
    raw,
    raw?.decision,
    raw?.review,
    raw?.reviewer,
    raw?.result,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    if (
      typeof candidate.approved === "boolean"
      || Array.isArray(candidate.corrections)
      || Array.isArray(candidate.planReviews)
      || typeof candidate.summary === "string"
      || typeof candidate.reason === "string"
    ) {
      return candidate;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function collectReviewerCorrections(payload, planReviews) {
  if (Array.isArray(payload?.corrections)) {
    return payload.corrections.map((item) => String(item || "").trim()).filter(Boolean);
  }

  const fromReviews = [];
  for (const review of planReviews) {
    if (Array.isArray(review?.issues) && review.issues.length > 0) {
      const prefix = Number.isInteger(review.planIndex) ? `plan[${review.planIndex}]` : "plan";
      fromReviews.push(`${prefix}: ${review.issues.map((item) => String(item || "").trim()).filter(Boolean).join("; ")}`);
    }
  }
  return fromReviews.filter(Boolean);
}

function inferApprovalFromReviewerPayload(payload, normalizedPlanReviews, corrections) {
  if (typeof payload?.approved === "boolean") return payload.approved;

  const status = String(payload?.status || payload?.verdict || "").trim().toLowerCase();
  if (["approved", "approve", "pass", "passed", "accept", "accepted"].includes(status)) return true;
  if (["rejected", "reject", "fail", "failed", "blocked"].includes(status)) return false;

  if (corrections.length > 0) return false;

  const hasNegativeReview = normalizedPlanReviews.some((review) =>
    review.measurable === false
    || review.successCriteriaClear === false
    || review.verificationConcrete === false
    || review.scopeDefined === false
    || review.preMortemComplete === false
    || (Array.isArray(review.issues) && review.issues.length > 0)
  );
  if (hasNegativeReview) return false;

  const text = `${payload?.summary || ""} ${payload?.reason || ""} ${payload?.assessment || ""}`.toLowerCase();
  if (/\b(approve|approved|passes|pass|acceptable|looks good|ready)\b/.test(text)) return true;
  if (/\b(reject|rejected|fail|failed|block|blocked|insufficient|missing)\b/.test(text)) return false;

  return false;
}

function buildFallbackPlanReview(plan, index) {
  const files = Array.isArray(plan?.target_files)
    ? plan.target_files
    : Array.isArray(plan?.targetFiles)
      ? plan.targetFiles
      : [];
  const acceptanceCriteria = Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria : [];
  const premortemCheck = plan?.riskLevel === PREMORTEM_RISK_LEVEL.HIGH
    ? validatePremortem(plan?.premortem)
    : { status: PREMORTEM_STATUS.PASS, errors: [] };

  return {
    planIndex: index,
    role: String(plan?.role || "unknown"),
    measurable: String(plan?.task || "").trim().length >= 10,
    successCriteriaClear: acceptanceCriteria.length > 0,
    verificationConcrete: String(plan?.verification || "").trim().length >= 5,
    scopeDefined: files.length > 0 || String(plan?.scope || "").trim().length > 0,
    preMortemComplete: premortemCheck.status === PREMORTEM_STATUS.PASS,
    issues: [],
    suggestion: ""
  };
}

function normalizePlanReviewEntry(entry, plan, index) {
  const fallback = buildFallbackPlanReview(plan, index);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return fallback;
  }

  return {
    planIndex: Number.isInteger(entry.planIndex) ? entry.planIndex : fallback.planIndex,
    role: String(entry.role || fallback.role),
    measurable: typeof entry.measurable === "boolean" ? entry.measurable : fallback.measurable,
    successCriteriaClear: typeof entry.successCriteriaClear === "boolean" ? entry.successCriteriaClear : fallback.successCriteriaClear,
    verificationConcrete: typeof entry.verificationConcrete === "boolean" ? entry.verificationConcrete : fallback.verificationConcrete,
    scopeDefined: typeof entry.scopeDefined === "boolean" ? entry.scopeDefined : fallback.scopeDefined,
    preMortemComplete: typeof entry.preMortemComplete === "boolean" ? entry.preMortemComplete : fallback.preMortemComplete,
    issues: Array.isArray(entry.issues) ? entry.issues.map((item) => String(item || "").trim()).filter(Boolean) : [],
    suggestion: String(entry.suggestion || ""),
  };
}

function attachReviewArtifact<T extends Record<string, unknown>>(
  reviewResult: T,
  plans: any[],
  gateRisk: {
    gateBlockRisk?: string;
    reason?: string | null;
    activeGateSignals?: string[];
    gateBlockSignals?: string[];
    requiresCorrection?: boolean;
  } | null = null,
): T & { reviewArtifact: ReturnType<typeof buildAthenaReviewFindingArtifact> } {
  return {
    ...reviewResult,
    reviewArtifact: buildAthenaReviewFindingArtifact(reviewResult, plans, {
      gateRisk: gateRisk || undefined,
    }),
  };
}

/**
 * Mandatory fields that MUST be present (as explicit values, not synthesized) in every
 * actionable packet returned by the AI reviewer. If any of these are absent, `runAthenaPlanReview`
 * will issue an explicit rejection rather than proceeding with synthesized fallbacks.
 *
 * - `approved`    — must be an explicit boolean or an unambiguous status/verdict string
 * - `planReviews` — must be an explicit array (not built from plan data as a fallback)
 */
export const MANDATORY_ACTIONABLE_PACKET_FIELDS = Object.freeze(["approved", "planReviews"] as const);

// ── Bounded packet format defect correction ───────────────────────────────────

/**
 * Machine codes for bounded low-risk packet format defects that can be
 * deterministically corrected without re-invoking the AI.
 *
 * A "bounded" defect has a clear, well-defined fix scope (one field).
 * A "low-risk" defect can be resolved with high confidence from available evidence.
 *
 * @enum {string}
 */
export const PACKET_DEFECT_CODE = Object.freeze({
  /**
   * `approved` field absent but all explicit planReviews have no issues.
   * Safe to infer approved=true: explicit AI-provided reviews back the decision.
   */
  MISSING_APPROVED_REVIEWSPASSED: "MISSING_APPROVED_REVIEWSPASSED",
  /**
   * `planReviews` field absent but an explicit `approved` boolean was set
   * and all plans are low-risk. Synthetic plan reviews (built from plan metadata)
   * are sufficient for low-risk batches.
   */
  MISSING_PLAN_REVIEWS_LOWRISK: "MISSING_PLAN_REVIEWS_LOWRISK",
} as const);

/**
 * Attempt deterministic correction of bounded low-risk packet format defects.
 *
 * Called before hard-rejecting a plan when MANDATORY_ACTIONABLE_PACKET_FIELDS are
 * absent from the AI response. Only defects that can be resolved with high confidence
 * from available evidence are corrected — ambiguous or high-risk cases fall through
 * to the existing hard-reject path.
 *
 * Correctable defects:
 *   MISSING_APPROVED_REVIEWSPASSED — `approved` absent, planReviews present and all issue-free.
 *     The AI provided explicit reviews showing every plan passes; `approved=true` is safe.
 *   MISSING_PLAN_REVIEWS_LOWRISK  — `planReviews` absent, explicit `approved` set, all plans
 *     low-risk. Synthetic reviews built from plan metadata are sufficient for low-risk batches.
 *
 * NOT correctable:
 *   - Both `approved` and `planReviews` absent (structural failure, not a bounded defect).
 *   - `approved` absent and planReviews have issues (ambiguous — cannot auto-approve).
 *   - `planReviews` absent and any plan has riskLevel="high" (high-risk requires explicit AI reviews).
 *
 * @param normalizedReview — output of normalizeAthenaReviewPayload
 * @param plans            — original plans array from Prometheus analysis
 * @returns correction result with updated payload and missingFields
 */
export function correctBoundedPacketDefects(
  normalizedReview: { payload: any; missingFields: string[]; synthesizedFields: string[] },
  plans: any[],
): {
  corrected: boolean;
  correctedFields: string[];
  defectCodes: string[];
  updatedPayload: any;
  updatedMissingFields: string[];
} {
  const { payload, missingFields } = normalizedReview;
  const correctedFields: string[] = [];
  const defectCodes: string[] = [];
  const updatedPayload: any = { ...payload };

  // Defect 1: `approved` absent, but planReviews are explicit and all issue-free.
  // Bounded: only the `approved` field is affected.
  // Low-risk: backed by explicit AI-provided planReviews — not pure fallback synthesis.
  if (missingFields.includes("approved") && !missingFields.includes("planReviews")) {
    const reviews = Array.isArray(payload.planReviews) ? payload.planReviews : [];
    const allClear = reviews.length > 0 &&
      reviews.every((r: any) => !Array.isArray(r.issues) || r.issues.length === 0);
    if (allClear) {
      updatedPayload.approved = true;
      correctedFields.push("approved");
      defectCodes.push(PACKET_DEFECT_CODE.MISSING_APPROVED_REVIEWSPASSED);
    }
  }

  // Defect 2: `planReviews` absent, but `approved` was explicitly set and all plans are low-risk.
  // Bounded: only the `planReviews` field is affected (synthetic reviews already in payload).
  // Low-risk: only applies when no plan has riskLevel="high".
  if (missingFields.includes("planReviews") && !missingFields.includes("approved")) {
    const allLowRisk = Array.isArray(plans) && plans.length > 0 &&
      plans.every((p: any) => String(p?.riskLevel || "low").trim().toLowerCase() !== "high");
    if (allLowRisk) {
      // Synthetic reviews were already built in normalizePlanReviewEntry; accept them.
      correctedFields.push("planReviews");
      defectCodes.push(PACKET_DEFECT_CODE.MISSING_PLAN_REVIEWS_LOWRISK);
    }
  }

  const updatedMissingFields = missingFields.filter((f) => !correctedFields.includes(f));

  return {
    corrected: correctedFields.length > 0,
    correctedFields,
    defectCodes,
    updatedPayload,
    updatedMissingFields,
  };
}

// ── Patched-plan validation (Task 3) ─────────────────────────────────────────

/**
 * Patterns that indicate an unresolved placeholder value in target_files.
 * Any path matching one of these patterns blocks approval.
 */
const TARGET_FILE_PLACEHOLDER_PATTERNS: RegExp[] = [
  /^\.{2,}$/,         // "..." or "...."
  /^<[^>]+>$/,        // "<placeholder>", "<file>", "<path/to/file>"
  /^\[.*\]$/,         // "[...]", "[placeholder]"
  /^path\/to\//i,     // "path/to/..."  (generic non-real path)
];

/** Return true when the given string looks like an unresolved placeholder. */
function isTargetFilePlaceholder(filePath: string): boolean {
  const s = String(filePath || "").trim();
  if (!s) return true;
  return TARGET_FILE_PLACEHOLDER_PATTERNS.some(p => p.test(s));
}

/**
 * Validate a single patched plan for unresolved target-file placeholders and missing mandatory
 * packet fields. Called after Athena returns patchedPlans so approval can be blocked when the
 * AI failed to properly resolve all placeholder values.
 *
 * Mandatory fields checked: target_files (non-empty, no placeholders), scope, acceptance_criteria.
 *
 * @param plan - a single entry from patchedPlans
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function validatePatchedPlan(plan: unknown): { valid: boolean; issues: string[] } {
  if (!plan || typeof plan !== "object") {
    return { valid: false, issues: ["patched plan is not an object"] };
  }
  const p = plan as Record<string, unknown>;
  const issues: string[] = [];

  // target_files: must be a non-empty array with no placeholder values
  const targetFiles: unknown[] | null = Array.isArray(p.target_files) ? p.target_files
    : Array.isArray(p.targetFiles) ? p.targetFiles : null;
  if (!targetFiles || targetFiles.length === 0) {
    issues.push("target_files is missing or empty");
  } else {
    const placeholders = targetFiles
      .map(f => String(f || "").trim())
      .filter(f => isTargetFilePlaceholder(f));
    if (placeholders.length > 0) {
      issues.push(`target_files contains unresolved placeholder(s): ${placeholders.slice(0, 3).join(", ")}`);
    }
  }

  // scope: must be a non-empty string
  if (!p.scope || String(p.scope).trim().length === 0) {
    issues.push("scope is missing or empty");
  }

  // acceptance_criteria: must be a non-empty array
  const ac = Array.isArray(p.acceptance_criteria) ? p.acceptance_criteria : null;
  if (!ac || ac.length === 0) {
    issues.push("acceptance_criteria is missing or empty");
  }

  return { valid: issues.length === 0, issues };
}

// ── Patched-plan normalization at handoff (Task 2) ───────────────────────────

const CROSS_CYCLE_DEPENDENCY_PATTERN = /^(.+?)\s*\[cross-cycle pre-condition([^\]]*)\]/i;
const CROSS_CYCLE_CONFIRMATION_TOKEN_PATTERN = /(?:confirmation\s+token|token)\s*[:=]\s*([A-Za-z0-9._:-]+)/i;

export function extractCrossCycleDispatchPrerequisiteFromDependency(
  dependency: unknown
): { gateName: string; confirmationToken: string; sourceDependency: string } | null {
  if (typeof dependency !== "string") return null;
  const sourceDependency = dependency.trim();
  if (!sourceDependency) return null;
  const match = sourceDependency.match(CROSS_CYCLE_DEPENDENCY_PATTERN);
  if (!match) return null;
  const gateName = String(match[1] || "").trim();
  if (!gateName) return null;
  const tokenMatch = String(match[2] || "").match(CROSS_CYCLE_CONFIRMATION_TOKEN_PATTERN);
  return {
    gateName,
    confirmationToken: tokenMatch ? String(tokenMatch[1] || "").trim() : "",
    sourceDependency,
  };
}

function normalizeDispatchPrerequisiteMetadata(
  rawPrerequisite: unknown,
  dependencies: unknown[]
): Record<string, unknown> | null {
  const base = rawPrerequisite && typeof rawPrerequisite === "object"
    ? { ...(rawPrerequisite as Record<string, unknown>) }
    : {};
  const fromDependency = dependencies
    .map((dep) => extractCrossCycleDispatchPrerequisiteFromDependency(dep))
    .find(Boolean) || null;
  const gateName = String(base.gateName || base.gate || fromDependency?.gateName || "").trim();
  const confirmationToken = String(
    base.confirmationToken || base.confirmation_token || fromDependency?.confirmationToken || ""
  ).trim();
  const sourceDependency = String(base.sourceDependency || fromDependency?.sourceDependency || "").trim();

  if (!gateName && !sourceDependency) return null;

  return {
    type: String(base.type || "cross_cycle_prerequisite").trim() || "cross_cycle_prerequisite",
    gateName,
    confirmationToken,
    sourceDependency,
  };
}

/**
 * Idempotent normalization of patched plans at the Athena → dispatch handoff seam.
 *
 * Athena may return patchedPlans that passed validatePatchedPlan but still lack
 * dispatch-critical fields (dependencies array, canonical role, positive wave).
 * This function ensures those fields are present with safe defaults so the
 * orchestrator's dependency-graph resolver and contract validator never see gaps.
 *
 * Idempotent: applying twice produces an identical result.
 *
 * @param plans - validated patchedPlans array from Athena
 * @returns new array with each plan carrying all dispatch-required fields
 */
export function normalizePatchedPlansForDispatch(plans: unknown[]): Record<string, unknown>[] {
  if (!Array.isArray(plans)) return [];
  return plans.map((plan) => {
    if (!plan || typeof plan !== "object") return plan as Record<string, unknown>;
    const p = plan as Record<string, unknown>;
    const dependencies = Array.isArray(p.dependencies) ? p.dependencies : [];
    const dispatchPrerequisite = normalizeDispatchPrerequisiteMetadata(p.dispatchPrerequisite, dependencies);

    return {
      ...p,
      // Normalise target_files alias so dispatch always finds the canonical field.
      target_files: Array.isArray(p.target_files) ? p.target_files
        : Array.isArray(p.targetFiles) ? p.targetFiles : [],
      // dependencies must be an array for the dependency-graph resolver.
      dependencies,
      // role must be a non-empty string for worker dispatch routing.
      role: p.role && String(p.role).trim() ? String(p.role).trim() : "evolution-worker",
      // wave must be a positive integer; malformed values fall back to 1.
      wave: Number.isFinite(Number(p.wave)) && Number(p.wave) >= 1 ? Number(p.wave) : 1,
      // capacityDelta must be a finite number in [-1.0, 1.0]; Athena may omit it.
      capacityDelta: Number.isFinite(Number(p.capacityDelta)) && Number(p.capacityDelta) >= -1 && Number(p.capacityDelta) <= 1
        ? Number(p.capacityDelta) : 0.1,
      // requestROI must be a positive finite number; Athena may omit it.
      requestROI: Number.isFinite(Number(p.requestROI)) && Number(p.requestROI) > 0
        ? Number(p.requestROI) : 1.0,
      ...(dispatchPrerequisite ? { dispatchPrerequisite } : {}),
    };
  });
}

/**
 * Sanitize patched plan verification commands to portable equivalents before
 * handoff contract re-validation.
 *
 * Athena may return shell-glob or bash-style verification commands that are
 * valid on some environments but forbidden on Windows dispatch workers.
 * We deterministically normalize the command batch here so re-validation does
 * not repeatedly fail on known-rewritable command forms.
 */

/**
 * Strip operational tool traces and free-form internal reasoning from an Athena
 * review text field before persistence.  Prevents tool_call lines, thinking blocks,
 * and role prefixes from leaking into athena_plan_review.json and postmortem records,
 * which feed downstream planning context.
 *
 * Exported for testing.
 */
export function sanitizeAthenaReviewFieldForPersistence(text: string): string {
  const raw = String(text || "");
  // Remove <thinking>...</thinking> blocks (potentially multiline).
  const noThinking = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  const lines = noThinking.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const norm = line.trim();
    if (!norm) return false;
    if (/^(tool_call|tool_result|function_call|assistant:|system:|user:)/i.test(norm)) return false;
    if (/^copilot>/i.test(norm)) return false;
    if (/^\[?(synthesizer_start|synthesizer_end|research_synthesizer_live)\]/i.test(norm)) return false;
    return true;
  });
  return filtered.join("\n").trim();
}

export function sanitizePatchedPlanVerificationCommands(
  plans: Record<string, unknown>[]
): Record<string, unknown>[] {
  if (!Array.isArray(plans) || plans.length === 0) return [];

  return plans.map((plan) => {
    const verificationCommands = Array.isArray(plan.verification_commands)
      ? plan.verification_commands.map((cmd) => String(cmd || "")).filter(Boolean)
      : [];
    const fallbackRaw = String(plan.verification || "").trim();
    const rawBatch = verificationCommands.length > 0
      ? verificationCommands
      : (fallbackRaw ? [fallbackRaw] : ["npm test"]);

    const sanitizedBatch = normalizeCommandBatch(rawBatch);
    const fallbackCommand = sanitizedBatch[0] || "npm test";

    return {
      ...plan,
      verification: fallbackCommand,
      verification_commands: sanitizedBatch.length > 0 ? sanitizedBatch : [fallbackCommand],
    };
  });
}

/**
 * Reason code returned by revalidatePatchedPlansAfterNormalization when all plans pass.
 * Callers must check `valid` before trusting plan content.
 */
export const PATCHED_PLAN_REVALIDATION_REASON = Object.freeze({
  OK: "OK",
  FAILED: "PATCHED_PLAN_CONTRACT_FAILED",
});

/**
 * Prepare patched plans for dispatch handoff in a single atomic operation.
 *
 * This function MUST be called on every patchedPlans array before it enters the dispatch
 * pipeline — regardless of whether the array is empty or non-empty. It combines
 * normalizePatchedPlansForDispatch (idempotent field defaults) with
 * revalidatePatchedPlansAfterNormalization (contract re-validation), returning a single
 * result that callers must check before trusting the normalized plans.
 *
 * Fails closed: any contract violation sets valid=false with an explicit code and list of
 * violations so callers can block dispatch rather than proceeding with invalid plans.
 *
 * Idempotent: calling twice on the same input produces an identical result.
 *
 * @param plans - patchedPlans array from Athena (may be empty — empty returns valid=true)
 * @returns {{ plans, valid, violations, code }}
 */
export function preparePatchedPlansForDispatch(plans: unknown[]): {
  plans: Record<string, unknown>[];
  valid: boolean;
  violations: string[];
  code: string;
} {
  const normalized = normalizePatchedPlansForDispatch(Array.isArray(plans) ? plans : []);
  const sanitized = sanitizePatchedPlanVerificationCommands(normalized);
  const check = revalidatePatchedPlansAfterNormalization(sanitized);
  return {
    plans: sanitized,
    valid: check.valid,
    violations: check.violations,
    code: check.code,
  };
}

/**
 * Validate Athena AI-provided batch metadata contract.
 *
 * Athena must explicitly return batch assignments in patchedPlans. The
 * orchestrator uses these assignments directly and should not synthesize
 * deterministic batch indexes at this handoff seam.
 */
export function validateAiProvidedBatchMetadata(
  plans: Record<string, unknown>[]
): { valid: boolean; violations: string[] } {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { valid: true, violations: [] };
  }

  const violations: string[] = [];
  const indices = new Set<number>();
  const totals = new Set<number>();

  for (let i = 0; i < plans.length; i++) {
    const p = plans[i] as any;
    const batchIndex = Number(p?._batchIndex);
    const batchTotal = Number(p?._batchTotal);
    const wave = Number(p?._batchWave);
    const workerRole = String(p?._batchWorkerRole || "").trim();

    if (!Number.isFinite(batchIndex) || batchIndex <= 0 || !Number.isInteger(batchIndex)) {
      violations.push(`plan[${i}] "${String(p?.task || "").slice(0, 60)}": missing/invalid _batchIndex`);
    } else {
      indices.add(batchIndex);
    }

    if (!Number.isFinite(batchTotal) || batchTotal <= 0 || !Number.isInteger(batchTotal)) {
      violations.push(`plan[${i}] "${String(p?.task || "").slice(0, 60)}": missing/invalid _batchTotal`);
    } else {
      totals.add(batchTotal);
      if (Number.isFinite(batchIndex) && batchIndex > batchTotal) {
        violations.push(`plan[${i}] "${String(p?.task || "").slice(0, 60)}": _batchIndex exceeds _batchTotal`);
      }
    }

    if (!Number.isFinite(wave) || wave <= 0 || !Number.isInteger(wave)) {
      violations.push(`plan[${i}] "${String(p?.task || "").slice(0, 60)}": missing/invalid _batchWave`);
    }

    if (!workerRole) {
      violations.push(`plan[${i}] "${String(p?.task || "").slice(0, 60)}": missing _batchWorkerRole`);
    }
  }

  if (totals.size > 1) {
    violations.push(`inconsistent _batchTotal across patchedPlans: ${[...totals].sort((a, b) => a - b).join(",")}`);
  }

  const declaredTotal = totals.size === 1 ? [...totals][0] : 0;
  if (declaredTotal > 0) {
    for (let i = 1; i <= declaredTotal; i++) {
      if (!indices.has(i)) {
        violations.push(`missing batch index ${i} in patchedPlans`);
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Run deterministic contract re-validation on normalized patched plans.
 *
 * Called after normalizePatchedPlansForDispatch to ensure that the normalization
 * step did not silently produce plans that violate dispatch-critical constraints.
 * Fails closed: any violation returns valid=false with an explicit reason code and
 * a human-readable list of per-plan violations.
 *
 * Checks (deterministic, no AI):
 *   - task  : non-empty string, ≥ 5 chars
 *   - role  : non-empty string (normalization defaults to "evolution-worker")
 *   - wave  : finite integer ≥ 1
 *   - target_files : non-empty array after normalization
 *   - scope : non-empty string
 *   - acceptance_criteria : non-empty array
 *   - verification : absent or not a forbidden command
 *
 * @param plans - normalized output of normalizePatchedPlansForDispatch
 * @returns { valid, violations, code }
 */
export function revalidatePatchedPlansAfterNormalization(
  plans: Record<string, unknown>[]
): { valid: boolean; violations: string[]; code: string } {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { valid: true, violations: [], code: PATCHED_PLAN_REVALIDATION_REASON.OK };
  }

  const allViolations: string[] = [];

  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    if (!p || typeof p !== "object") {
      allViolations.push(`plan[${i}]: not an object`);
      continue;
    }

    const planViolations: string[] = [];

    // task: must be a non-empty string of at least 5 characters
    if (!p.task || String(p.task).trim().length < 5) {
      planViolations.push("task is missing or too short (< 5 chars)");
    }

    // role: must be non-empty after normalization
    if (!p.role || String(p.role).trim().length === 0) {
      planViolations.push("role is empty after normalization");
    }

    // wave: must be a finite integer >= 1 after normalization
    const wave = Number(p.wave);
    if (!Number.isFinite(wave) || wave < 1) {
      planViolations.push(`wave must be >= 1 after normalization, got: ${p.wave}`);
    }

    // target_files: must be a non-empty array after normalization
    const targetFiles = Array.isArray(p.target_files) ? p.target_files : [];
    if (targetFiles.length === 0) {
      planViolations.push("target_files is empty after normalization");
    }

    // scope: must be a non-empty string
    if (!p.scope || String(p.scope).trim().length === 0) {
      planViolations.push("scope is empty after normalization");
    }

    // acceptance_criteria: must be a non-empty array
    const ac = Array.isArray(p.acceptance_criteria) ? p.acceptance_criteria : [];
    if (ac.length === 0) {
      planViolations.push("acceptance_criteria is empty after normalization");
    }

    // verification: if present, must not be a forbidden command
    if (p.verification) {
      const forbidden = checkForbiddenCommands(String(p.verification));
      if (forbidden.forbidden) {
        for (const v of forbidden.violations) {
          planViolations.push(`verification contains forbidden command: ${v.reason}`);
        }
      }
    }

    if (planViolations.length > 0) {
      const label = String(p.task || `plan ${i}`).slice(0, 60);
      allViolations.push(`plan[${i}] "${label}": ${planViolations.join("; ")}`);
    }
  }

  const valid = allViolations.length === 0;
  return {
    valid,
    violations: allViolations,
    code: valid ? PATCHED_PLAN_REVALIDATION_REASON.OK : PATCHED_PLAN_REVALIDATION_REASON.FAILED,
  };
}


const EXPLICIT_APPROVAL_STATUS_VALUES = new Set([
  "approved", "approve", "pass", "passed", "accept", "accepted",
  "rejected", "reject", "fail", "failed", "blocked"
]);

export function normalizeAthenaReviewPayload(raw, plans = []) {
  const payload = pickReviewerPayload(raw);
  const synthesizedFields = [];
  // `missingFields` tracks fields that had NO basis in the payload (truly absent, not just aliased).
  // Used by runAthenaPlanReview to trigger explicit rejection rather than silent synthesis.
  const missingFields: string[] = [];

  let normalizedPlanReviews: any[];
  if (Array.isArray(payload.planReviews)) {
    normalizedPlanReviews = payload.planReviews.map((entry, index) => normalizePlanReviewEntry(entry, plans[index], index));
  } else if (Array.isArray(payload.plan_reviews)) {
    // `plan_reviews` is an accepted alias — data is present, just differently named
    normalizedPlanReviews = payload.plan_reviews.map((entry, index) => normalizePlanReviewEntry(entry, plans[index], index));
    synthesizedFields.push("planReviews");
  } else {
    // No plan review data at all — fallback built entirely from plan metadata
    normalizedPlanReviews = plans.map((plan, index) => buildFallbackPlanReview(plan, index));
    synthesizedFields.push("planReviews");
    missingFields.push("planReviews");
  }

  const corrections = collectReviewerCorrections(payload, normalizedPlanReviews);
  if (!Array.isArray(payload.corrections)) synthesizedFields.push("corrections");

  const approved = inferApprovalFromReviewerPayload(payload, normalizedPlanReviews, corrections);
  if (typeof payload.approved !== "boolean") {
    synthesizedFields.push("approved");
    // Only "missing" if there is no unambiguous status/verdict string either.
    // An explicit status such as "approved" or "rejected" is an acceptable alias.
    const statusStr = String(payload?.status || payload?.verdict || "").trim().toLowerCase();
    if (!EXPLICIT_APPROVAL_STATUS_VALUES.has(statusStr)) {
      missingFields.push("approved");
    }
  }

  // ── Extract patchedPlans if Athena provided in-place repairs ─────────────
  const patchedPlans = Array.isArray(payload.patchedPlans) ? payload.patchedPlans : null;
  const appliedFixes = Array.isArray(payload.appliedFixes)
    ? payload.appliedFixes.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const unresolvedIssues = Array.isArray(payload.unresolvedIssues)
    ? payload.unresolvedIssues.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  return {
    payload: {
      approved,
      overallScore: Number.isFinite(Number(payload.overallScore)) ? Number(payload.overallScore) : 0,
      summary: String(payload.summary || payload.reason || payload.assessment || ""),
      planReviews: normalizedPlanReviews,
      corrections,
      missingMetrics: Array.isArray(payload.missingMetrics) ? payload.missingMetrics.map((item) => String(item || "").trim()).filter(Boolean) : [],
      lessonsFromPast: String(payload.lessonsFromPast || ""),
      patchedPlans,
      appliedFixes,
      unresolvedIssues,
    },
    synthesizedFields: [...new Set(synthesizedFields)],
    missingFields,
  };
}

export const PATCHED_PLAN_MUTATION_KIND = Object.freeze({
  ABSENT_PLAN_RECONSTRUCTED: "ABSENT_PLAN_RECONSTRUCTED",
  VERIFICATION_PROSE_REWRITTEN: "VERIFICATION_PROSE_REWRITTEN",
  FORWARD_LOOKING_CRITERION_DEFERRED: "FORWARD_LOOKING_CRITERION_DEFERRED",
} as const);

const FORWARD_LOOKING_CRITERION_PATTERN = /\b(next cycle|future cycle|follow[- ]?up|later|after merge|after release|after deploy|defer(?:red|ral)?|eventual(?:ly)?|subsequent)\b/i;
const VERIFICATION_COMMAND_PREFIX = /^(npm|pnpm|yarn|node|npx|bun|go|python|pytest|vitest|jest|cargo|dotnet|mvn|gradle|bash|sh)\b/i;

function toNormalizedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function areTrackedFieldValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!areTrackedFieldValuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj).sort();
    const bKeys = Object.keys(bObj).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      const key = aKeys[i];
      if (key !== bKeys[i]) return false;
      if (!areTrackedFieldValuesEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }
  return false;
}

function isExecutableVerificationCommand(value: unknown): boolean {
  const text = String(value || "").trim();
  if (!text) return false;
  if (VERIFICATION_COMMAND_PREFIX.test(text)) return true;
  if (/\b(--test|--run|--spec|--file)\b/i.test(text)) return true;
  return false;
}

/**
 * Build legacy correction strings and structured mutation events for patched-plan repairs.
 * Legacy corrections remain stable for downstream consumers while mutationEvents
 * provide machine-readable telemetry.
 */
export function buildPatchedPlanCorrectionTracking(
  originalPlans: unknown[],
  patchedPlans: Record<string, unknown>[],
): {
  legacyCorrections: string[];
  mutationEvents: Array<Record<string, unknown>>;
} {
  const legacyCorrections: string[] = [];
  const mutationEvents: Array<Record<string, unknown>> = [];
  const TRACKED_FIELDS = [
    "acceptance_criteria",
    "target_files",
    "scope",
    "verification",
    "verification_commands",
    "verificationCommands",
    "dependencies"
  ];
  const consumedOriginalIndexes = new Set<number>();
  const originalEntries = Array.isArray(originalPlans)
    ? originalPlans.map((plan, index) => ({ plan, index }))
    : [];

  const getPlanIdentityKeys = (plan: unknown): string[] => {
    if (!plan || typeof plan !== "object") return [];
    const entry = plan as Record<string, unknown>;
    return [...new Set([
      entry.intervention_id,
      entry.task_id,
      entry.title,
      entry.task,
    ].map((value) => String(value || "").trim()).filter(Boolean))];
  };

  const originalEntriesByKey = new Map<string, Array<{ plan: unknown; index: number }>>();
  for (const entry of originalEntries) {
    for (const key of getPlanIdentityKeys(entry.plan)) {
      const bucket = originalEntriesByKey.get(key);
      if (bucket) bucket.push(entry);
      else originalEntriesByKey.set(key, [entry]);
    }
  }

  const findOriginalPlanForPatched = (patched: Record<string, unknown>, patchedIndex: number) => {
    for (const key of getPlanIdentityKeys(patched)) {
      const bucket = originalEntriesByKey.get(key) || [];
      const match = bucket.find((entry) => !consumedOriginalIndexes.has(entry.index));
      if (match) return match;
    }
    const fallback = originalEntries[patchedIndex];
    if (fallback && !consumedOriginalIndexes.has(fallback.index)) return fallback;
    return undefined;
  };

  for (let pi = 0; pi < patchedPlans.length; pi++) {
    const patched = patchedPlans[pi] as Record<string, unknown> | undefined;
    if (!patched || typeof patched !== "object") continue;
    const originalMatch = findOriginalPlanForPatched(patched, pi);
    const orig = originalMatch?.plan as Record<string, unknown> | undefined;

    if (!orig || typeof orig !== "object") {
      legacyCorrections.push(`[PATCHED] plan[${pi}]: reconstructed from absent original plan`);
      mutationEvents.push({
        kind: PATCHED_PLAN_MUTATION_KIND.ABSENT_PLAN_RECONSTRUCTED,
        planIndex: pi,
        reason: "patchedPlans included a plan entry where the original index was absent",
      });
      continue;
    }
    consumedOriginalIndexes.add(originalMatch.index);

    const repairedFields: string[] = [];
    for (const field of TRACKED_FIELDS) {
      const origVal = orig[field];
      const patchedVal = patched[field];
      if (!areTrackedFieldValuesEqual(origVal, patchedVal)) repairedFields.push(String(field));
    }
    if (repairedFields.length > 0) {
      legacyCorrections.push(`[PATCHED] plan[${pi}]: ${repairedFields.join(", ")} repaired`);
    }

    const originalVerification = String(orig.verification || "").trim();
    const patchedVerification = String(patched.verification || "").trim();
    const verificationChanged = originalVerification.length > 0
      && patchedVerification.length > 0
      && originalVerification !== patchedVerification;
    if (
      verificationChanged
      && !isExecutableVerificationCommand(originalVerification)
      && isExecutableVerificationCommand(patchedVerification)
    ) {
      legacyCorrections.push(`[PATCHED] plan[${pi}]: verification rewritten from prose to executable command`);
      mutationEvents.push({
        kind: PATCHED_PLAN_MUTATION_KIND.VERIFICATION_PROSE_REWRITTEN,
        planIndex: pi,
        field: "verification",
        before: originalVerification,
        after: patchedVerification,
      });
    }

    // Check verification_commands / verificationCommands arrays for prose→executable rewrites.
    // The TRACKED_FIELDS loop emits a generic "repaired" legacy correction when these change;
    // this block additionally emits a structured VERIFICATION_PROSE_REWRITTEN mutation event
    // when the rewrite is specifically prose→executable so postmortems can distinguish repair type.
    for (const vcField of ["verification_commands", "verificationCommands"] as const) {
      const origCmds = toNormalizedStringArray(orig[vcField]);
      const patchedCmds = toNormalizedStringArray(patched[vcField]);
      if (
        origCmds.length > 0
        && patchedCmds.length > 0
        && !areTrackedFieldValuesEqual(origCmds, patchedCmds)
        && origCmds.some((cmd) => !isExecutableVerificationCommand(cmd))
        && patchedCmds.every((cmd) => isExecutableVerificationCommand(cmd))
      ) {
        legacyCorrections.push(`[PATCHED] plan[${pi}]: ${vcField} rewritten from prose to executable commands`);
        mutationEvents.push({
          kind: PATCHED_PLAN_MUTATION_KIND.VERIFICATION_PROSE_REWRITTEN,
          planIndex: pi,
          field: vcField,
          before: origCmds,
          after: patchedCmds,
        });
      }
    }

    const originalCriteria = toNormalizedStringArray(orig.acceptance_criteria);
    const patchedCriteria = toNormalizedStringArray(patched.acceptance_criteria);
    const criteriaChanged = JSON.stringify(originalCriteria) !== JSON.stringify(patchedCriteria);
    const deferredCriteria = patchedCriteria.filter((criterion) => FORWARD_LOOKING_CRITERION_PATTERN.test(criterion));
    if (criteriaChanged && deferredCriteria.length > 0) {
      legacyCorrections.push(`[PATCHED] plan[${pi}]: acceptance criteria include forward-looking deferral`);
      mutationEvents.push({
        kind: PATCHED_PLAN_MUTATION_KIND.FORWARD_LOOKING_CRITERION_DEFERRED,
        planIndex: pi,
        field: "acceptance_criteria",
        deferredCriteria,
      });
    }
  }

  return {
    legacyCorrections: [...new Set(legacyCorrections)],
    mutationEvents,
  };
}

function truncatePromptText(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function summarizePremortemForPrompt(plan) {
  if (plan?.riskLevel !== PREMORTEM_RISK_LEVEL.HIGH) return "none";
  const validation = validatePremortem(plan?.premortem);
  const pm = plan?.premortem && typeof plan.premortem === "object" ? plan.premortem : {};
  return JSON.stringify({
    status: validation.status,
    scenario: truncatePromptText(pm.scenario || "", 80),
    failurePaths: Array.isArray(pm.failurePaths) ? pm.failurePaths.length : 0,
    mitigations: Array.isArray(pm.mitigations) ? pm.mitigations.length : 0,
    detectionSignals: Array.isArray(pm.detectionSignals) ? pm.detectionSignals.length : 0,
    guardrails: Array.isArray(pm.guardrails) ? pm.guardrails.length : 0,
  });
}

// ── Plan Quality Scoring (deterministic pre-gate) ────────────────────────────

/**
 * Score a single plan item's structural quality (0-100).
 * Used as a fast pre-gate before the AI plan review call.
 *
 * @param {object} plan
 * @returns {{ score: number, issues: string[] }}
 */
export function scorePlanQuality(plan) {
  let score = 100;
  const issues = [];

  if (!plan || typeof plan !== "object") return { score: 0, issues: ["plan is not an object"] };

  if (!plan.task || String(plan.task).trim().length < 10) {
    score -= 30; issues.push("task description too short or missing");
  }
  if (!plan.role || String(plan.role).trim().length < 2) {
    score -= 20; issues.push("role not specified");
  }
  if (!plan.verification || String(plan.verification).trim().length < 5) {
    score -= 20; issues.push("verification method missing or too vague");
  }
  if (plan.wave === undefined || plan.wave === null) {
    score -= 10; issues.push("wave not assigned");
  }
  const vague = /\b(improve|refactor|update|fix stuff|make better)\b/i;
  if (vague.test(String(plan.task || ""))) {
    score -= 15; issues.push("task uses vague language");
  }
  // capacityDelta and requestROI are mandatory ranking inputs.
  // Plans missing either cannot be ordered by cost-effectiveness.
  if (!("capacityDelta" in plan) || !Number.isFinite(Number(plan.capacityDelta))) {
    score -= 15; issues.push("capacityDelta missing or invalid — required for ranking");
  }
  if (!("requestROI" in plan) || !Number.isFinite(Number(plan.requestROI)) || Number(plan.requestROI) <= 0) {
    score -= 15; issues.push("requestROI missing or invalid — required for ranking");
  }

  return { score: Math.max(0, score), issues };
}

/**
 * Compute a composite ranking score for a single plan.
 *
 * Formula: requestROI × (1 + capacityDelta)
 *
 * Rationale:
 *   - requestROI captures cost-effectiveness (higher = more return per premium request)
 *   - capacityDelta captures net system capacity change ([-1, 1] → multiplier [0, 2])
 *   - Plans with negative capacityDelta (risky or regressive) are down-ranked
 *   - Plans missing either field score 0 (will be filtered before ranking)
 *
 * @param {object} plan
 * @returns {number} ranking score ≥ 0
 */
export function computePlanRankScore(plan: Record<string, any>): number {
  if (!plan || typeof plan !== "object") return 0;
  const roi = Number(plan.requestROI);
  const delta = Number(plan.capacityDelta);
  if (!Number.isFinite(roi) || roi <= 0) return 0;
  if (!Number.isFinite(delta)) return 0;
  return roi * (1 + delta);
}

/**
 * Rank plans by composite ROI score (requestROI × (1 + capacityDelta)), descending.
 *
 * Plans missing or having invalid capacityDelta/requestROI sort to the end.
 * The original array is NOT mutated — a new sorted array is returned.
 * Within equal scores, original order is preserved (stable sort).
 *
 * @param {object[]} plans
 * @returns {object[]} sorted copy of plans, highest score first
 */
export function rankPlansByROI(plans: any[]): any[] {
  if (!Array.isArray(plans)) return [];
  return [...plans].sort((a, b) => computePlanRankScore(b) - computePlanRankScore(a));
}

/** Minimum quality score for a plan to pass the deterministic pre-gate. */
export const PLAN_QUALITY_MIN_SCORE = 40;

// ── Governance gate-feasibility risk scoring ──────────────────────────────────

export const GATE_BLOCK_RISK = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const);

type GateBlockRiskValue = typeof GATE_BLOCK_RISK[keyof typeof GATE_BLOCK_RISK];

export interface GateBlockRiskAssessment {
  gateBlockRisk: GateBlockRiskValue;
  reason: string;
  activeGateSignals: string[];
  requiresCorrection: boolean;
}

function gateSignalFromReason(reason: string): string {
  const prefix = String(reason || "").split(":")[0].trim().toLowerCase();
  if (!prefix) return "unknown_governance_block";
  return prefix;
}

export function computeGateBlockRiskFromSignals(signals: {
  freezeActive?: boolean;
  canaryBreachActive?: boolean;
  criticalDebtBlocked?: boolean;
  forceCheckpointActive?: boolean;
  autonomyGateNotReady?: boolean;
  autonomyGateReason?: string | null;
}): GateBlockRiskAssessment {
  const autonomyGateReason = signals.autonomyGateReason
    || (signals.autonomyGateNotReady ? AUTONOMY_EXECUTION_GATE_REASON_CODE : null);
  const activeGateSignals: string[] = [];
  if (signals.freezeActive) activeGateSignals.push("governance_freeze_active");
  if (signals.canaryBreachActive) activeGateSignals.push("governance_canary_breach");
  if (signals.criticalDebtBlocked) activeGateSignals.push("critical_debt_overdue");
  if (signals.forceCheckpointActive) activeGateSignals.push("force_checkpoint_validation_active");
  if (autonomyGateReason) activeGateSignals.push(AUTONOMY_EXECUTION_GATE_REASON_CODE);

  if (signals.freezeActive || signals.canaryBreachActive || signals.forceCheckpointActive) {
    return {
      gateBlockRisk: GATE_BLOCK_RISK.HIGH,
      reason: "Active governance freeze/canary/force-checkpoint state indicates dispatch infeasibility",
      activeGateSignals,
      requiresCorrection: true,
    };
  }

  if (signals.criticalDebtBlocked) {
    return {
      gateBlockRisk: GATE_BLOCK_RISK.MEDIUM,
      reason: "Critical carry-forward debt gate indicates dispatch infeasibility",
      activeGateSignals,
      requiresCorrection: true,
    };
  }

  if (autonomyGateReason) {
    return {
      gateBlockRisk: GATE_BLOCK_RISK.MEDIUM,
      reason: `Autonomy execution gate not ready — ${autonomyGateReason}`,
      activeGateSignals,
      requiresCorrection: false,
    };
  }

  return {
    gateBlockRisk: GATE_BLOCK_RISK.LOW,
    reason: "No active governance gate blocks detected",
    activeGateSignals: [],
    requiresCorrection: false,
  };
}

export async function assessGovernanceGateBlockRisk(config): Promise<GateBlockRiskAssessment> {
  // Probe autonomy band executionGate.exploitationReady — used in both the dry-run
  // fast-path and the fallback signal path to ensure approval confidence reflects
  // real dispatch feasibility end-to-end.
  let autonomyGateReason: string | null = null;
  try {
    const stateDir = (config as any)?.paths?.stateDir || "state";
    const autonomy = await readJson(path.join(stateDir, "autonomy_band_status.json"), null);
    autonomyGateReason = resolveAutonomyExecutionGateBlockReason(autonomy).blockReason;
  } catch { /* autonomy_band_status.json absent or unreadable — treat as ready (fail-open) */ }

  try {
    const { evaluatePreDispatchGovernanceGate } = await import("./orchestrator.js");
    const dryRunDecision = await evaluatePreDispatchGovernanceGate(
      config,
      [],
      `athena-review-dry-run-${Date.now()}`,
      null
    );
    if (dryRunDecision && typeof dryRunDecision.blocked === "boolean") {
      if (!dryRunDecision.blocked) {
        // Dry-run passed hard gates; still factor in autonomy band readiness.
        if (autonomyGateReason) {
          return {
            gateBlockRisk: GATE_BLOCK_RISK.MEDIUM,
            reason: `Governance gates clear but autonomy execution gate is blocking: ${autonomyGateReason}`,
            activeGateSignals: [AUTONOMY_EXECUTION_GATE_REASON_CODE],
            requiresCorrection: false,
          };
        }
        return {
          gateBlockRisk: GATE_BLOCK_RISK.LOW,
          reason: "Dry-run governance gate passed at review-time",
          activeGateSignals: [],
          requiresCorrection: false,
        };
      }
      const reasonSignal = gateSignalFromReason(String(dryRunDecision.reason || ""));
      const highRiskSignals = new Set([
        "governance_freeze_active",
        "governance_canary_breach",
        "force_checkpoint_validation_active",
      ]);
      const mediumRiskSignals = new Set([
        "critical_debt_overdue",
        "mandatory_drift_debt_unresolved",
        "plan_evidence_coupling_invalid",
        "dependency_readiness_incomplete",
        "rolling_yield_throttle",
        AUTONOMY_EXECUTION_GATE_REASON_CODE,
      ]);
      const risk = highRiskSignals.has(reasonSignal)
        ? GATE_BLOCK_RISK.HIGH
        : mediumRiskSignals.has(reasonSignal)
          ? GATE_BLOCK_RISK.MEDIUM
          : GATE_BLOCK_RISK.HIGH;
      const activeSignals = [reasonSignal];
      if (autonomyGateReason) activeSignals.push(AUTONOMY_EXECUTION_GATE_REASON_CODE);
      return {
        gateBlockRisk: risk,
        reason: `Dry-run governance gate blocked dispatch: ${String(dryRunDecision.reason || "unknown")}`,
        activeGateSignals: activeSignals,
        requiresCorrection: reasonSignal !== AUTONOMY_EXECUTION_GATE_REASON_CODE,
      };
    }
  } catch (err) {
    await appendProgress(config, `[ATHENA][WARN] governance dry-run evaluation failed: ${String((err as Error)?.message || err)}`);
  }

  const signals = {
    freezeActive: false,
    canaryBreachActive: false,
    criticalDebtBlocked: false,
    forceCheckpointActive: false,
    autonomyGateReason,
  };

  try {
    const freeze = isFreezeActive(config);
    signals.freezeActive = freeze.active === true;
  } catch (err) {
    await appendProgress(config, `[ATHENA][WARN] freeze state read failed: ${String((err as Error)?.message || err)}`);
  }

  try {
    const canary = await isGovernanceCanaryBreachActive(config);
    signals.canaryBreachActive = canary?.breachActive === true;
  } catch (err) {
    await appendProgress(config, `[ATHENA][WARN] canary state read failed: ${String((err as Error)?.message || err)}`);
  }

  try {
    const forceCheckpoint = await readForceCheckpointValidationContract(config);
    signals.forceCheckpointActive = forceCheckpoint.active
      && isSloCascadingBreachScenario(forceCheckpoint.scenarioId)
      && forceCheckpoint.overrideActive !== true;
  } catch (err) {
    await appendProgress(config, `[ATHENA][WARN] force-checkpoint state read failed: ${String((err as Error)?.message || err)}`);
  }

  try {
    const { entries: debtLedger, cycleCounter } = await loadLedgerMeta(config);
    const debtGate = shouldBlockOnDebt(debtLedger, cycleCounter, {
      maxCriticalOverdue: config?.carryForward?.maxCriticalOverdue,
    });
    signals.criticalDebtBlocked = debtGate.shouldBlock === true;
  } catch (err) {
    await appendProgress(config, `[ATHENA][WARN] carry-forward gate state read failed: ${String((err as Error)?.message || err)}`);
  }

  return computeGateBlockRiskFromSignals(signals);
}

/**
 * Minimum quality score that qualifies all plans for the HIGH_QUALITY_LOW_RISK
 * auto-approve fast-path (no prior cached fingerprint required).
 *
 * Plans must each score ≥ this threshold in scorePlanQuality() for the batch to
 * qualify. The bar (vs PLAN_QUALITY_MIN_SCORE=40) ensures only well-specified,
 * clearly-measurable low-risk batches bypass AI review without a prior approval.
 * Recalibrated from 80 → 65 → 60 to cut premium review requests on routine
 * high-quality batches while keeping the bar above PLAN_QUALITY_MIN_SCORE.
 */
export const AUTO_APPROVE_HIGH_QUALITY_THRESHOLD = 60;

/**
 * Quality score (0-100) that each plan in a changed low-risk batch must reach
 * for the delta-review fast path to approve the batch without a full AI call.
 *
 * Set lower than HIGH_QUALITY_LOW_RISK (60) because a prior cached review IS
 * present on disk: this path covers incremental improvements to already-reviewed
 * batches.  Plans that were reviewed before and have only minor spec changes can
 * satisfy a lower bar while still preserving meaningful quality enforcement.
 * Recalibrated from 80 → 60 → 55.
 *
 * Can be overridden via config.runtime.autoApproveDeltaReviewThreshold.
 */
export const AUTO_APPROVE_DELTA_REVIEW_THRESHOLD = 55;

const ATHENA_FRAGILE_LANE_NAMES = Object.freeze([
  "quality",
  "governance",
  "integration",
  "infrastructure",
  "observation",
]);
const ATHENA_FRAGILE_LANE_COMPLETION_THRESHOLD = 0.67;
const ATHENA_FRAGILE_LANE_ROI_THRESHOLD = 1.0;
const ATHENA_FRAGILE_LANE_ATTEMPT_THRESHOLD = 0.70;
const ATHENA_FRAGILE_LANE_PRECISION_THRESHOLD = 0.65;
const ATHENA_FRAGILE_LANE_RELIABILITY_THRESHOLD = 0.60;
const ATHENA_FRAGILE_LANE_ABSTAIN_THRESHOLD = 0.25;
const ATHENA_FRAGILE_FAST_PATH_THRESHOLD_BOOST = 20;

async function assessFragileLaneFastPathSignal(config: any, plans: any[]): Promise<{
  active: boolean;
  affectedLanes: string[];
  thresholdBoost: number;
  summary: string;
}> {
  try {
    const stateDir = config?.paths?.stateDir || "state";
    const analytics = await readJson(path.join(stateDir, "cycle_analytics.json"), null);
    const laneTelemetry = analytics?.lastCycle?.laneTelemetry ?? analytics?.laneTelemetry;
    if (!laneTelemetry || typeof laneTelemetry !== "object") {
      return { active: false, affectedLanes: [], thresholdBoost: 0, summary: "no lane telemetry" };
    }
    const planLanes = [...new Set(
      (Array.isArray(plans) ? plans : [])
        .map((plan) => getLaneForWorkerName(plan?.role, "implementation"))
        .filter((lane) => ATHENA_FRAGILE_LANE_NAMES.includes(lane))
    )];
    if (planLanes.length === 0) {
      return { active: false, affectedLanes: [], thresholdBoost: 0, summary: "no fragile lanes in batch" };
    }
    const weakLanes = planLanes.filter((lane) => {
      const telemetry = (laneTelemetry as any)?.[lane];
      const completionRate = Number(telemetry?.completionRate);
      const roi = Number(telemetry?.roi);
      const attemptRate = Number(telemetry?.attemptRate);
      const precisionOnAttempted = Number(telemetry?.precisionOnAttempted);
      const reliability = Number(telemetry?.reliability);
      const abstainRate = Number(telemetry?.abstainRate);
      return (
        (Number.isFinite(completionRate) && completionRate < ATHENA_FRAGILE_LANE_COMPLETION_THRESHOLD)
        || (Number.isFinite(roi) && roi < ATHENA_FRAGILE_LANE_ROI_THRESHOLD)
        || (Number.isFinite(attemptRate) && attemptRate < ATHENA_FRAGILE_LANE_ATTEMPT_THRESHOLD)
        || (Number.isFinite(precisionOnAttempted) && precisionOnAttempted < ATHENA_FRAGILE_LANE_PRECISION_THRESHOLD)
        || (Number.isFinite(reliability) && reliability < ATHENA_FRAGILE_LANE_RELIABILITY_THRESHOLD)
        || (Number.isFinite(abstainRate) && abstainRate > ATHENA_FRAGILE_LANE_ABSTAIN_THRESHOLD)
      );
    });
    return {
      active: weakLanes.length > 0,
      affectedLanes: weakLanes,
      thresholdBoost: weakLanes.length > 0 ? ATHENA_FRAGILE_FAST_PATH_THRESHOLD_BOOST : 0,
      summary: weakLanes.length > 0
        ? `weak fragile lanes: ${weakLanes.join(", ")}`
        : "fragile lane telemetry healthy",
    };
  } catch {
    return { active: false, affectedLanes: [], thresholdBoost: 0, summary: "lane telemetry unreadable" };
  }
}

// ── Plan Review (pre-work gate) ─────────────────────────────────────────────

function buildPlanReviewBlocker(code: string, source = "athena_reviewer") {
  return {
    stage: "athena_plan_review",
    code,
    source,
    retryable: false,
  };
}

export function hasFiniteAthenaOverallScore(review: unknown): boolean {
  if (!review || typeof review !== "object") return false;
  const score = Number((review as Record<string, unknown>).overallScore);
  return Number.isFinite(score);
}

export function formatDecisionFieldDiff(raw: any): string[] {
  const payload = pickReviewerPayload(raw);
  const statusOrVerdict = String(payload?.status || payload?.verdict || "").trim();
  const hasApprovedBoolean = typeof payload?.approved === "boolean";
  const hasPlanReviews = Array.isArray(payload?.planReviews) || Array.isArray(payload?.plan_reviews);
  const scoreRaw = payload?.overallScore;
  const scoreNum = Number(scoreRaw);
  const scoreValid = Number.isFinite(scoreNum) && scoreNum >= 1 && scoreNum <= 10;
  return [
    `approved: ${hasApprovedBoolean ? `boolean(${String(payload.approved)})` : statusOrVerdict ? `non-boolean status/verdict="${statusOrVerdict}"` : "missing"}`,
    `planReviews: ${hasPlanReviews ? "present" : "missing"}`,
    `overallScore: ${scoreValid ? `valid(${String(scoreNum)})` : `invalid(${JSON.stringify(scoreRaw)})`}`,
  ];
}

export function evaluateDecisionPacketContract(raw: any): {
  needsRetry: boolean;
  hasScoreViolation: boolean;
  violations: string[];
  fieldDiff: string[];
} {
  const payload = pickReviewerPayload(raw);
  const violations: string[] = [];
  const fieldDiff = formatDecisionFieldDiff(raw);
  const statusOrVerdict = String(payload?.status || payload?.verdict || "").trim().toLowerCase();
  const hasExplicitApproval = typeof payload?.approved === "boolean" || EXPLICIT_APPROVAL_STATUS_VALUES.has(statusOrVerdict);
  const hasPlanReviews = Array.isArray(payload?.planReviews) || Array.isArray(payload?.plan_reviews);
  const scoreNum = Number(payload?.overallScore);
  const hasValidScore = Number.isFinite(scoreNum) && scoreNum >= 1 && scoreNum <= 10;
  if (!hasExplicitApproval || !hasPlanReviews) {
    violations.push("decision packet malformed: approved and/or planReviews missing");
  }
  if (!hasValidScore) {
    violations.push("overallScore missing/invalid (must be numeric 1-10)");
  }
  return {
    needsRetry: violations.length > 0,
    hasScoreViolation: !hasValidScore,
    violations,
    fieldDiff,
  };
}

export function buildDecisionPacketRetryPrompt(basePrompt: string, contractCheck: ReturnType<typeof evaluateDecisionPacketContract>): string {
  const violations = contractCheck.violations.map((v, idx) => `${idx + 1}. ${v}`).join("\n");
  const fieldDiff = contractCheck.fieldDiff.map((v) => `- ${v}`).join("\n");
  return `${basePrompt}

## RETRY — FIX MALFORMED DECISION PACKET

Your previous response violated the decision packet contract.
Violations:
${violations}

Field diff from the previous response:
${fieldDiff}

Return a corrected ===DECISION=== packet that includes:
1. approved (boolean or explicit status/verdict),
2. overallScore (numeric 1-10),
3. planReviews (array),
4. all other required fields from the original contract.

Do not omit fields.`;
}

export async function runAthenaPlanReview(config, prometheusAnalysis) {
  const stateDir = config.paths?.stateDir || "state";
  const registry = getRoleRegistry(config);
  const athenaName = registry?.qualityReviewer?.name || "Athena";
  const athenaModel = registry?.qualityReviewer?.model || "Claude Sonnet 4.6";
  const command = config.env?.copilotCliCommand || "copilot";
  const reviewStartedAt = Date.now();
  const heartbeatMs = resolveAthenaReviewHeartbeatMs(config);

  await appendProgress(config, `[ATHENA] Plan review starting — validating Prometheus plan`);
  chatLog(stateDir, athenaName, "Plan review starting...");

  if (!prometheusAnalysis || !prometheusAnalysis.plans) {
    await appendProgress(config, `[ATHENA] No Prometheus plan to review — skipping`);
    const reason = {
      code: ATHENA_PLAN_REVIEW_REASON_CODE.NO_PLAN_PROVIDED,
      message: "No plan provided"
    };
    const blocker = buildPlanReviewBlocker(reason.code);
    await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
    return attachReviewArtifact({ approved: false, reason, blocker, corrections: [] }, [], null);
  }

  const plans = Array.isArray(prometheusAnalysis.plans) ? prometheusAnalysis.plans : [];
  const gateRisk = await assessGovernanceGateBlockRisk(config);
  const gateRiskLine = `Current governance gate feasibility risk: gateBlockRisk=${gateRisk.gateBlockRisk}; signals=${gateRisk.activeGateSignals.join("|") || "none"}; requiresCorrection=${gateRisk.requiresCorrection}`;

  // ── Deterministic plan quality pre-gate ────────────────────────────────────
  const qualityMinScore = typeof config?.runtime?.planQualityMinScore === "number"
    ? config.runtime.planQualityMinScore
    : PLAN_QUALITY_MIN_SCORE;
  const qualityFailures = [];
  for (let i = 0; i < plans.length; i++) {
    const { score, issues } = scorePlanQuality(plans[i]);
    if (score < qualityMinScore) {
      qualityFailures.push(`plan[${i}] "${plans[i]?.task || plans[i]?.role || "?"}": score=${score} — ${issues.join("; ")}`);
    }
  }
  if (qualityFailures.length > 0) {
    const message = `${qualityFailures.length} plan(s) below quality threshold (${qualityMinScore})`;
    const reason = { code: ATHENA_PLAN_REVIEW_REASON_CODE.LOW_PLAN_QUALITY, message };
    const blocker = buildPlanReviewBlocker(reason.code);
    await appendProgress(config, `[ATHENA] Plan quality pre-gate FAILED — ${message}`);
    await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
    chatLog(stateDir, athenaName, `Plan quality pre-gate failed: ${message}`);
    return attachReviewArtifact({
      approved: false,
      reason,
      blocker,
      corrections: qualityFailures
    }, plans, gateRisk);
  }

  // ── Deterministic pre-mortem gate (runs before AI, always enforced) ────────
  // High-risk plans (riskLevel="high") must include a valid pre-mortem section.
  // This gate is never bypassed by athenaFailOpen — it is a structural requirement.
  const preMortemViolations = checkPlanPremortemGate(plans);
  if (preMortemViolations.length > 0) {
    const message = `${preMortemViolations.length} high-risk plan(s) missing valid pre-mortem`;
    const reason = { code: ATHENA_PLAN_REVIEW_REASON_CODE.MISSING_PREMORTEM, message };
    const blocker = buildPlanReviewBlocker(reason.code);
    await appendProgress(config, `[ATHENA] Pre-mortem gate FAILED — ${message} — blocking dispatch`);
    await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
    chatLog(stateDir, athenaName, `Pre-mortem gate failed: ${message}`);
    await appendAlert(config, {
      severity: ALERT_SEVERITY.CRITICAL,
      source: "athena_reviewer",
      title: "High-risk plan missing pre-mortem — dispatch blocked",
      message: `code=${reason.code} violations=${JSON.stringify(preMortemViolations)}`
    });
    return attachReviewArtifact({
      approved: false,
      reason,
      blocker,
      corrections: preMortemViolations,
      preMortemViolations
    }, plans, gateRisk);
  }

  // ── Deterministic mandatory coverage gate (runs before AI and auto-approve) ──
  // If Prometheus already evaluated mandatory health-audit coverage and found gaps,
  // Athena must enforce this contract before approving any plan batch.
  // This gate is retryable — Prometheus can re-plan to address the missing findings.
  const coverageGate = prometheusAnalysis?._mandatoryTaskCoverageGate;
  if (coverageGate && typeof coverageGate === "object" && coverageGate.ok === false) {
    const missing: string[] = Array.isArray(coverageGate.missing) ? coverageGate.missing : [];
    const invalid: string[] = Array.isArray(coverageGate.invalid) ? coverageGate.invalid : [];
    if (missing.length > 0 || invalid.length > 0) {
      const gapSummary = [
        missing.length > 0 ? `missing=[${missing.slice(0, 5).join(", ")}]` : "",
        invalid.length > 0 ? `invalid=[${invalid.slice(0, 5).join(", ")}]` : "",
      ].filter(Boolean).join("; ");
      const message = `Mandatory health-audit coverage incomplete — ${gapSummary}`;
      const reason = { code: ATHENA_PLAN_REVIEW_REASON_CODE.MANDATORY_COVERAGE_INCOMPLETE, message };
      // Coverage gaps are retryable — Prometheus can re-plan to address missing findings.
      const blocker = { stage: "athena_plan_review", code: reason.code, source: "athena_reviewer", retryable: true };
      await appendProgress(config, `[ATHENA] Mandatory coverage gate FAILED — ${message}`);
      await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
      chatLog(stateDir, athenaName, `Mandatory coverage gate failed: ${message}`);
      return attachReviewArtifact({
        approved: false,
        reason,
        blocker,
        corrections: [...missing.map(id => `finding ${id} not covered`), ...invalid.map(id => `invalid coverage for ${id}`)],
      }, plans, gateRisk);
    }
  }

  // ── Deterministic auto-approve path (low-risk unchanged plan batches) ─────
  // When ALL plans are low-risk and the plan batch fingerprint matches the last
  // approved review, skip the AI call and return the cached result immediately.
  // High-risk plans (riskLevel="high") always require fresh AI review.
  // The quality pre-gate and pre-mortem gate above still run unconditionally.
  const allPlansLowRisk = plans.every(
    p => String(p.riskLevel || "low").trim().toLowerCase() !== "high"
  );
  const fragileLaneSignal = await assessFragileLaneFastPathSignal(config, plans);
  if (fragileLaneSignal.active) {
    await appendProgress(
      config,
      `[ATHENA] Fragile-lane fast-path tightened — ${fragileLaneSignal.summary} thresholdBoost=${fragileLaneSignal.thresholdBoost}`,
    );
  }
  if (allPlansLowRisk && !gateRisk.requiresCorrection && config?.runtime?.disablePlanReviewCache !== true) {
    const batchFingerprint = computePlanBatchFingerprint(plans);
    let cachedReviewExists = false;
    try {
      const lastReviewRaw = await readJson(
        path.join(stateDir, "athena_plan_review.json"),
        null
      );
      const lastReview = isAthenaReviewAlignedToTargetSession(config, lastReviewRaw)
        ? lastReviewRaw
        : null;
      if (lastReview !== null) {
        cachedReviewExists = true;
      }
      if (
        lastReview !== null &&
        lastReview.approved === true &&
        typeof lastReview.planBatchFingerprint === "string" &&
        lastReview.planBatchFingerprint === batchFingerprint &&
        !fragileLaneSignal.active
      ) {
        const shortFp = batchFingerprint.slice(0, 8);
        await appendProgress(
          config,
          `[ATHENA] Plan review AUTO-APPROVED — low-risk unchanged batch (fingerprint=${shortFp})`
        );
        chatLog(
          stateDir,
          athenaName,
          `Plan auto-approved (unchanged low-risk batch, fingerprint=${shortFp})`
        );
        return attachReviewArtifact({
          ...lastReview,
          autoApproved: true,
          autoApproveReason: {
            code: "LOW_RISK_UNCHANGED",
            message: "All plans are low-risk and unchanged since last approval"
          },
          gateBlockRisk: gateRisk.gateBlockRisk,
          gateBlockRiskAtApproval: gateRisk.gateBlockRisk,
          gateBlockSignals: gateRisk.activeGateSignals,
          reviewedAt: new Date().toISOString(),
          gateRiskRequiresCorrection: gateRisk.requiresCorrection,
        }, plans, gateRisk);
      }
    } catch {
      // Cache read is best-effort; fall through to AI review on any error.
    }

    // ── High-quality fast-path (no cached fingerprint required) ─────────────
    // When every plan scores ≥ AUTO_APPROVE_HIGH_QUALITY_THRESHOLD in the
    // deterministic quality gate, and there is NO prior cached review on disk,
    // the batch is well-specified enough to approve without a prior cached review.
    // If a cached review exists but the fingerprint does not match (plans changed),
    // we fall through to the delta-review path below.
    // Guardrail precedence is preserved: quality, pre-mortem, and governance gates
    // all ran unconditionally before reaching this point.
    if (!cachedReviewExists) {
      const highQualityThreshold = typeof config?.runtime?.autoApproveHighQualityThreshold === "number"
        ? config.runtime.autoApproveHighQualityThreshold
        : AUTO_APPROVE_HIGH_QUALITY_THRESHOLD;
      const adaptiveHighQualityThreshold = Math.min(
        95,
        highQualityThreshold + fragileLaneSignal.thresholdBoost,
      );
      const allHighQuality = plans.length > 0 &&
        plans.every(p => scorePlanQuality(p).score >= adaptiveHighQualityThreshold);
      if (allHighQuality) {
        await appendProgress(
          config,
          `[ATHENA] Plan review AUTO-APPROVED — all ${plans.length} low-risk plan(s) score ≥ ${adaptiveHighQualityThreshold}`
        );
        chatLog(
          stateDir,
          athenaName,
          `Plan auto-approved (high-quality low-risk batch, threshold=${adaptiveHighQualityThreshold})`
        );
        return attachReviewArtifact({
          approved: true,
          overallScore: adaptiveHighQualityThreshold,
          summary: `All ${plans.length} plan(s) are low-risk and scored at or above the high-quality threshold (${adaptiveHighQualityThreshold})`,
          planReviews: plans.map((p, i) => buildFallbackPlanReview(p, i)),
          corrections: [],
          appliedFixes: [],
          unresolvedIssues: [],
          autoApproved: true,
          autoApproveReason: {
            code: ATHENA_FAST_PATH_REASON.HIGH_QUALITY_LOW_RISK,
            message: `All plans are low-risk and cleared the high-quality threshold (≥ ${adaptiveHighQualityThreshold})`,
          },
          gateBlockRisk: gateRisk.gateBlockRisk,
          gateBlockRiskAtApproval: gateRisk.gateBlockRisk,
          gateBlockSignals: gateRisk.activeGateSignals,
          reviewedAt: new Date().toISOString(),
          gateRiskRequiresCorrection: gateRisk.requiresCorrection,
        }, plans, gateRisk);
      }
    }

    // ── Delta-review fast path (cached review exists, fingerprint changed) ───
    // When a prior cached review exists but the fingerprint changed (batch was
    // materially modified), still skip the AI call when every plan scores at or
    // above the delta-review threshold.  This preserves full AI review capacity
    // for genuinely high-risk or low-quality changes while allowing clean incremental
    // improvements to flow through without a premium-request spend.
    if (cachedReviewExists) {
      const deltaThreshold = typeof config?.runtime?.autoApproveDeltaReviewThreshold === "number"
        ? config.runtime.autoApproveDeltaReviewThreshold
        : AUTO_APPROVE_DELTA_REVIEW_THRESHOLD;
      const allDeltaQuality = plans.length > 0 &&
        plans.every(p => scorePlanQuality(p).score >= deltaThreshold);
      if (allDeltaQuality && !fragileLaneSignal.active) {
        await appendProgress(
          config,
          `[ATHENA] Plan review DELTA-APPROVED — all ${plans.length} changed low-risk plan(s) score ≥ ${deltaThreshold}`
        );
        chatLog(
          stateDir,
          athenaName,
          `Plan delta-approved (changed low-risk batch, threshold=${deltaThreshold})`
        );
        return attachReviewArtifact({
          approved: true,
          overallScore: deltaThreshold,
          summary: `All ${plans.length} plan(s) are low-risk with changed fingerprint and scored at or above the delta-review threshold (${deltaThreshold})`,
          planReviews: plans.map((p, i) => buildFallbackPlanReview(p, i)),
          corrections: [],
          appliedFixes: [],
          unresolvedIssues: [],
          autoApproved: true,
          autoApproveReason: {
            code: ATHENA_FAST_PATH_REASON.DELTA_REVIEW_APPROVED,
            message: `All plans are low-risk with changed fingerprint and cleared the delta-review threshold (≥ ${deltaThreshold})`,
          },
          gateBlockRisk: gateRisk.gateBlockRisk,
          gateBlockRiskAtApproval: gateRisk.gateBlockRisk,
          gateBlockSignals: gateRisk.activeGateSignals,
          reviewedAt: new Date().toISOString(),
          gateRiskRequiresCorrection: gateRisk.requiresCorrection,
        }, plans, gateRisk);
      }
    }
  }

  // ── Cross-cycle similarity gate ───────────────────────────────────────────
  // Load the previously dispatched plan tasks from dispatch_checkpoint.json.
  // If ≥60% of new plan task keywords overlap with the previous cycle, inject
  // a novelty-warning into Athena's prompt so it can flag repetitive plans.
  let similarityWarning = "";
  try {
    const prevCheckpoint = await readJson(
      path.join(stateDir, "dispatch_checkpoint.json"),
      null
    );
    const prevTasks: string[] = [];
    if (prevCheckpoint && Array.isArray(prevCheckpoint.plans)) {
      for (const p of prevCheckpoint.plans) {
        const t = String(p?.task || p?.title || "").toLowerCase().trim();
        if (t.length > 5) prevTasks.push(t);
      }
    }
    if (prevTasks.length > 0 && plans.length > 0) {
      const prevWords = new Set(prevTasks.flatMap(t => t.split(/\W+/).filter(w => w.length > 4)));
      let matchCount = 0;
      for (const plan of plans) {
        const words = String(plan?.task || "").toLowerCase().split(/\W+/).filter(w => w.length > 4);
        if (words.some(w => prevWords.has(w))) matchCount++;
      }
      const overlapRatio = matchCount / plans.length;
      if (overlapRatio >= 0.6) {
        similarityWarning = `\n\n## ⚠️ NOVELTY WARNING\nApproximately ${Math.round(overlapRatio * 100)}% of the incoming plans share key themes with the PREVIOUS cycle's dispatched plans. This is a strong signal of repetitive planning.\nFor each plan, verify: is this task semantically distinct from what was dispatched last cycle? If not, flag it in unresolvedIssues and set approved=false unless the prior implementation demonstrably failed and a retry is warranted.\nPrevious cycle task themes: ${prevTasks.slice(0, 8).join(" | ")}`;
        await appendProgress(config, `[ATHENA] Similarity gate: ${Math.round(overlapRatio * 100)}% overlap with previous cycle — novelty warning injected into review prompt`);
      }
    }
  } catch {
    // Non-fatal: proceed without similarity context.
  }

  const plansSummary = plans.map((p, i) => {
    const preMortemTag = p.riskLevel === "high" ? " [HIGH-RISK:premortem=present]" : "";
    const targetFiles = Array.isArray(p.target_files)
      ? p.target_files
      : Array.isArray(p.targetFiles)
        ? p.targetFiles
        : [];
    const ac = Array.isArray(p.acceptance_criteria) ? p.acceptance_criteria : [];
    const deps = Array.isArray(p.dependencies) ? p.dependencies : [];
      const targetFilesPreview = JSON.stringify(targetFiles.slice(0, 5));
      const acceptancePreview = JSON.stringify(ac.slice(0, 3).map((item) => truncatePromptText(item, 100)));
    return `  ${i + 1}. role=${p.role} task="${p.task}" priority=${p.priority} wave=${p.wave} riskLevel=${p.riskLevel || "low"}${preMortemTag}
       scope="${truncatePromptText(p.scope || "", 100)}"
       target_files=${targetFilesPreview}${targetFiles.length > 5 ? ` (+${targetFiles.length - 5} more)` : ""}
     dependencies=${JSON.stringify(deps)}
       before_state="${truncatePromptText(p.before_state || p.beforeState || "", 120)}"
       after_state="${truncatePromptText(p.after_state || p.afterState || "", 120)}"
       acceptance_criteria=${acceptancePreview}${ac.length > 3 ? ` (+${ac.length - 3} more)` : ""}
       premortem=${summarizePremortemForPrompt(p)}
       verification="${truncatePromptText(p.verification || "NONE", 120)}"`;
  }).join("\n");

  const athenaLayerPrompt = buildPromptAssemblyPrompt({ agentName: "athena", config });
  const effectivePromptTargetRepo = resolvePromptTargetRepo(config);

  const contextPrompt = `TARGET REPO: ${effectivePromptTargetRepo}
${similarityWarning}
${athenaLayerPrompt}

## YOUR MISSION — PLAN QUALITY REVIEW & IN-PLACE REPAIR

You are Athena — BOX Quality Gate & Plan Editor.
Prometheus has produced a plan. Your job is to validate it AND FIX any issues you find — all in this single response.

**CRITICAL WORKFLOW:**
1. Review each plan item against the quality criteria below.
2. If you find fixable issues (dependency conflicts, missing numeric thresholds, vague acceptance criteria, wave conflicts, missing fields), FIX THEM DIRECTLY and return the corrected plans in "patchedPlans".
3. Set "approved": true if you were able to fix all issues. Only set "approved": false if there are UNFIXABLE structural problems (e.g., the entire plan is fundamentally wrong, or the task is impossible).
4. List what you fixed in "appliedFixes" and anything you could NOT fix in "unresolvedIssues".
5. Batch-packaging directive (MANDATORY): read all tasks and regroup them into execution packets that maximize useful model context usage without overloading the model; prefer fewer dense packets, merge strongly related tasks, and keep strict sequential order where dependencies exist.
6. CI fix packets MUST carry concrete CI failure evidence in githubCiContext.failedCiRuns so dispatch can inject deterministic failure context.
7. Merge-oriented packets MUST require clean-tree raw verification artifacts in completion evidence: BOX_MERGED_SHA, plus either CLEAN_TREE_STATUS=clean from git status --porcelain or the shared-worktree-safe trio CLEAN_TREE_STATUS=dirty-other-tasks-only + TASK_SCOPED_CLEAN_STATUS=clean + TASK_SCOPED_CLEAN_TARGETS=<files>, plus explicit ===NPM TEST OUTPUT START===...===NPM TEST OUTPUT END=== block.

**Quality criteria for each plan item:**
1. Is the goal measurable? (not vague like "improve" or "refactor")
2. Is there a clear success criterion? (what does "done" look like?)
3. Is the verification method concrete? (a test, a command, a check — not "verify it works")
4. Are file paths and scope specified?
5. Are dependencies between plans correct? (if two plans touch the same file, prefer explicit ordering dependencies first; only split into different waves when cross-role parallel execution would create a write race)
5b. Premium request efficiency: if low/medium-risk plans can be executed by the same role without dependency conflict, keep them in the SAME wave and use dependencies for order instead of creating extra singleton waves.
5c. Token-capacity efficiency: avoid tiny packets; prefer filling one worker context meaningfully before splitting.
6. Do acceptance_criteria contain measurable numeric thresholds where applicable?
7. For HIGH-RISK plans (riskLevel=high): does the pre-mortem cover failure paths, mitigations, and guardrails?

**COMMON FIXES you should apply directly:**
- Two plans touching the same file in the same wave:
  - if same role and safely orderable, keep same wave and add dependency from later plan to earlier plan
  - if different roles or true parallel race risk, move later plan to next wave and add dependency
- Mergeable small plans policy:
  - if same role + low/medium risk + no hard dependency barrier, merge into one role session/wave and keep deterministic order via dependencies
  - only split into another wave when there is a true dependency or cross-role race barrier
- Vague acceptance criteria → rewrite with numeric threshold (e.g., "fallback rate < 5%")
- Missing verification → add a concrete test command referencing a specific test file path, e.g. npm test -- tests/core/foo.test.ts or npm test -- tests/core/foo.test.ts — test: expected description. NEVER write just "npm test" or "npm test -- --grep 'pattern'" alone — always include the test file path like "npm test -- tests/core/foo.test.ts".
- Missing scope → fill from target_files

## PROMETHEUS PLAN TO REVIEW

Project Health: ${prometheusAnalysis.projectHealth || "unknown"}
Analysis: ${String(prometheusAnalysis.analysis || "").slice(0, 2000)}
Key Findings: ${String(prometheusAnalysis.keyFindings || "").slice(0, 1000)}

Plans (${plans.length}):
${plansSummary}

Execution Strategy: ${JSON.stringify(prometheusAnalysis.executionStrategy || {}, null, 2).slice(0, 1500)}

Request Budget: ${JSON.stringify(prometheusAnalysis.requestBudget || {}, null, 2).slice(0, 500)}

Governance Gate State: ${gateRiskLine}

## OUTPUT FORMAT

Respond with your assessment, then:

===DECISION===
{
  "approved": true/false,
  "overallScore": 1-10,
  "summary": "Brief assessment of plan quality",
  "appliedFixes": ["list of fixes you applied to the plans"],
  "unresolvedIssues": ["list of issues you could NOT fix — only if approved=false"],
  "patchedPlans": [
    {
      "role": "worker name",
      "task": "exact task description (fixed if needed)",
      "priority": 1,
      "wave": 1,
      "dependencies": [],
      "target_files": ["file paths"],
      "scope": "scope description",
      "before_state": "current state",
      "after_state": "desired state",
      "acceptance_criteria": ["measurable criteria with numeric thresholds"],
      "verification": "npm test -- tests/core/foo.test.ts — test: expected description (use a specific test file path, NOT --grep alone)",
      "riskLevel": "low",
      "_batchIndex": 1,
      "_batchTotal": 2,
      "_batchWave": 1,
      "_batchWorkerRole": "evolution-worker"
    }
  ],
  "planReviews": [
    {
      "planIndex": 0,
      "role": "worker name",
      "measurable": true/false,
      "successCriteriaClear": true/false,
      "verificationConcrete": true/false,
      "scopeDefined": true/false,
      "preMortemComplete": true/false,
      "issues": ["list of problems found (before fix)"],
      "suggestion": "what was fixed or why it could not be fixed"
    }
  ],
  "corrections": ["only if approved=false: list of mandatory corrections that need external intervention"],
  "missingMetrics": ["metrics that should be tracked but aren't"],
  "lessonsFromPast": "any relevant observations from past postmortems"
}
===END===

IMPORTANT: Always include "patchedPlans" with the FULL corrected plan array. Even if no changes were needed, return the original plans as-is in patchedPlans.
IMPORTANT: Every patched plan MUST include AI-assigned batch metadata fields: _batchIndex, _batchTotal, _batchWave, _batchWorkerRole. Do NOT omit them.`;

  let heartbeatTimer: NodeJS.Timeout | null;
  try {
    heartbeatTimer = setInterval(() => {
      const elapsedMs = Date.now() - reviewStartedAt;
      const elapsedSec = Math.floor(elapsedMs / 1000);
      void appendProgress(
        config,
        `[ATHENA] Plan review in progress — elapsed=${elapsedSec}s model=${athenaModel}`
      );
    }, heartbeatMs);
    if (heartbeatTimer && typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }
  } catch {
    // Heartbeat is best-effort observability; review continues without it.
  }

  let aiResult;
  try {
    aiResult = await callCopilotAgent(command, "athena", contextPrompt, config, athenaModel);
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }

  if (!aiResult.ok || !aiResult.parsed) {
    // Fail-closed: AI failure must never silently approve the plan.
    const reason = { code: ATHENA_PLAN_REVIEW_REASON_CODE.AI_CALL_FAILED, message: (aiResult as any).error || "No JSON returned from AI" };
    const blocker = {
      stage: "athena_plan_review",
      code: reason.code,
      source: "athena_reviewer",
      retryable: false,
    };
    await appendProgress(config, `[ATHENA] Plan review AI call failed — ${reason.message} — blocking plan (fail-closed)`);
    await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
    chatLog(stateDir, athenaName, `AI failed: ${reason.message} — plan blocked`);
    await appendAlert(config, {
      severity: ALERT_SEVERITY.CRITICAL,
      source: "athena_reviewer",
      title: "Plan review AI call failed — plan blocked",
      message: `code=${reason.code} message=${reason.message}`
    });
    return attachReviewArtifact({ approved: false, reason, blocker, corrections: [] }, plans, gateRisk);
  }

  const initialContractCheck = evaluateDecisionPacketContract(aiResult.parsed);
  if (initialContractCheck.needsRetry) {
    await appendProgress(
      config,
      `[ATHENA] Decision packet contract mismatch on first attempt — retrying once with explicit field diff: ${initialContractCheck.fieldDiff.join(" | ")}`
    );
    const retryPrompt = buildDecisionPacketRetryPrompt(contextPrompt, initialContractCheck);
    const retryResult = await callCopilotAgent(command, "athena", retryPrompt, config, athenaModel);
    if (!retryResult.ok || !retryResult.parsed) {
      const reason = {
        code: ATHENA_PLAN_REVIEW_REASON_CODE.AI_CALL_FAILED,
        message: `Retry failed after decision-packet contract mismatch: ${(retryResult as any).error || "No JSON returned from AI"}`
      };
      const blocker = buildPlanReviewBlocker(reason.code);
      await appendProgress(config, `[ATHENA] Decision packet retry failed — ${reason.message} — blocking plan (fail-closed)`);
      await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "athena_reviewer",
        title: "Decision packet retry failed — plan blocked",
        message: `code=${reason.code} message=${reason.message}`
      });
      return attachReviewArtifact({ approved: false, reason, blocker, corrections: [] }, plans, gateRisk);
    }
    aiResult = retryResult;
    const retryContractCheck = evaluateDecisionPacketContract(aiResult.parsed);
    if (retryContractCheck.needsRetry) {
      const code = retryContractCheck.hasScoreViolation
        ? ATHENA_PLAN_REVIEW_REASON_CODE.SCORE_CONTRACT_VIOLATION
        : ATHENA_PLAN_REVIEW_REASON_CODE.MALFORMED_DECISION_PACKET;
      const reason = {
        code,
        message: `Decision packet contract still invalid after retry: ${retryContractCheck.violations.join("; ")}`
      };
      const blocker = buildPlanReviewBlocker(reason.code);
      await appendProgress(config, `[ATHENA] Plan review REJECTED — ${reason.message}`);
      await appendProgress(config, `[ATHENA] Decision packet field diff after retry: ${retryContractCheck.fieldDiff.join(" | ")}`);
      await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "athena_reviewer",
        title: "Decision packet contract violation after retry — plan blocked",
        message: `code=${reason.code} violations=${retryContractCheck.violations.join(" | ")}`
      });
      return attachReviewArtifact({ approved: false, reason, blocker, corrections: [] }, plans, gateRisk);
    }
  }

  logAgentThinking(stateDir, athenaName, aiResult.thinking);

  // ── Trust boundary validation ────────────────────────────────────────────
  const tbMode = config?.runtime?.trustBoundaryMode === "warn" ? "warn" : "enforce";
  const normalizedReview = normalizeAthenaReviewPayload(aiResult.parsed, plans);
  if (normalizedReview.synthesizedFields.length > 0) {
    await appendProgress(config,
      `[ATHENA] Reviewer payload normalized before trust-boundary validation — synthesized=${normalizedReview.synthesizedFields.join(",")}`
    );
  }

  // ── Mandatory actionable-packet field guard ─────────────────────────────
  // Explicit rejection when the AI omits fields that must not be synthesized.
  // Aliases (e.g. plan_reviews, status) are accepted; pure fallback synthesis is not.
  // Before hard-rejecting, attempt deterministic correction of bounded low-risk defects:
  //   - `approved` absent but planReviews all pass → safe to infer approved=true.
  //   - `planReviews` absent but explicit approved + all low-risk plans → accept synthetic reviews.
  const missingMandatory = normalizedReview.missingFields.filter(
    (f) => (MANDATORY_ACTIONABLE_PACKET_FIELDS as readonly string[]).includes(f)
  );
  if (missingMandatory.length > 0) {
    const defectCorrection = correctBoundedPacketDefects(normalizedReview, plans);
    const uncorrectableMissing = defectCorrection.updatedMissingFields.filter(
      (f) => (MANDATORY_ACTIONABLE_PACKET_FIELDS as readonly string[]).includes(f)
    );

    if (uncorrectableMissing.length > 0) {
      // Correction could not resolve all missing mandatory fields — hard reject.
      const reason = {
        code: ATHENA_PLAN_REVIEW_REASON_CODE.MISSING_ACTIONABLE_PACKET_FIELDS,
        message: `Reviewer response is missing mandatory fields (${uncorrectableMissing.join(", ")}) — explicit values required, synthesis not permitted`
      };
      const blocker = buildPlanReviewBlocker(reason.code);
      await appendProgress(config, `[ATHENA] Plan review REJECTED — ${reason.message}`);
      await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
      chatLog(stateDir, athenaName, `Plan review rejected: missing mandatory fields ${uncorrectableMissing.join(", ")}`);
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "athena_reviewer",
        title: "Reviewer response missing mandatory actionable-packet fields — plan blocked",
        message: `code=${reason.code} fields=${uncorrectableMissing.join(",")}`
      });
      return attachReviewArtifact({ approved: false, reason, blocker, corrections: [] }, plans, gateRisk);
    }

    // All missing mandatory fields were corrected — update the payload and continue.
    await appendProgress(
      config,
      `[ATHENA] Bounded packet format defects auto-corrected: ${defectCorrection.correctedFields.join(", ")} (${defectCorrection.defectCodes.join(", ")}) — proceeding with corrected payload`
    );
    Object.assign(normalizedReview.payload, defectCorrection.updatedPayload);
  }

  const trustCheck = validateLeadershipContract(
    LEADERSHIP_CONTRACT_TYPE.REVIEWER, normalizedReview.payload, { mode: tbMode }
  );
  if (!trustCheck.ok && tbMode === "enforce") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    const reason = {
      code: ATHENA_PLAN_REVIEW_REASON_CODE.TRUST_BOUNDARY_VIOLATION,
      message: `Reviewer output failed contract validation — class=${TRUST_BOUNDARY_ERROR} reasonCode=${trustCheck.reasonCode}: ${tbErrors}`
    };
    const blocker = buildPlanReviewBlocker(reason.code);
    await appendProgress(config, `[ATHENA][TRUST_BOUNDARY] Reviewer output blocked — ${reason.message}`);
    await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
    await appendAlert(config, {
      severity: ALERT_SEVERITY.CRITICAL,
      source: "athena_reviewer",
      title: "Reviewer output failed trust-boundary validation — plan blocked",
      message: `code=${reason.code} errors=${tbErrors}`
    });
    return attachReviewArtifact({ approved: false, reason, blocker, corrections: [] }, plans, gateRisk);
  }
  if (trustCheck.errors.length > 0 && tbMode === "warn") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    await appendProgress(config, `[ATHENA][TRUST_BOUNDARY][WARN] Contract violations (warn mode, not blocking): ${tbErrors}`);
  }

  const d = normalizedReview.payload;
  const approved = d.approved !== false;
  const corrections = Array.isArray(d.corrections) ? d.corrections : [];

  const result = {
    approved,
    overallScore: Number.isFinite(Number(d.overallScore))
      ? Math.max(approved ? 1 : 0, Math.min(10, Number(d.overallScore)))
      : (approved ? 1 : 0),
    summary: d.summary || "",
    planReviews: Array.isArray(d.planReviews) ? d.planReviews : [],
    corrections,
    missingMetrics: Array.isArray(d.missingMetrics) ? d.missingMetrics : [],
    patchedPlans: Array.isArray(d.patchedPlans) ? d.patchedPlans : null,
    appliedFixes: Array.isArray(d.appliedFixes) ? d.appliedFixes : [],
    unresolvedIssues: Array.isArray(d.unresolvedIssues) ? d.unresolvedIssues : [],
    correctionMutations: [] as Array<Record<string, unknown>>,
    gateBlockRisk: gateRisk.gateBlockRisk,
    gateBlockRiskReason: gateRisk.reason,
    gateBlockSignals: gateRisk.activeGateSignals,
    gateRiskRequiresCorrection: gateRisk.requiresCorrection,
    reviewedAt: new Date().toISOString(),
    model: athenaModel
  };

  // Penalize and require correction when active governance state indicates dispatch infeasibility.
  if (gateRisk.requiresCorrection) {
    const penalty = gateRisk.gateBlockRisk === GATE_BLOCK_RISK.HIGH ? 4 : 2;
    result.overallScore = Math.max(1, Number(result.overallScore || 1) - penalty);

    const correction = `Pre-dispatch governance state infeasible (${gateRisk.activeGateSignals.join(", ") || "unknown"}) — resolve active gate before dispatch`;
    if (!result.corrections.includes(correction)) result.corrections.push(correction);
    if (!result.unresolvedIssues.includes(correction)) result.unresolvedIssues.push(correction);

    result.approved = false;
    const reason = {
      code: ATHENA_PLAN_REVIEW_REASON_CODE.ACTIVE_GOVERNANCE_GATE_INFEASIBLE,
      message: `${gateRisk.reason}; gateBlockRisk=${gateRisk.gateBlockRisk}; signals=${gateRisk.activeGateSignals.join(", ") || "none"}`
    };
    const blocker = buildPlanReviewBlocker(reason.code);
    await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
    (result as any).reason = reason;
    (result as any).blocker = blocker;
  }

  // ── Patched-plan validation gate ─────────────────────────────────────────
  // Block approval when Athena's patchedPlans contain unresolved target-file placeholders
  // or are missing mandatory packet fields (target_files, scope, acceptance_criteria).
  // Individual-plan validation runs before normalization so raw AI output is checked first.
  if (Array.isArray(result.patchedPlans) && result.patchedPlans.length > 0) {
    const patchedPlanIssues: string[] = [];
    for (let pi = 0; pi < result.patchedPlans.length; pi++) {
      const vResult = validatePatchedPlan(result.patchedPlans[pi]);
      if (!vResult.valid) {
        patchedPlanIssues.push(`plan[${pi}]: ${vResult.issues.join("; ")}`);
      }
    }
    if (patchedPlanIssues.length > 0) {
      const blockReason = {
        code: ATHENA_PLAN_REVIEW_REASON_CODE.PATCHED_PLAN_VALIDATION_FAILED,
        message: `Patched plans contain unresolved placeholders or missing mandatory fields: ${patchedPlanIssues.join(" | ")}`
      };
      const blocker = buildPlanReviewBlocker(blockReason.code);
      await appendProgress(config, `[ATHENA] Plan review BLOCKED — ${blockReason.message}`);
      await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
      chatLog(stateDir, athenaName, `Patched plan validation failed: ${patchedPlanIssues.join(" | ")}`);
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "athena_reviewer",
        title: "Patched plans contain unresolved placeholders or missing mandatory fields",
        message: `code=${blockReason.code} issues=${patchedPlanIssues.slice(0, 3).join(" | ")}`
      });
      return attachReviewArtifact({
        ...result,
        approved: false,
        corrections: [...corrections, ...patchedPlanIssues],
        reason: blockReason,
        blocker,
      }, plans, gateRisk);
    }
  }

  // ── Cross-cycle dependency normalization ──────────────────────────────────
  // Convert cross-cycle prose markers in dependencies into explicit
  // dispatchPrerequisite metadata during handoff normalization. Dispatch
  // enforcement happens in orchestrator evaluatePreDispatchGovernanceGate.

  // ── Patched-plan normalization + contract re-validation at handoff ────────
  // Required for EVERY patchedPlans array (including empty) before dispatch handoff.
  // preparePatchedPlansForDispatch atomically normalizes dispatch-critical fields and
  // re-validates the contract — fails closed on any violation so dispatch never receives
  // plans that bypass the normalization pipeline.
  if (Array.isArray(result.patchedPlans)) {
    const handoff = preparePatchedPlansForDispatch(result.patchedPlans);
    if (!handoff.valid) {
      const blockReason = {
        code: handoff.code,
        message: `Normalized patched plans failed contract re-validation: ${handoff.violations.join(" | ")}`
      };
      const blocker = buildPlanReviewBlocker(blockReason.code);
      await appendProgress(config, `[ATHENA] Patched plan contract re-validation FAILED — ${blockReason.message}`);
      await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
      chatLog(stateDir, athenaName, `Contract re-validation failed: ${handoff.violations.join(" | ")}`);
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "athena_reviewer",
        title: "Patched plans failed contract re-validation after normalization",
        message: `code=${blockReason.code} violations=${handoff.violations.slice(0, 3).join(" | ")}`
      });
      return attachReviewArtifact({
        ...result,
        approved: false,
        corrections: [...corrections, ...handoff.violations],
        reason: blockReason,
        blocker,
      }, plans, gateRisk);
    }

    // ── AI batch-metadata contract gate ─────────────────────────────────────
    // Athena must return explicit batch assignments. We do not synthesize
    // deterministic batch indexes at this seam.
    //
    // Auto-normalize _batchTotal: Athena sometimes sets _batchTotal to the
    // per-batch plan count instead of the global batch count, producing
    // inconsistent values across plans (e.g. 1,2). Repair by setting every
    // plan's _batchTotal to max(_batchIndex) across all plans so all plans
    // agree on a single consistent value before the gate fires.
    {
      const maxBatchIndex = Math.max(
        ...handoff.plans.map((p: any) => Number(p?._batchIndex) || 0)
      );
      if (Number.isFinite(maxBatchIndex) && maxBatchIndex > 0) {
        for (const p of handoff.plans as any[]) {
          const bt = Number(p._batchTotal);
          if (!Number.isFinite(bt) || bt !== maxBatchIndex) {
            p._batchTotal = maxBatchIndex;
          }
        }
      }
    }
    const aiBatchCheck = validateAiProvidedBatchMetadata(handoff.plans);
    if (!aiBatchCheck.valid) {
      const blockReason = {
        code: ATHENA_PLAN_REVIEW_REASON_CODE.ATHENA_BATCH_METADATA_MISSING,
        message: `Athena patchedPlans missing/invalid AI batch metadata: ${aiBatchCheck.violations.join(" | ")}`
      };
      const blocker = buildPlanReviewBlocker(blockReason.code);
      await appendProgress(config, `[ATHENA] AI batch contract FAILED — ${blockReason.message}`);
      await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
      chatLog(stateDir, athenaName, `AI batch contract failed: ${aiBatchCheck.violations.join(" | ")}`);
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "athena_reviewer",
        title: "Patched plans missing AI batch metadata",
        message: `code=${blockReason.code} violations=${aiBatchCheck.violations.slice(0, 3).join(" | ")}`
      });
      return attachReviewArtifact({
        ...result,
        approved: false,
        corrections: [...corrections, ...aiBatchCheck.violations],
        reason: blockReason,
        blocker,
      }, plans, gateRisk);
    }

    const batchCount = handoff.plans.length > 0
      ? Math.max(...handoff.plans.map(p => Number((p as any)._batchTotal ?? 1)))
      : 0;
    await appendProgress(config,
      `[ATHENA] AI-provided batching accepted: ${handoff.plans.length} plan(s) across ${batchCount} batch(es)`
    );
    result.patchedPlans = handoff.plans;

    // Populate corrections[] with structured repair entries for patchedPlans changes.
    // Downstream consumers (self-improvement, recurrence_detector, cycle_analytics) read
    // corrections[] to detect recurring defect patterns — empty corrections on an approved
    // cycle with repairs produces false signal that the plan was clean.
    if (Array.isArray(plans) && handoff.plans.length > 0) {
      const tracking = buildPatchedPlanCorrectionTracking(plans, handoff.plans);
      for (const entry of tracking.legacyCorrections) {
        if (!result.corrections.includes(entry)) result.corrections.push(entry);
      }
      if (tracking.mutationEvents.length > 0) {
        result.correctionMutations.push(...tracking.mutationEvents);
      }
    }
    // Populate corrections[] for fields that the reviewer payload omitted and were synthesized.
    for (const field of normalizedReview.synthesizedFields) {
      const entry = `[SYNTHESIZED] ${field} was absent from reviewer payload and inferred automatically`;
      if (!result.corrections.includes(entry)) result.corrections.push(entry);
    }
  }

  if (!result.approved && !(result as any).reason) {
    (result as any).reason = {
      code: ATHENA_PLAN_REVIEW_REASON_CODE.LOW_PLAN_QUALITY,
      message: "Plan rejected without explicit reason from reviewer payload",
    };
  }
  if (!result.approved && !(result as any).blocker) {
    const blockerCode = String(((result as any).reason as { code?: string } | undefined)?.code || ATHENA_PLAN_REVIEW_REASON_CODE.LOW_PLAN_QUALITY);
    (result as any).blocker = buildPlanReviewBlocker(blockerCode);
    await appendProgress(
      config,
      `[ATHENA][BLOCKER] code=${(result as any).blocker.code} stage=${(result as any).blocker.stage} retryable=${String((result as any).blocker.retryable)}`
    );
  }

  const enrichedResult = attachReviewArtifact(result, plans, gateRisk);
  const persistedReview = stampAthenaArtifactTargetSession(config, {
    ...enrichedResult,
    summary: sanitizeAthenaReviewFieldForPersistence(String(enrichedResult.summary || "")),
    planBatchFingerprint: computePlanBatchFingerprint(plans),
  });
  await writeJson(path.join(stateDir, "athena_plan_review.json"), persistedReview);
  if (persistedReview.targetSession) {
    (enrichedResult as any).targetSession = persistedReview.targetSession;
  } else if ((enrichedResult as any).targetSession) {
    delete (enrichedResult as any).targetSession;
  }

  if (enrichedResult.approved) {
    const fixCount = enrichedResult.appliedFixes.length;
    const fixMsg = fixCount > 0 ? ` (${fixCount} fix(es) applied in-place)` : "";
    await appendProgress(config, `[ATHENA] Plan APPROVED (score=${enrichedResult.overallScore}/10)${fixMsg} — ${enrichedResult.summary}`);
    chatLog(stateDir, athenaName, `Plan approved: score=${enrichedResult.overallScore}/10${fixMsg}`);
  } else {
    await appendProgress(config, `[ATHENA] Plan REJECTED — corrections needed: ${corrections.join("; ")}`);
    chatLog(stateDir, athenaName, `Plan rejected: ${corrections.join("; ")}`);
  }

  return enrichedResult;
}

// ── Deterministic postmortem fast-path ───────────────────────────────────────

/**
 * Check if the current worker result is materially identical to the last postmortem.
 * If so, the AI postmortem call can be skipped (review-on-delta mode).
 *
 * @param {object} workerResult
 * @param {object[]} pastPostmortems
 * @returns {boolean} true if result is a duplicate of the last postmortem
 */
function isDuplicateResult(workerResult, pastPostmortems) {
  if (!Array.isArray(pastPostmortems) || pastPostmortems.length === 0) return false;
  const last = pastPostmortems[pastPostmortems.length - 1];
  if (!last) return false;
  const workerName = workerResult?.roleName || workerResult?.role || "";
  if (last.workerName !== workerName) return false;
  const currentSummary = String(workerResult?.summary || "").slice(0, 200);
  const lastOutcome = String(last.actualOutcome || "").slice(0, 200);
  return currentSummary.length > 20 && currentSummary === lastOutcome;
}

/**
 * Classify a postmortem's defect channel: "product" vs "infra".
 * Infra defects are environment/tooling issues (glob, CI, Docker, etc.)
 * that do not reflect actual code quality problems.
 *
 * @param {object} opts
 * @param {string} [opts.deviation] — "none" | "minor" | "major"
 * @param {string} [opts.lessonLearned]
 * @param {string} [opts.actualOutcome]
 * @param {string} [opts.primaryClass] — failure_classifier class if available
 * @returns {{ channel: "product"|"infra", tag: string|null }}
 */
export function classifyDefectChannel(opts: any = {}) {
  const lesson = String(opts.lessonLearned || "").toLowerCase();
  const outcome = String(opts.actualOutcome || "").toLowerCase();
  const combined = `${lesson} ${outcome}`;

  const infraPatterns = [
    /glob/i, /false.?fail/i, /ci\b.*\bpipeline/i, /docker/i,
    /timeout/i, /enoent/i, /permission denied/i, /rate.?limit/i,
    /network/i, /dns/i, /certificate/i
  ];
  for (const p of infraPatterns) {
    if (p.test(combined)) {
      const tag = p.source.includes("glob") || p.source.includes("false") ? "infra_false_fail" : "infra_env";
      return { channel: "infra", tag };
    }
  }

  if (opts.primaryClass === "environment" || opts.primaryClass === "external_api") {
    return { channel: "infra", tag: "infra_env" };
  }

  return { channel: "product", tag: null };
}

/**
 * Build a deterministic postmortem record for clean worker passes.
 * Avoids an AI premium-request call when all verification evidence is green.
 *
 * @param {object} workerResult  — worker execution result
 * @param {object} originalPlan  — original plan dispatched to worker
 * @param {object} dql           — decision quality label from computeDecisionQualityLabel
 * @returns {object} postmortem record matching the AI postmortem schema
 */
function computeDeterministicPostmortem(workerResult, originalPlan, dql) {
  const executionReport = workerResult?.executionReport && typeof workerResult.executionReport === "object"
    ? workerResult.executionReport
    : buildWorkerExecutionReportArtifact(workerResult);
  const planArtifact = getPrometheusPlanArtifact(originalPlan);
  const workerName = executionReport.roleName || workerResult?.roleName || workerResult?.role || "unknown";
  return {
    workerName,
    taskCompleted: true,
    expectedOutcome: planArtifact?.task || originalPlan?.task || "task completion",
    actualOutcome: `Worker completed successfully. BUILD=${executionReport.verificationEvidence.build}; TESTS=${executionReport.verificationEvidence.tests}.`,
    deviation: "none",
    successCriteriaMet: true,
    lessonLearned: "Clean pass — no issues detected by verification gate.",
    qualityScore: 8,
    followUpNeeded: false,
    followUpTask: "",
    recommendation: "proceed",
    defectChannel: "product",
    defectChannelTag: null,
    decisionQualityLabel: dql.label,
    decisionQualityLabelReason: dql.reason,
    decisionQualityStatus: dql.status,
    reviewStatus: POSTMORTEM_REVIEW_STATUS.LEARNING_GRADE,
    learningGradeEligible: true,
    reviewedAt: new Date().toISOString(),
    model: "deterministic"
  };
}

function buildPostmortemTaskFingerprint(originalPlan: any, planArtifact: any): string {
  const taskKind = String(planArtifact?.taskKind || originalPlan?.taskKind || "general").trim() || "general";
  const task = String(planArtifact?.task || originalPlan?.task || "").trim();
  return buildTaskFingerprint(taskKind, task);
}

function buildPostmortemLifecycleEvidenceEnvelope(
  workerResult: EvidenceEnvelope,
  originalPlan: any,
  postmortem: Record<string, unknown>,
): PostmortemLifecycleEvidenceEnvelope | null {
  const planArtifact = getPrometheusPlanArtifact(originalPlan);
  const task = String(planArtifact?.task || originalPlan?.task || "").trim();
  if (!task) return null;

  const dispatchContract = workerResult?.dispatchContract && typeof workerResult.dispatchContract === "object"
    ? workerResult.dispatchContract as DispatchContractSnapshot
    : {};
  const replayClosure = dispatchContract?.replayClosure && typeof dispatchContract.replayClosure === "object"
    ? dispatchContract.replayClosure
    : {};
  const implementationEvidence = extractImplementationEvidencePaths(workerResult?.filesTouched);
  const verifiedClosure =
    String(workerResult?.status || "").toLowerCase() === "done"
    && postmortem?.taskCompleted === true
    && dispatchContract?.doneWorkerWithVerificationReportEvidence === true
    && replayClosure?.contractSatisfied === true
    && dispatchContract?.closureBoundaryViolation !== true;
  const verifiedContinuation =
    String(workerResult?.status || "").toLowerCase() === "partial"
    && implementationEvidence.length > 0;

  let lifecycleState: PostmortemLifecycleEvidenceEnvelope["lifecycleState"] | null = null;
  if (verifiedClosure) {
    lifecycleState = POSTMORTEM_LIFECYCLE_STATE.CLOSED;
  } else if (verifiedContinuation) {
    lifecycleState = POSTMORTEM_LIFECYCLE_STATE.CONTINUING;
  } else if (postmortem?.taskCompleted === true) {
    lifecycleState = POSTMORTEM_LIFECYCLE_STATE.UNVERIFIED_COMPLETION_CLAIM;
  }
  if (!lifecycleState) return null;

  return {
    schemaVersion: 1,
    source: "athena_postmortem",
    task,
    taskIdentity: normalizePlanIdentity(task),
    continuationFamilyKey: derivePlanContinuationFamilyKey({
      ...planArtifact,
      ...originalPlan,
      task,
      targetFiles: planArtifact?.targetFiles ?? originalPlan?.targetFiles ?? originalPlan?.target_files,
    }),
    lifecycleState,
    advisoryOnly: !verifiedClosure && !verifiedContinuation,
    verified: verifiedClosure || verifiedContinuation,
    implementationEvidence,
    verification: {
      verificationPassed: typeof workerResult?.verificationPassed === "boolean"
        ? workerResult.verificationPassed
        : null,
      doneWorkerWithVerificationReportEvidence: dispatchContract?.doneWorkerWithVerificationReportEvidence === true,
      doneWorkerWithCleanTreeStatusEvidence: dispatchContract?.doneWorkerWithCleanTreeStatusEvidence === true,
      replayClosureSatisfied: replayClosure?.contractSatisfied === true,
      closureBoundaryViolation: dispatchContract?.closureBoundaryViolation === true,
    },
    emittedAt: new Date().toISOString(),
  };
}

function scoreRecurrenceWeightedPriority(postmortem: any): number {
  const rec = Number(postmortem?.recurrenceCount || 1);
  const followUp = postmortem?.followUpNeeded === true || String(postmortem?.followUpTask || "").trim().length > 0 ? 1 : 0;
  const unresolved = postmortem?.interventionClosedAt ? 0 : 1;
  const severityWeight = String(postmortem?.deviation || "").toLowerCase() === "major" ? 3
    : String(postmortem?.deviation || "").toLowerCase() === "minor" ? 2
      : 1;
  return (rec * 10) + (followUp * 5) + (unresolved * 3) + severityWeight;
}

function buildPostmortemInterventionClosure(postmortem: any, recurrences: any[]): any {
  const normalizedTask = String(postmortem?.followUpTask || "").trim().toLowerCase();
  const duplicate = recurrences.find((r: any) => String(r?.tag || "").toLowerCase() === String(postmortem?.defectChannelTag || "").toLowerCase());
  return {
    interventionId: postmortem?.interventionId || `pm-${Date.now().toString(36)}`,
    duplicateSuppressed: Boolean(duplicate),
    recurrenceCount: Number(duplicate?.count || postmortem?.recurrenceCount || 1),
    closureStatus: postmortem?.followUpNeeded === true && !postmortem?.interventionClosedAt ? "open" : "closed",
    closureTrackedTask: normalizedTask || null,
  };
}

// ── Postmortem (post-work review) ────────────────────────────────────────────

/**
 * Attempt to auto-close any carry-forward debt items resolved by the current task.
 * Also compresses duplicate open debt entries after auto-close.
 * Non-fatal: logs and swallows errors so postmortem flow is never blocked.
 *
 * @param {object} config
 * @param {string} taskText   — original plan task text used for fingerprint matching
 * @param {string} evidenceStr — verification evidence string (must be >= 5 chars to qualify)
 */
async function attemptCarryForwardAutoClose(
  config: any,
  taskText: string,
  evidenceStr: string
): Promise<void> {
  if (taskText.length < 10 || evidenceStr.length < 5) return;
  try {
    const { entries: debtLedger, cycleCounter } = await loadLedgerMeta(config);
    const closed = autoCloseVerifiedDebt(debtLedger, [{ taskText, verificationEvidence: evidenceStr }]);
    // Compress duplicate open entries after auto-close
    const compression = compressLedger(debtLedger);
    if (closed > 0 || compression.compressedCount > 0) {
      await saveLedgerFull(config, debtLedger, cycleCounter);
      if (closed > 0) {
        await appendProgress(config,
          `[ATHENA] ${closed} carry-forward debt item(s) auto-closed by postmortem evidence`
        );
      }
      if (compression.compressedCount > 0) {
        await appendProgress(config,
          `[ATHENA] ${compression.compressedCount} duplicate debt item(s) compressed across ${compression.clustersProcessed} cluster(s)`
        );
      }
    }
  } catch (err) {
    try {
      await appendProgress(config,
        `[ATHENA] Carry-forward auto-close failed (non-fatal): ${String((err as any)?.message || err).slice(0, 200)}`
      );
    } catch { /* ignore nested logging failure */ }
  }
}

export async function runAthenaPostmortem(
  config,
  workerResult: EvidenceEnvelope & {
    /** Legacy alias for roleName — kept for backward compatibility. */
    role?: string;
    /** Legacy alias for prUrl — kept for backward compatibility. */
    pr?: string;
    /** Explicit outcome value: "merged" | "reopen" | "rollback" | "timeout". */
    outcome?: string;
    /** Legacy raw output string — summary is preferred. */
    raw?: string;
    /** Legacy alias for filesTouched — kept for backward compatibility. */
    filesChanged?: string[] | string;
  },
  originalPlan
) {
  const stateDir = config.paths?.stateDir || "state";
  const registry = getRoleRegistry(config);
  const athenaName = registry?.qualityReviewer?.name || "Athena";
  const athenaModel = registry?.qualityReviewer?.model || "Claude Sonnet 4.6";
  const command = config.env?.copilotCliCommand || "copilot";

  // ── Evidence envelope structural validation (admission control) ─────────────
  // Validates the envelope before any field access so that Athena's fast-path
  // gate and AI prompt never receive structurally invalid input.
  // Fail-closed: throw so the caller (evolution_executor) escalates the task.
  const envelopeValidation = validateEvidenceEnvelope(workerResult);
  if (!envelopeValidation.valid) {
    const errMsg = `[ATHENA] Evidence envelope invalid — ${envelopeValidation.errors.join("; ")}`;
    await appendProgress(config, errMsg);
    throw new Error(errMsg);
  }

  await appendProgress(config, `[ATHENA] Postmortem starting — reviewing worker result`);
  chatLog(stateDir, athenaName, "Postmortem review starting...");

  const executionReport = workerResult?.executionReport && typeof workerResult.executionReport === "object"
    ? workerResult.executionReport
    : buildWorkerExecutionReportArtifact(workerResult);
  const planArtifact = getPrometheusPlanArtifact(originalPlan);
  const taskFingerprint = buildPostmortemTaskFingerprint(originalPlan, planArtifact);
  const reviewArtifact = workerResult?.reviewArtifact && typeof workerResult.reviewArtifact === "object"
    ? workerResult.reviewArtifact
    : null;
  const workerName = executionReport.roleName || workerResult?.roleName || workerResult?.role || "unknown";
  const workerStatus = executionReport.status || workerResult?.status || "unknown";
  const workerPr = executionReport.prUrl || workerResult?.pr || workerResult?.prUrl || "none";
  const workerSummary = executionReport.summary || workerResult?.summary || workerResult?.raw?.slice(0, 2000) || "no summary";
  const filesChanged = executionReport.filesTouched.length > 0
    ? executionReport.filesTouched.join(", ")
    : workerResult?.filesChanged || workerResult?.filesTouched || "unknown";

  // Derive task outcome for decision quality labeling.
  // Explicit outcome values (merged, reopen, rollback, timeout) map deterministically.
  // If workerResult.outcome is absent, infer a best-effort value from status/PR fields.
  const rawOutcome = workerResult?.outcome
    || (workerStatus === "done" && workerPr !== "none" ? "merged" : null)
    || (workerStatus === "timeout" ? "timeout" : null)
    || (workerStatus === "rollback" ? "rollback" : null)
    || null;
  const dql = computeDecisionQualityLabelWithEvidence(rawOutcome, workerResult);

  // Evolution executor passes local verification results and pre-review context
  const verificationOutput = workerResult?.verificationOutput || null;
  const verificationPassed = workerResult?.verificationPassed;
  const preReviewAssessment = workerResult?.preReviewAssessment || null;
  const preReviewIssues = Array.isArray(workerResult?.preReviewIssues)
    ? workerResult.preReviewIssues
    : [];

  // ── Deterministic fast-path: skip AI call for clean passes ──────────────
  // Strict low-risk closure path (Task 3): bypass premium AI review only when
  // the evidence envelope is complete AND unambiguous per isEnvelopeUnambiguous.
  const forceAi = config?.athena?.forceAiPostmortem === true;
  const envelopeCheck = isEnvelopeUnambiguous(workerResult, {
    planRiskLevel: String(planArtifact?.riskLevel || originalPlan?.riskLevel || "").toLowerCase(),
  });
  const isCleanPass = envelopeCheck.unambiguous;

  if (isCleanPass && !forceAi) {
    const postmortem = computeDeterministicPostmortem(workerResult, originalPlan, dql);
    await appendProgress(config,
      `[ATHENA] Deterministic postmortem (fast-path): ${workerName} — score=${postmortem.qualityScore}/10 deviation=none recommendation=proceed model=deterministic`
    );
    chatLog(stateDir, athenaName, `Deterministic postmortem: ${workerName} — clean pass, AI call skipped`);

    // Persist to history
    const postmortemsFilePath = path.join(stateDir, "athena_postmortems.json");
    const rawPostmortems = await readJson(postmortemsFilePath, null);
    let history = [];
    if (rawPostmortems !== null) {
      const migrated = migrateData(rawPostmortems, STATE_FILE_TYPE.ATHENA_POSTMORTEMS);
      history = migrated.ok ? extractPostmortemEntries(migrated.data) : [];
    }
    const deterministicRecurrences = detectRecurrences(history, { window: 50, threshold: 2 });
    const closureMeta = buildPostmortemInterventionClosure(postmortem, deterministicRecurrences);
    const lifecycleEvidenceEnvelope = buildPostmortemLifecycleEvidenceEnvelope(workerResult, originalPlan, postmortem);
    const enrichedPostmortem = {
      ...postmortem,
      taskFingerprint,
      closureEvidenceEnvelope: lifecycleEvidenceEnvelope,
      recurrenceCount: closureMeta.recurrenceCount,
      recurrenceWeightedPriority: scoreRecurrenceWeightedPriority({ ...postmortem, ...closureMeta }),
      interventionId: closureMeta.interventionId,
      interventionDuplicateSuppressed: closureMeta.duplicateSuppressed,
      interventionClosureStatus: closureMeta.closureStatus,
      interventionClosureTrackedTask: closureMeta.closureTrackedTask,
    };

    history.push(enrichedPostmortem);
    if (history.length > 50) history.splice(0, history.length - 50);
    backfillDecisionQualityLabel(history);
    await writeJson(postmortemsFilePath, addSchemaVersion(history, STATE_FILE_TYPE.ATHENA_POSTMORTEMS));
    await writeJson(path.join(stateDir, "athena_latest_postmortem.json"), enrichedPostmortem);

    // Auto-close any carry-forward debt items resolved by this task.
    const evFast = workerResult?.verificationEvidence;
    const evidenceFast = evFast
      ? (typeof evFast === "string" ? evFast : JSON.stringify(evFast)).slice(0, 500)
      : String(workerResult?.summary || "").slice(0, 500);
    await attemptCarryForwardAutoClose(config, String(planArtifact?.task || originalPlan?.task || "").trim(), evidenceFast);

    return enrichedPostmortem;
  }

  const planTask = planArtifact?.task || originalPlan?.task || "unknown task";
  const planVerification = planArtifact?.verificationCommands?.length
    ? planArtifact.verificationCommands.join("; ")
    : originalPlan?.verification || "no verification defined";
  const planContext = planArtifact
    ? JSON.stringify({
        taskIdentity: planArtifact.taskIdentity,
        role: planArtifact.role,
        scope: planArtifact.scope,
        targetFiles: planArtifact.targetFiles,
        acceptanceCriteria: planArtifact.acceptanceCriteria,
        riskLevel: planArtifact.riskLevel,
        continuationFamilyKey: planArtifact.continuationFamilyKey,
        provenance: planArtifact.provenance,
      }, null, 2).slice(0, 2000)
    : String(originalPlan?.context || "").slice(0, 2000);
  const executionReportContext = JSON.stringify(executionReport, null, 2).slice(0, 2000);
  const reviewArtifactContext = reviewArtifact
    ? JSON.stringify(reviewArtifact, null, 2).slice(0, 1500)
    : "(no review artifact)";

  // Load previous postmortems for learning — migrate v0→v1 on read
  const postmortemsFilePath = path.join(stateDir, "athena_postmortems.json");
  const rawPostmortems = await readJson(postmortemsFilePath, null);
  let pastPostmortems;
  if (rawPostmortems !== null) {
    const migrated = migrateData(rawPostmortems, STATE_FILE_TYPE.ATHENA_POSTMORTEMS);
    if (!migrated.ok) {
      // Unknown future version or corrupt — fail closed, log telemetry, degrade gracefully
      await recordMigrationTelemetry(stateDir, {
        fileType: STATE_FILE_TYPE.ATHENA_POSTMORTEMS,
        filePath: postmortemsFilePath,
        fromVersion: migrated.fromVersion,
        toVersion: migrated.toVersion,
        success: false,
        reason: migrated.reason
      });
      if (migrated.reason === MIGRATION_REASON.UNKNOWN_FUTURE_VERSION) {
        await appendProgress(config,
          `[ATHENA] WARNING: athena_postmortems.json has unknown future schemaVersion (${migrated.fromVersion}) — ignoring history to avoid data corruption`
        );
      }
      pastPostmortems = [];
    } else {
      if (migrated.reason === MIGRATION_REASON.OK) {
        // Record telemetry only for actual migrations (not ALREADY_CURRENT)
        await recordMigrationTelemetry(stateDir, {
          fileType: STATE_FILE_TYPE.ATHENA_POSTMORTEMS,
          filePath: postmortemsFilePath,
          fromVersion: migrated.fromVersion,
          toVersion: migrated.toVersion,
          success: true,
          reason: migrated.reason
        });
      }
      pastPostmortems = extractPostmortemEntries(migrated.data);
    }
  } else {
    pastPostmortems = [];
  }

  // Rank past lessons by time-decayed relevance (lesson_halflife integration)
  const rankedLessons = rankLessonsByRelevance(pastPostmortems, { limit: 5 });
  const recentLessons = rankedLessons.length > 0
    ? rankedLessons.map(l => `${l.lesson} (relevance=${l.weight.toFixed(2)})`).join("\n  - ")
    : pastPostmortems.slice(-5).map(p => p.lessonLearned || "").filter(Boolean).join("\n  - ");

  // Detect recurring defect patterns and include them in postmortem context
  const recurrenceMatches = detectRecurrences(pastPostmortems);
  const recurrenceContext = recurrenceMatches.length > 0
    ? `\n\nRECURRING PATTERNS (${recurrenceMatches.length}):\n${recurrenceMatches.map(r => `- ${r.pattern} (count=${r.count}, severity=${r.severity})`).join("\n")}`
    : "";

  // ── Review-on-delta: skip AI call if result is identical to last postmortem ──
  if (isDuplicateResult(workerResult, pastPostmortems)) {
    const lastPm = pastPostmortems[pastPostmortems.length - 1];
    const dupPm = {
      ...lastPm,
      taskFingerprint: String(lastPm?.taskFingerprint || taskFingerprint),
      reviewedAt: new Date().toISOString(),
      model: "duplicate-skip",
      decisionQualityLabel: dql.label,
      decisionQualityLabelReason: dql.reason,
      decisionQualityStatus: dql.status,
    };
    await appendProgress(config, `[ATHENA] Duplicate result detected for ${workerName} — reusing last postmortem (review-on-delta)`);
    chatLog(stateDir, athenaName, `Duplicate result: ${workerName} — AI call skipped`);
    const dupRecurrences = detectRecurrences(pastPostmortems, { window: 50, threshold: 2 });
    const dupClosureMeta = buildPostmortemInterventionClosure(dupPm, dupRecurrences);
    const lifecycleEvidenceEnvelope = buildPostmortemLifecycleEvidenceEnvelope(workerResult, originalPlan, dupPm);
    const enrichedDupPm = {
      ...dupPm,
      closureEvidenceEnvelope: lifecycleEvidenceEnvelope,
      recurrenceCount: dupClosureMeta.recurrenceCount,
      recurrenceWeightedPriority: scoreRecurrenceWeightedPriority({ ...dupPm, ...dupClosureMeta }),
      interventionId: dupClosureMeta.interventionId,
      interventionDuplicateSuppressed: dupClosureMeta.duplicateSuppressed,
      interventionClosureStatus: dupClosureMeta.closureStatus,
      interventionClosureTrackedTask: dupClosureMeta.closureTrackedTask,
    };
    pastPostmortems.push(enrichedDupPm);
    if (pastPostmortems.length > 50) pastPostmortems.splice(0, pastPostmortems.length - 50);
    backfillDecisionQualityLabel(pastPostmortems);
    await writeJson(postmortemsFilePath, addSchemaVersion(pastPostmortems, STATE_FILE_TYPE.ATHENA_POSTMORTEMS));
    await writeJson(path.join(stateDir, "athena_latest_postmortem.json"), enrichedDupPm);
    return enrichedDupPm;
  }

  const contextPrompt = `TARGET REPO: ${resolvePromptTargetRepo(config)}

## YOUR MISSION — POSTMORTEM REVIEW

You are Athena — BOX Quality Gate & Postmortem Reviewer.
A worker has completed their task. Review the result against the original plan.

## ORIGINAL PLAN
Task: ${planTask}
Expected Verification: ${planVerification}
Context: ${planContext}

## PLAN ARTIFACT
${planArtifact ? JSON.stringify(planArtifact, null, 2).slice(0, 2000) : "(no plan artifact)"}

## REVIEW FINDINGS ARTIFACT
${reviewArtifactContext}

## EXECUTION REPORT ARTIFACT
${executionReportContext}

## WORKER RESULT SUMMARY
Worker: ${workerName}
Status: ${workerStatus}
PR: ${workerPr}
Files Changed: ${filesChanged}
Summary: ${workerSummary}

## LOCAL VERIFICATION RESULTS
${verificationPassed !== undefined ? `All commands passed: ${verificationPassed}` : "(not available)"}
${verificationOutput ? verificationOutput : ""}

## PRE-REVIEW CONTEXT (what Athena flagged before execution)
${preReviewAssessment ? `Assessment given to worker: ${preReviewAssessment}` : "(no pre-review data)"}
${preReviewIssues.length > 0 ? `Issues flagged pre-execution:\n${preReviewIssues.map(i => `  - ${i}`).join("\n")}` : ""}

## RECENT LESSONS LEARNED (ranked by relevance)
${recentLessons ? `  - ${recentLessons}` : "  (no previous lessons)"}
${recurrenceContext}

## EVALUATE

1. Did the worker achieve what was planned?
2. Was the success criterion met?
3. What was expected vs what actually happened?
4. What should the system learn from this for future cycles?
5. Were there unexpected issues or deviations?

## OUTPUT FORMAT

===DECISION===
{
  "workerName": "${workerName}",
  "taskCompleted": true/false,
  "expectedOutcome": "what was supposed to happen",
  "actualOutcome": "what actually happened",
  "deviation": "none | minor | major",
  "successCriteriaMet": true/false,
  "lessonLearned": "one clear, actionable lesson for future cycles",
  "qualityScore": 1-10,
  "followUpNeeded": true/false,
  "followUpTask": "if follow-up needed, describe what",
  "recommendation": "proceed | rework | escalate"
}
===END===`;

  const aiResult = await callCopilotAgent(command, "athena", contextPrompt, config, athenaModel);

  if (!aiResult.ok || !aiResult.parsed) {
    const aiError = String((aiResult as any).error || "no JSON");
    await appendProgress(config, `[ATHENA] Postmortem AI call failed — ${aiError}`);
    chatLog(stateDir, athenaName, `Postmortem AI failed: ${aiError}`);
    const degradedPostmortem = applyPostmortemLearningGradeStatus({
      workerName,
      taskCompleted: workerStatus === "done",
      expectedOutcome: String(planTask || "pending replay closure"),
      actualOutcome: `Athena postmortem fallback triggered: ${aiError}`,
      deviation: "major",
      successCriteriaMet: false,
      lessonLearned: "",
      qualityScore: 0,
      followUpNeeded: true,
      followUpTask: REPLAY_OR_MANUAL_COMPLETION_FOLLOW_UP,
      impactAttribution: {
        evidenceType: "athena_postmortem",
        baselineQualityScore: 0,
        followUpNeeded: true,
      },
      recommendation: POSTMORTEM_RECOMMENDATION.REWORK,
      decisionQualityLabel: dql.label,
      decisionQualityLabelReason: dql.reason,
      decisionQualityStatus: dql.status,
      reviewedAt: new Date().toISOString(),
      model: athenaModel,
    }, {
      forceDegraded: true,
      degradedReason: DEGRADED_POSTMORTEM_REVIEW_REASON.AI_POSTMORTEM_FAILURE,
    });

    const fallbackRecurrences = detectRecurrences(pastPostmortems, { window: 50, threshold: 2 });
    const fallbackClosureMeta = buildPostmortemInterventionClosure(degradedPostmortem, fallbackRecurrences);
    const lifecycleEvidenceEnvelope = buildPostmortemLifecycleEvidenceEnvelope(workerResult, originalPlan, degradedPostmortem);
    const enrichedFallbackPostmortem = {
      ...degradedPostmortem,
      taskFingerprint,
      closureEvidenceEnvelope: lifecycleEvidenceEnvelope,
      recurrenceCount: fallbackClosureMeta.recurrenceCount,
      recurrenceWeightedPriority: scoreRecurrenceWeightedPriority({ ...degradedPostmortem, ...fallbackClosureMeta }),
      interventionId: fallbackClosureMeta.interventionId,
      interventionDuplicateSuppressed: fallbackClosureMeta.duplicateSuppressed,
      interventionClosureStatus: fallbackClosureMeta.closureStatus,
      interventionClosureTrackedTask: fallbackClosureMeta.closureTrackedTask,
    };
    pastPostmortems.push(enrichedFallbackPostmortem);
    if (pastPostmortems.length > 50) pastPostmortems.splice(0, pastPostmortems.length - 50);
    backfillDecisionQualityLabel(pastPostmortems);
    await writeJson(postmortemsFilePath, addSchemaVersion(pastPostmortems, STATE_FILE_TYPE.ATHENA_POSTMORTEMS));
    await writeJson(path.join(stateDir, "athena_latest_postmortem.json"), enrichedFallbackPostmortem);
    return enrichedFallbackPostmortem;
  }

  logAgentThinking(stateDir, athenaName, aiResult.thinking);

  const d = aiResult.parsed;
  const rawPostmortem = {
    taskFingerprint,
    workerName: d.workerName || workerName,
    taskCompleted: d.taskCompleted !== false,
    expectedOutcome: d.expectedOutcome || "",
    actualOutcome: d.actualOutcome || "",
    deviation: d.deviation || "none",
    successCriteriaMet: d.successCriteriaMet !== false,
    lessonLearned: d.lessonLearned || "",
    qualityScore: d.qualityScore || 0,
    followUpNeeded: d.followUpNeeded === true,
    followUpTask: d.followUpTask || "",
    impactAttribution: {
      evidenceType: "athena_postmortem",
      baselineQualityScore: Number.isFinite(Number(d.qualityScore)) ? Number(d.qualityScore) : null,
      followUpNeeded: d.followUpNeeded === true,
    },
    recommendation: d.recommendation && VALID_RECOMMENDATIONS.has(d.recommendation)
      ? d.recommendation
      : deriveDeterministicRecommendation(dql.label),
    decisionQualityLabel: dql.label,
    decisionQualityLabelReason: dql.reason,
    decisionQualityStatus: dql.status,
    reviewedAt: new Date().toISOString(),
    model: athenaModel
  };

  // ── Postmortem closure field validation — completion-boundary enforcement ────
  // Require non-empty expectedOutcome, actualOutcome, and deviation before
  // persisting. If the AI's first response is missing these fields, attempt ONE
  // retry with a targeted correction prompt (fail-close pattern matching the plan
  // review retry). If the retry still fails, the postmortem carries
  // closureBoundaryViolation=true, the recommendation is escalated, and the
  // completion boundary is enforced — the worker cannot be finalised as done.
  let closureValidation = validatePostmortemClosureFields(rawPostmortem);
  if (!closureValidation.valid) {
    await appendProgress(config,
      `[ATHENA] Closure boundary: fields invalid (${closureValidation.emptyFields.join(", ")}) — retrying once with correction prompt`
    );
    const closureRetryPrompt = buildPostmortemClosureRetryPrompt(contextPrompt, closureValidation, rawPostmortem);
    let closureRetryOk = false;
    try {
      const retryAiResult = await callCopilotAgent(command, "athena", closureRetryPrompt, config, athenaModel);
      if (retryAiResult.ok && retryAiResult.parsed) {
        const rd = retryAiResult.parsed;
        // Patch only the missing fields from the retry response
        if (String(rd.expectedOutcome || "").trim()) rawPostmortem.expectedOutcome = String(rd.expectedOutcome).trim();
        if (String(rd.actualOutcome   || "").trim()) rawPostmortem.actualOutcome   = String(rd.actualOutcome).trim();
        const retryDeviation = String(rd.deviation || "").trim();
        if (retryDeviation) rawPostmortem.deviation = retryDeviation;
        const retryValidation = validatePostmortemClosureFields(rawPostmortem);
        if (retryValidation.valid) {
          closureRetryOk = true;
          closureValidation = retryValidation;
          await appendProgress(config, `[ATHENA] Closure boundary: retry succeeded — all closure fields now present`);
        } else {
          await appendProgress(config,
            `[ATHENA] Closure boundary: retry did not fix fields (${retryValidation.emptyFields.join(", ")}) — fail-closed`
          );
        }
      } else {
        await appendProgress(config,
          `[ATHENA] Closure boundary: retry AI call failed — ${String((retryAiResult as any).error || "no JSON")} — fail-closed`
        );
      }
    } catch (retryErr) {
      await appendProgress(config,
        `[ATHENA] Closure boundary: retry threw — ${String((retryErr as Error)?.message || retryErr).slice(0, 120)} — fail-closed`
      );
    }
    if (!closureRetryOk) {
      // Completion-boundary enforcement: mark violation and escalate recommendation.
      // The caller (evolution_executor / orchestrator) MUST NOT finalise this
      // worker as done — isClosureBoundaryViolation() will return true.
      (rawPostmortem as any).closureBoundaryViolation = true;
      (rawPostmortem as any).closureBoundaryViolationReason = CLOSURE_BOUNDARY_VIOLATION_REASON.RETRY_FAILED;
      rawPostmortem.recommendation = POSTMORTEM_RECOMMENDATION.ESCALATE;
      await appendProgress(config,
        `[ATHENA] CLOSURE BOUNDARY VIOLATED — worker completion cannot be finalised — escalating`
      );
    }
  }
  const postmortem = applyPostmortemLearningGradeStatus(rawPostmortem, { closureValidation });
  // Propagate boundary violation flag through to the enriched postmortem
  if ((rawPostmortem as any).closureBoundaryViolation) {
    (postmortem as any).closureBoundaryViolation = true;
    (postmortem as any).closureBoundaryViolationReason = (rawPostmortem as any).closureBoundaryViolationReason;
    // Ensure escalation recommendation is preserved after applyPostmortemLearningGradeStatus
    (postmortem as any).recommendation = POSTMORTEM_RECOMMENDATION.ESCALATE;
  }

  // Classify defect channel
  const dc = classifyDefectChannel({
    deviation: postmortem.deviation,
    lessonLearned: postmortem.lessonLearned,
    actualOutcome: postmortem.actualOutcome
  });
  (postmortem as any).defectChannel = dc.channel;
  (postmortem as any).defectChannelTag = dc.tag;

  // Append to postmortem history (keep last 50)
  const history = Array.isArray(pastPostmortems) ? pastPostmortems : [];
  const recurrences = detectRecurrences(history, { window: 50, threshold: 2 });
  const closureMeta = buildPostmortemInterventionClosure(postmortem, recurrences);
  const lifecycleEvidenceEnvelope = buildPostmortemLifecycleEvidenceEnvelope(workerResult, originalPlan, postmortem);
  const enrichedPostmortem: any = {
    ...postmortem,
    taskFingerprint,
    closureEvidenceEnvelope: lifecycleEvidenceEnvelope,
    recurrenceCount: closureMeta.recurrenceCount,
    recurrenceWeightedPriority: scoreRecurrenceWeightedPriority({ ...postmortem, ...closureMeta }),
    interventionId: closureMeta.interventionId,
    interventionDuplicateSuppressed: closureMeta.duplicateSuppressed,
    interventionClosureStatus: closureMeta.closureStatus,
    interventionClosureTrackedTask: closureMeta.closureTrackedTask,
  };
  history.push(enrichedPostmortem);
  if (history.length > 50) history.splice(0, history.length - 50);
  backfillDecisionQualityLabel(history);
  await writeJson(postmortemsFilePath, addSchemaVersion(history, STATE_FILE_TYPE.ATHENA_POSTMORTEMS));

  // Also write latest for dashboard visibility
  await writeJson(path.join(stateDir, "athena_latest_postmortem.json"), enrichedPostmortem);

  // Auto-close any carry-forward debt items resolved by this task.
  const evAi = workerResult?.verificationEvidence;
  const evidenceAi = evAi
    ? (typeof evAi === "string" ? evAi : JSON.stringify(evAi)).slice(0, 500)
    : String(workerResult?.summary || "").slice(0, 500);
  await attemptCarryForwardAutoClose(config, String(planArtifact?.task || originalPlan?.task || "").trim(), evidenceAi);

  await appendProgress(config,
    `[ATHENA] Postmortem: ${workerName} — score=${enrichedPostmortem.qualityScore}/10 deviation=${enrichedPostmortem.deviation} recommendation=${enrichedPostmortem.recommendation} decisionQualityLabel=${enrichedPostmortem.decisionQualityLabel}`
  );
  chatLog(stateDir, athenaName,
    `Postmortem: ${workerName} score=${enrichedPostmortem.qualityScore}/10 → ${enrichedPostmortem.recommendation}`
  );

  return enrichedPostmortem;
}

// ── Reviewer Precision/Recall ─────────────────────────────────────────────────

/**
 * Shape returned by computeReviewerPrecisionRecall.
 * All rates are in [0, 1], null when there is insufficient data.
 *
 * correct          — count with decisionQualityLabel="correct"
 * delayedCorrect   — count with decisionQualityLabel="delayed-correct"
 * incorrect        — count with decisionQualityLabel="incorrect"
 * inconclusive     — count with decisionQualityLabel="inconclusive" (excluded from rates)
 * knownOutcomes    — correct + delayedCorrect + incorrect
 * precision        — (correct + delayedCorrect) / knownOutcomes
 * recall           — correct / (correct + delayedCorrect); null if no successes
 * falsePositiveRate— incorrect / knownOutcomes
 * reworkRate       — delayedCorrect / (correct + delayedCorrect)
 * f1               — harmonic mean of precision and recall; null if either is null
 */
export interface ReviewerPrecisionRecallResult {
  correct: number;
  delayedCorrect: number;
  incorrect: number;
  inconclusive: number;
  knownOutcomes: number;
  precision: number | null;
  recall: number | null;
  falsePositiveRate: number | null;
  reworkRate: number | null;
  f1: number | null;
  computedAt: string;
}

function _round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Compute reviewer precision/recall metrics from postmortem entries.
 *
 * In BOX's context, Athena approves plans for execution. The "realized outcome"
 * is captured as decisionQualityLabel in each postmortem:
 *   correct         -> approved, succeeded on first attempt (TP)
 *   delayed-correct -> approved, succeeded after rework (partial TP)
 *   incorrect       -> approved, failed/rolled back (FP)
 *   inconclusive    -> excluded from rate calculations (unknown outcome)
 *
 * Metric definitions:
 *   precision        = (correct + delayed_correct) / known_outcomes
 *   recall           = correct / (correct + delayed_correct)
 *   falsePositiveRate= incorrect / known_outcomes
 *   reworkRate       = delayed_correct / (correct + delayed_correct)
 *   f1               = 2 * precision * recall / (precision + recall)
 *
 * Returns null rates when there is insufficient data (knownOutcomes === 0).
 *
 * @param {Array<object>} postmortems - entries with decisionQualityLabel fields
 * @returns {ReviewerPrecisionRecallResult}
 */
export function computeReviewerPrecisionRecall(postmortems: any[]): ReviewerPrecisionRecallResult {
  let correct = 0, delayedCorrect = 0, incorrect = 0, inconclusive = 0;
  for (const pm of (Array.isArray(postmortems) ? postmortems : [])) {
    const label = normalizeDecisionQualityLabel(pm);
    if (label === DECISION_QUALITY_LABEL.CORRECT)              correct++;
    else if (label === DECISION_QUALITY_LABEL.DELAYED_CORRECT) delayedCorrect++;
    else if (label === DECISION_QUALITY_LABEL.INCORRECT)       incorrect++;
    else                                                       inconclusive++;
  }
  const knownOutcomes = correct + delayedCorrect + incorrect;
  if (knownOutcomes === 0) {
    return {
      correct, delayedCorrect, incorrect, inconclusive, knownOutcomes,
      precision: null, recall: null, falsePositiveRate: null, reworkRate: null, f1: null,
      computedAt: new Date().toISOString()
    };
  }
  const precision = _round4((correct + delayedCorrect) / knownOutcomes);
  const successCount = correct + delayedCorrect;
  const recall = successCount > 0 ? _round4(correct / successCount) : null;
  const falsePositiveRate = _round4(incorrect / knownOutcomes);
  const reworkRate = successCount > 0 ? _round4(delayedCorrect / successCount) : null;
  let f1: number | null = null;
  if (precision !== null && recall !== null && (precision + recall) > 0) {
    f1 = _round4((2 * precision * recall) / (precision + recall));
  }
  return {
    correct, delayedCorrect, incorrect, inconclusive, knownOutcomes,
    precision, recall, falsePositiveRate, reworkRate, f1,
    computedAt: new Date().toISOString()
  };
}

// ── Dual-Lane Athena Verdicts ─────────────────────────────────────────────────

/**
 * Policy identifiers for merging dual-lane Athena verdicts.
 *
 * MUST_PASS_BOTH     — both quality and governance lanes must approve (fail-closed default)
 * QUALITY_GATE_ONLY  — quality lane is authoritative; governance lane is advisory
 * GOVERNANCE_GATE_ONLY — governance lane is authoritative; quality lane is advisory
 * ANY_PASS           — either lane approving is sufficient (least strict, opt-in only)
 *
 * @enum {string}
 */
export const LANE_MERGE_POLICY = Object.freeze({
  MUST_PASS_BOTH:       "MUST_PASS_BOTH",
  QUALITY_GATE_ONLY:    "QUALITY_GATE_ONLY",
  GOVERNANCE_GATE_ONLY: "GOVERNANCE_GATE_ONLY",
  ANY_PASS:             "ANY_PASS",
} as const);

/** A verdict produced by one review lane. */
export interface LaneVerdict {
  /** Which lane produced this verdict ("quality" or "governance"). */
  lane: "quality" | "governance";
  /** Whether this lane approves the plan batch. */
  approved: boolean;
  /** Numeric quality/governance score [0–100] for this lane. */
  score: number;
  /** Human-readable summary of the lane's findings. */
  summary: string;
  /** Machine-readable issue strings (empty when approved). */
  issues: string[];
  /** Machine-readable reason code + message (set on rejection). */
  reason: { code: string; message: string } | null;
}

/** The result of merging two lane verdicts via a merge policy. */
export interface DualLaneVerdict {
  /** Final merged approval decision. */
  approved: boolean;
  /** Quality lane verdict (Lane A). */
  laneA: LaneVerdict;
  /** Governance lane verdict (Lane B). */
  laneB: LaneVerdict;
  /** Policy used to merge the two lanes. */
  mergePolicy: string;
  /** Human-readable explanation of the merge decision. */
  mergeReason: string;
}

/**
 * Resolve the effective lane merge policy from config.
 * Falls back to MUST_PASS_BOTH (fail-closed default) when not configured
 * or when an unknown value is supplied.
 *
 * @param config — BOX runtime config object
 * @returns one of LANE_MERGE_POLICY values
 */
export function resolveEffectiveLaneMergePolicy(config: any): string {
  const raw = String(config?.runtime?.laneMergePolicy || "").trim().toUpperCase();
  const validPolicies = Object.values(LANE_MERGE_POLICY) as string[];
  return validPolicies.includes(raw) ? raw : LANE_MERGE_POLICY.MUST_PASS_BOTH;
}

/**
 * Build a deterministic quality lane verdict from plan scoring.
 *
 * Lane A (quality) uses the existing deterministic scorePlanQuality function
 * to assess structural completeness. A plan batch passes when every plan
 * scores at or above the configured minimum quality threshold.
 *
 * @param plans — plans from Prometheus analysis
 * @param config — BOX runtime config (optional; uses defaults when absent)
 * @returns LaneVerdict for the quality lane
 */
export function buildQualityLaneVerdict(plans: any[], config?: any): LaneVerdict {
  if (!Array.isArray(plans) || plans.length === 0) {
    return {
      lane: "quality",
      approved: false,
      score: 0,
      summary: "No plans provided — quality lane cannot approve an empty batch",
      issues: ["no plans provided"],
      reason: { code: "NO_PLANS", message: "Plan batch is empty" },
    };
  }

  const qualityMinScore: number = typeof config?.runtime?.planQualityMinScore === "number"
    ? config.runtime.planQualityMinScore
    : PLAN_QUALITY_MIN_SCORE;

  const failures: string[] = [];
  let totalScore = 0;

  for (let i = 0; i < plans.length; i++) {
    const { score, issues } = scorePlanQuality(plans[i]);
    totalScore += score;
    if (score < qualityMinScore) {
      const label = String(plans[i]?.task || plans[i]?.role || `plan[${i}]`).slice(0, 60);
      failures.push(`plan[${i}] "${label}": score=${score} — ${issues.join("; ")}`);
    }
  }

  const avgScore = Math.round(totalScore / plans.length);

  if (failures.length > 0) {
    const msg = `${failures.length} plan(s) below quality threshold (${qualityMinScore})`;
    return {
      lane: "quality",
      approved: false,
      score: avgScore,
      summary: msg,
      issues: failures,
      reason: { code: "LOW_PLAN_QUALITY", message: msg },
    };
  }

  return {
    lane: "quality",
    approved: true,
    score: avgScore,
    summary: `All ${plans.length} plan(s) meet quality threshold (≥${qualityMinScore})`,
    issues: [],
    reason: null,
  };
}

/**
 * Build a deterministic governance lane verdict from plan governance checks.
 *
 * Lane B (governance) validates:
 *   1. High-risk plans have valid pre-mortems (checkPlanPremortemGate).
 *   2. No plan specifies a forbidden verification command.
 *   3. Risk levels are declared and valid.
 *
 * @param plans — plans from Prometheus analysis
 * @returns LaneVerdict for the governance lane
 */
export function buildGovernanceLaneVerdict(plans: any[]): LaneVerdict {
  if (!Array.isArray(plans) || plans.length === 0) {
    return {
      lane: "governance",
      approved: false,
      score: 0,
      summary: "No plans provided — governance lane cannot approve an empty batch",
      issues: ["no plans provided"],
      reason: { code: "NO_PLANS", message: "Plan batch is empty" },
    };
  }

  const issues: string[] = [];

  // Check 1: High-risk plans require valid pre-mortems.
  const preMortemViolations = checkPlanPremortemGate(plans);
  for (const v of preMortemViolations) {
    issues.push(`PREMORTEM_VIOLATION: ${v}`);
  }

  // Check 2: No plan may use forbidden verification commands.
  for (let i = 0; i < plans.length; i++) {
    const verification = String(plans[i]?.verification || "").trim();
    if (verification.length > 0) {
      const forbidden = checkForbiddenCommands(verification);
      if (forbidden.forbidden) {
        for (const v of forbidden.violations) {
          issues.push(`plan[${i}]: FORBIDDEN_COMMAND: ${v.reason}`);
        }
      }
    }
  }

  // Check 3: All plans must have a declared risk level.
  for (let i = 0; i < plans.length; i++) {
    const riskLevel = String(plans[i]?.riskLevel || "").trim().toLowerCase();
    if (!riskLevel) {
      issues.push(`plan[${i}]: MISSING_RISK_LEVEL: riskLevel field is absent`);
    }
  }

  const totalChecks = plans.length * 3;
  const failedChecks = issues.length;
  const score = Math.max(0, Math.round(((totalChecks - failedChecks) / totalChecks) * 100));

  if (issues.length > 0) {
    const msg = `${issues.length} governance violation(s) found`;
    return {
      lane: "governance",
      approved: false,
      score,
      summary: msg,
      issues,
      reason: { code: "GOVERNANCE_VIOLATIONS", message: msg },
    };
  }

  return {
    lane: "governance",
    approved: true,
    score: 100,
    summary: `All ${plans.length} plan(s) passed governance checks`,
    issues: [],
    reason: null,
  };
}

/**
 * Merge two lane verdicts into a single dual-lane decision via a merge policy.
 *
 * Policy semantics:
 *   MUST_PASS_BOTH     — approved only when both lanes approve (fail-closed)
 *   QUALITY_GATE_ONLY  — approved when quality lane (laneA) approves
 *   GOVERNANCE_GATE_ONLY — approved when governance lane (laneB) approves
 *   ANY_PASS           — approved when either lane approves
 *
 * The default policy is MUST_PASS_BOTH.
 *
 * @param laneA — quality lane verdict
 * @param laneB — governance lane verdict
 * @param policy — one of LANE_MERGE_POLICY values (defaults to MUST_PASS_BOTH)
 * @returns DualLaneVerdict with the merged decision
 */
export function mergeLaneVerdicts(
  laneA: LaneVerdict,
  laneB: LaneVerdict,
  policy: string = LANE_MERGE_POLICY.MUST_PASS_BOTH,
): DualLaneVerdict {
  const effectivePolicy = (Object.values(LANE_MERGE_POLICY) as string[]).includes(policy)
    ? policy
    : LANE_MERGE_POLICY.MUST_PASS_BOTH;

  let approved: boolean;
  let mergeReason: string;

  switch (effectivePolicy) {
    case LANE_MERGE_POLICY.MUST_PASS_BOTH:
      approved = laneA.approved && laneB.approved;
      if (approved) {
        mergeReason = "Both quality and governance lanes approved";
      } else if (!laneA.approved && !laneB.approved) {
        mergeReason = `Both lanes rejected — quality: ${laneA.reason?.code ?? "rejected"}; governance: ${laneB.reason?.code ?? "rejected"}`;
      } else if (!laneA.approved) {
        mergeReason = `Quality lane rejected: ${laneA.reason?.code ?? "rejected"}`;
      } else {
        mergeReason = `Governance lane rejected: ${laneB.reason?.code ?? "rejected"}`;
      }
      break;

    case LANE_MERGE_POLICY.QUALITY_GATE_ONLY:
      approved = laneA.approved;
      mergeReason = approved
        ? "Quality lane approved (governance is advisory)"
        : `Quality lane rejected: ${laneA.reason?.code ?? "rejected"} (governance lane is advisory)`;
      break;

    case LANE_MERGE_POLICY.GOVERNANCE_GATE_ONLY:
      approved = laneB.approved;
      mergeReason = approved
        ? "Governance lane approved (quality is advisory)"
        : `Governance lane rejected: ${laneB.reason?.code ?? "rejected"} (quality lane is advisory)`;
      break;

    case LANE_MERGE_POLICY.ANY_PASS:
      approved = laneA.approved || laneB.approved;
      mergeReason = approved
        ? `At least one lane approved (quality=${laneA.approved}, governance=${laneB.approved})`
        : "Both lanes rejected — batch is blocked";
      break;

    default:
      // Unknown policy → fail-closed: treat as MUST_PASS_BOTH
      approved = laneA.approved && laneB.approved;
      mergeReason = `Unknown policy '${effectivePolicy}' — defaulted to MUST_PASS_BOTH`;
  }

  return { approved, laneA, laneB, mergePolicy: effectivePolicy, mergeReason };
}

/**
 * Run both review lanes deterministically and merge via the configured policy.
 *
 * This is a pure deterministic function (no AI calls). It runs the quality and
 * governance lanes against the given plans and returns a merged dual-lane verdict.
 *
 * Use `runAthenaPlanReview` for the full AI-backed plan review cycle.
 * Use `runDualLanePlanReview` for offline/deterministic dual-lane scoring.
 *
 * @param plans  — plans from Prometheus analysis
 * @param config — BOX runtime config (optional; uses defaults when absent)
 * @returns DualLaneVerdict with both lanes and merged decision
 */
export function runDualLanePlanReview(plans: any[], config?: any): DualLaneVerdict {
  const laneA = buildQualityLaneVerdict(plans, config);
  const laneB = buildGovernanceLaneVerdict(plans);
  const policy = resolveEffectiveLaneMergePolicy(config);
  return mergeLaneVerdicts(laneA, laneB, policy);
}

// ── Postmortem Envelope Summary ───────────────────────────────────────────────

import type { FailureEnvelope } from "./failure_classifier.js";

/**
 * Extract postmortem-relevant fields from a FailureEnvelope for compact storage.
 *
 * The summary omits the raw classification evidence (which can be large) and
 * retains only the fields that drive postmortem decision quality and
 * TRACKED_FIELDS deep-equality comparisons.
 *
 * @param envelope - FailureEnvelope produced by buildFailureEnvelope()
 * @returns compact postmortem record or null when envelope is not provided
 */
export function buildPostmortemEnvelopeSummary(
  envelope: FailureEnvelope | null | undefined,
): Record<string, unknown> | null {
  if (!envelope || typeof envelope !== "object") return null;
  return {
    envelopeId:        envelope.envelopeId,
    taskId:            envelope.taskId,
    terminationCause:  envelope.terminationCause,
    primaryClass:      (envelope.classification as any)?.primaryClass ?? null,
    confidence:        (envelope.classification as any)?.confidence ?? null,
    flagged:           (envelope.classification as any)?.flagged ?? null,
    retryAction:       (envelope.retryDecision as any)?.retryAction ?? null,
    resolvedAt:        envelope.resolvedAt,
  };
}

// ── Postmortem Recurrence Quality Score ───────────────────────────────────────

/**
 * Compute a quality score measuring how effectively Athena postmortems prevent
 * recurrence of the same failure class.
 *
 * Quality criteria:
 *   1. decisionQualityLabel present and not "low"           → +1 pt each
 *   2. recommendation is not NONE (i.e., actionable)         → +1 pt each
 *   3. evidenceCompleteness is "complete" or "sufficient"    → +1 pt each
 *   4. recurred === false (did not recur after postmortem)   → +2 pts each
 *
 * qualityScore = totalPoints / maxPoints, clamped to [0, 1].
 *
 * Returns 0 for empty input.
 *
 * @param postmortems — array of postmortem records from Athena
 */
export function computeRecurrenceQualityScore(postmortems: unknown[]): {
  qualityScore: number;
  totalPoints: number;
  maxPoints: number;
  postmortemCount: number;
} {
  const pms = Array.isArray(postmortems) ? postmortems : [];
  if (pms.length === 0) {
    return { qualityScore: 0, totalPoints: 0, maxPoints: 0, postmortemCount: 0 };
  }

  let totalPoints = 0;
  const maxPoints = pms.length * 4; // max 4 points per postmortem

  for (const pm of pms) {
    const p = pm && typeof pm === "object" ? pm as Record<string, unknown> : {};

    // +1 if decisionQualityLabel is present and non-empty and not "low"
    const dql = String(p.decisionQualityLabel ?? "").trim().toLowerCase();
    if (dql && dql !== "low" && dql !== "unknown") totalPoints++;

    // +1 if recommendation is actionable (not NONE or empty)
    const rec = String(p.recommendation ?? "").trim().toLowerCase();
    if (rec && rec !== "none" && rec !== "no_recommendation") totalPoints++;

    // +1 if evidenceCompleteness is "complete" or "sufficient"
    const ec = String(p.evidenceCompleteness ?? "").trim().toLowerCase();
    if (ec === "complete" || ec === "sufficient") totalPoints++;

    // +2 if the postmortem did NOT recur (issue was resolved)
    const recurred = (p as any).recurred;
    if (recurred === false) totalPoints += 2;
  }

  const qualityScore = Math.round((totalPoints / maxPoints) * 10000) / 10000;

  return { qualityScore, totalPoints, maxPoints, postmortemCount: pms.length };
}

// ── Stale-artifact closure fastpath evaluation ────────────────────────────────

/**
 * Deterministic eligibility check for the stale-artifact closure fastpath.
 *
 * Returns eligible=true only when ALL of the following hold:
 *   1. At least one stale PR triage record exists (there was stale automated PR debt).
 *   2. Every triage record is in a terminal state ("applied" or "superseded").
 *   3. Main CI is reported green by the caller.
 *
 * This is a pure function — all I/O (reading triage records, checking CI) must be
 * performed by the caller before invoking this function.
 */
export function evaluateStaleArtifactClosureFastpath(opts: {
  staleTriageRecords: Array<Record<string, unknown>>;
  mainCiGreen: boolean;
  currentPlans?: Array<Record<string, unknown>>;
  nowMs?: number;
  recencyWindowMs?: number;
}): { eligible: boolean; reason: string } {
  const records = Array.isArray(opts.staleTriageRecords) ? opts.staleTriageRecords : [];
  const currentPlans = Array.isArray(opts.currentPlans) ? opts.currentPlans : [];
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const recencyWindowMs = Number.isFinite(Number(opts.recencyWindowMs))
    ? Math.max(0, Number(opts.recencyWindowMs))
    : 60 * 60 * 1000;

  const normalizeFastpathText = (value: unknown): string => String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const planLooksLikeStaleArtifactClosure = (plan: Record<string, unknown>): boolean => {
    const text = [
      plan.task,
      plan.title,
      plan.scope,
      plan.context,
      plan.verification,
      plan.capabilityTag,
      plan.capability_tag,
      plan.continuationFamilyKey,
      ...(Array.isArray(plan.acceptance_criteria) ? plan.acceptance_criteria : []),
      ...(Array.isArray(plan.acceptanceCriteria) ? plan.acceptanceCriteria : []),
    ]
      .map(normalizeFastpathText)
      .filter(Boolean)
      .join(" ");

    return [
      /stale pr/,
      /stale artifact/,
      /artifact closure/,
      /automated pr debt/,
      /superseded pr/,
      /superseded artifact/,
      /close stale/,
      /archive superseded/,
      /stale pr guard/,
    ].some((pattern) => pattern.test(text));
  };

  const extractRecordTimestampMs = (record: Record<string, unknown>): number | null => {
    const candidates = [
      record.appliedAt,
      record.supersededAt,
      record.decidedAt,
      record.triageTimestamp,
      record.createdAt,
      record.updatedAt,
    ];
    for (const candidate of candidates) {
      const parsed = Date.parse(String(candidate || ""));
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };

  // Need at least one triage record to evaluate stale PR debt.
  if (records.length === 0) {
    return { eligible: false, reason: "no_stale_pr_records" };
  }

  // All stale PR triage records must be in terminal state.
  const allTerminal = records.every(
    (r) => r.applyState === "applied" || r.applyState === "superseded",
  );
  if (!allTerminal) {
    return { eligible: false, reason: "non_terminal_stale_pr_records" };
  }

  const hasRecentTerminalRecord = records.some((record) => {
    const ts = extractRecordTimestampMs(record);
    if (!Number.isFinite(ts)) return false;
    return nowMs - ts <= recencyWindowMs;
  });
  if (!hasRecentTerminalRecord) {
    return { eligible: false, reason: "archival_terminal_stale_pr_records" };
  }

  const plansAreStaleClosureWork = currentPlans.length > 0
    && currentPlans.every((plan) => planLooksLikeStaleArtifactClosure(plan));
  if (!plansAreStaleClosureWork) {
    return { eligible: false, reason: "current_plans_not_stale_artifact_closure" };
  }

  // Main CI must be green.
  if (!opts.mainCiGreen) {
    return { eligible: false, reason: "main_ci_not_green" };
  }

  return { eligible: true, reason: ATHENA_FAST_PATH_REASON.STALE_SUPERSEDED_CI_GREEN };
}
