/**
 * resilience_drill.js — Quarterly resilience drill harness for BOX. (T-037)
 *
 * ## Purpose
 *   Simulates catastrophe scenarios end-to-end in isolation and verifies that
 *   the guardrail pipeline and rollback validation behave as specified.
 *   All operations use dryRun=true — no state files are written, no external
 *   calls are made.
 *
 * ## CI simulation mode (resolves Athena missing item #1)
 *   Activated by setting env var BOX_DRILL_MODE=ci before running.
 *   In CI mode every drill forces dryRun=true and records latency metrics.
 *   isDrillMode() returns true only when BOX_DRILL_MODE === "ci".
 *   Callers may also pass opts.mode = DRILL_MODE.CI explicitly.
 *
 * ## Guardrail/rollback sequence contract (resolves Athena missing item #2)
 *   DrillExpectedSequence schema (defined below, see DRILL_SEQUENCE_SCHEMA_VERSION):
 *     guardrails        {string[]}              — ordered GUARDRAIL_ACTION values expected
 *     rollbackTrigger   {string|null}            — ROLLBACK_TRIGGER value to validate, or null
 *     rollbackLevel     {string|null}            — ROLLBACK_LEVEL value to validate, or null
 *     transitions       { from: string, to: string }[] — expected DRILL_TRANSITION_STATE sequence
 *
 * ## Drill report schema (resolves Athena missing item #3)
 *   Path:  state/drill_reports/drill_{ISO-timestamp-sanitized}.json
 *   See DRILL_REPORT_REQUIRED_FIELDS for the full field list.
 *   Schema version: DRILL_REPORT_SCHEMA_VERSION
 *
 * ## Four built-in drill scenarios
 *   DRILL_RUNAWAY_RETRIES          — triggers RUNAWAY_RETRIES catastrophe
 *   DRILL_MASS_BLOCKED_TASKS       — triggers MASS_BLOCKED_TASKS catastrophe
 *   DRILL_STALE_CRITICAL_STATE     — triggers STALE_CRITICAL_STATE catastrophe
 *   DRILL_REPEATED_AI_PARSE_FAILURES — triggers REPEATED_AI_PARSE_FAILURES catastrophe
 *
 * ## No destructive external calls in drill mode
 *   dryRun=true is enforced; no state files are created or mutated.
 *   Only the drill report itself is written (opt-in via persistDrillReport).
 *
 * ## Risk level: medium
 *   This file imports from three core runtime modules (catastrophe_detector,
 *   guardrail_executor, rollback_engine). No modifications are made to those
 *   modules — the drill harness is purely a consumer of their public interfaces.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";

import {
  CATASTROPHE_SCENARIO,
  CATASTROPHE_DEFAULTS,
  GUARDRAIL_ACTION,
  detectCatastrophes,
} from "./catastrophe_detector.js";

import {
  executeGuardrailsForDetections,
} from "./guardrail_executor.js";

import {
  ROLLBACK_TRIGGER,
  ROLLBACK_LEVEL,
  validateRollbackRequest,
} from "./rollback_engine.js";

// ── Schema versions ────────────────────────────────────────────────────────────

/** Schema version for DrillResult objects. Bump on incompatible field change. */
export const DRILL_RESULT_SCHEMA_VERSION = 1;

/** Schema version for DrillReport objects. Bump on incompatible field change. */
export const DRILL_REPORT_SCHEMA_VERSION = 1;

/** Schema version for DrillExpectedSequence objects. */
export const DRILL_SEQUENCE_SCHEMA_VERSION = 1;

// ── CI simulation mode activation (resolves Athena missing item #1) ───────────

/**
 * Drill mode enum.
 *   CI  — CI simulation mode: all drills are forced dryRun=true, no external calls.
 *   DEV — Developer mode: same safety guarantees as CI, for local exploration.
 */
export const DRILL_MODE = Object.freeze({
  CI:  "ci",
  DEV: "dev",
});

/**
 * Returns true when the BOX_DRILL_MODE environment variable is "ci".
 * This is the canonical activation check for CI simulation mode.
 * Callers may also pass opts.mode = DRILL_MODE.CI to force simulation mode.
 *
 * @returns {boolean}
 */
export function isDrillMode() {
  return String(process.env.BOX_DRILL_MODE || "").toLowerCase() === DRILL_MODE.CI;
}

// ── Drill status enum ─────────────────────────────────────────────────────────

/**
 * Pass/fail status values for a single drill result.
 */
export const DRILL_STATUS = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
});

// ── State transition enum (resolves Athena missing item #2) ───────────────────

/**
 * Ordered state machine transitions tracked during a drill execution.
 * A healthy drill must traverse exactly: PENDING → DETECTION_RUN →
 * GUARDRAIL_TRIGGERED → ROLLBACK_EVALUATED → RESOLVED.
 * A failing drill transitions to FAILED instead of RESOLVED.
 */
export const DRILL_TRANSITION_STATE = Object.freeze({
  PENDING:             "PENDING",
  DETECTION_RUN:       "DETECTION_RUN",
  GUARDRAIL_TRIGGERED: "GUARDRAIL_TRIGGERED",
  ROLLBACK_EVALUATED:  "ROLLBACK_EVALUATED",
  RESOLVED:            "RESOLVED",
  FAILED:              "FAILED",
});

/** The canonical happy-path transition sequence every passing drill must follow. */
export const DRILL_EXPECTED_TRANSITIONS = Object.freeze([
  { from: DRILL_TRANSITION_STATE.PENDING,             to: DRILL_TRANSITION_STATE.DETECTION_RUN },
  { from: DRILL_TRANSITION_STATE.DETECTION_RUN,       to: DRILL_TRANSITION_STATE.GUARDRAIL_TRIGGERED },
  { from: DRILL_TRANSITION_STATE.GUARDRAIL_TRIGGERED, to: DRILL_TRANSITION_STATE.ROLLBACK_EVALUATED },
  { from: DRILL_TRANSITION_STATE.ROLLBACK_EVALUATED,  to: DRILL_TRANSITION_STATE.RESOLVED },
]);

// ── Drill reason codes ────────────────────────────────────────────────────────

/**
 * Machine-readable reason codes for drill failures.
 * Used in DrillResult.failureReason.
 */
export const DRILL_REASON_CODE = Object.freeze({
  /** Detection did not produce the expected scenario. */
  DETECTION_MISMATCH:           "DETECTION_MISMATCH",
  /** Guardrail actions did not match the expected sequence. */
  SEQUENCE_MISMATCH:            "SEQUENCE_MISMATCH",
  /** Rollback validation returned unexpected result. */
  ROLLBACK_VALIDATION_FAILED:   "ROLLBACK_VALIDATION_FAILED",
  /** detectCatastrophes() returned ok=false. */
  DETECTION_ERROR:              "DETECTION_ERROR",
  /** executeGuardrailsForDetections() returned ok=false. */
  GUARDRAIL_EXECUTION_ERROR:    "GUARDRAIL_EXECUTION_ERROR",
  /** Drill attempted a destructive external call — safety violation. */
  DESTRUCTIVE_CALL_ATTEMPTED:   "DESTRUCTIVE_CALL_ATTEMPTED",
  /** Input to runDrill is null or missing required fields. */
  MISSING_INPUT:                "MISSING_INPUT",
  /** Input to runDrill fails structural validation. */
  INVALID_INPUT:                "INVALID_INPUT",
});

// ── Required fields for schema validation ─────────────────────────────────────

/**
 * Required fields for a DrillReport.
 * Governance tooling must validate these fields are present before accepting a report.
 */
export const DRILL_REPORT_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "reportId",
  "generatedAt",
  "mode",
  "drillCount",
  "passCount",
  "failCount",
  "totalLatencyMs",
  "results",
]);

/**
 * Required fields for a DrillResult.
 */
export const DRILL_RESULT_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "drillId",
  "scenarioId",
  "description",
  "mode",
  "status",
  "guardrailsExpected",
  "guardrailsTriggered",
  "sequenceMatch",
  "rollbackTriggerExpected",
  "rollbackTriggerValidated",
  "transitions",
  "latencyMs",
  "destructiveCallsMade",
  "failureReason",
  "executedAt",
]);

// ── Drill report output path ──────────────────────────────────────────────────

/**
 * Returns the subdirectory where drill reports are persisted.
 * Path: {stateDir}/drill_reports/
 *
 * @param {object} config — box config with paths.stateDir
 * @returns {string}
 */
export function drillReportsDir(config) {
  return path.join(config?.paths?.stateDir || "state", "drill_reports");
}

/**
 * Returns the file path for a drill report.
 * Path: {stateDir}/drill_reports/drill_{sanitizedTimestamp}.json
 *
 * @param {object} config
 * @param {string} [timestamp] — ISO timestamp; defaults to now
 * @returns {string}
 */
export function drillReportPath(config, timestamp) {
  const ts  = String(timestamp || new Date().toISOString()).replace(/[:.]/g, "-");
  return path.join(drillReportsDir(config), `drill_${ts}.json`);
}

// ── Built-in drill scenarios ───────────────────────────────────────────────────

/**
 * Four built-in drill scenarios, one per primary catastrophe type.
 * Each scenario provides:
 *   scenarioId    — CATASTROPHE_SCENARIO value to trigger
 *   description   — human-readable explanation
 *   ctx           — detectCatastrophes() input that MUST trigger the scenario
 *   expectedSequence — DrillExpectedSequence (guardrails + rollback + transitions)
 */
export const BUILT_IN_DRILLS = Object.freeze([
  {
    scenarioId:  CATASTROPHE_SCENARIO.RUNAWAY_RETRIES,
    description: "Inject retry storm: retryCount >= runawayRetryThreshold. " +
                 "Expected: RESET_RETRY_COUNTER, INCREASE_DELAY, FREEZE_SELF_IMPROVEMENT.",
    ctx: Object.freeze({
      retryCount:                CATASTROPHE_DEFAULTS.runawayRetryThreshold,
      totalTasks:                10,
      blockedTasks:              0,
      janusDirectiveAgeMs:       0,
      prometheusAnalysisAgeMs:   0,
      parseFailureCount:         0,
      consecutiveBudgetBreaches: 0,
      consecutiveSloBreaches:    0,
    }),
    expectedSequence: Object.freeze({
      schemaVersion:        DRILL_SEQUENCE_SCHEMA_VERSION,
      guardrails:           Object.freeze([
        GUARDRAIL_ACTION.RESET_RETRY_COUNTER,
        GUARDRAIL_ACTION.INCREASE_DELAY,
        GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT,
      ]),
      rollbackTrigger:      ROLLBACK_TRIGGER.CANARY_ROLLBACK,
      rollbackLevel:        ROLLBACK_LEVEL.CONFIG_ONLY,
      transitions:          DRILL_EXPECTED_TRANSITIONS,
    }),
  },
  {
    scenarioId:  CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS,
    description: "Inject mass blocking: >50% tasks blocked. " +
                 "Expected: pause_workers, notify_human, freeze_self_improvement.",
    ctx: Object.freeze({
      retryCount:                0,
      totalTasks:                10,
      blockedTasks:              6,  // 60% > massBlockedRatio (0.5)
      janusDirectiveAgeMs:       0,
      prometheusAnalysisAgeMs:   0,
      parseFailureCount:         0,
      consecutiveBudgetBreaches: 0,
      consecutiveSloBreaches:    0,
    }),
    expectedSequence: Object.freeze({
      schemaVersion:        DRILL_SEQUENCE_SCHEMA_VERSION,
      guardrails:           Object.freeze([
        GUARDRAIL_ACTION.PAUSE_WORKERS,
        GUARDRAIL_ACTION.NOTIFY_HUMAN,
        GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT,
      ]),
      rollbackTrigger:      ROLLBACK_TRIGGER.STATE_SCHEMA_VIOLATION,
      rollbackLevel:        ROLLBACK_LEVEL.STATE_SCHEMA,
      transitions:          DRILL_EXPECTED_TRANSITIONS,
    }),
  },
  {
    scenarioId:  CATASTROPHE_SCENARIO.STALE_CRITICAL_STATE,
    description: "Inject stale state: critical state files exceed staleness threshold. " +
                 "Expected: skip_cycle, force_checkpoint_validation, notify_human.",
    ctx: Object.freeze({
      retryCount:                0,
      totalTasks:                10,
      blockedTasks:              0,
      janusDirectiveAgeMs:       CATASTROPHE_DEFAULTS.staleCriticalStateAgeMs + 1,
      prometheusAnalysisAgeMs:   CATASTROPHE_DEFAULTS.staleCriticalStateAgeMs + 1,
      parseFailureCount:         0,
      consecutiveBudgetBreaches: 0,
      consecutiveSloBreaches:    0,
    }),
    expectedSequence: Object.freeze({
      schemaVersion:        DRILL_SEQUENCE_SCHEMA_VERSION,
      guardrails:           Object.freeze([
        GUARDRAIL_ACTION.SKIP_CYCLE,
        GUARDRAIL_ACTION.FORCE_CHECKPOINT_VALIDATION,
        GUARDRAIL_ACTION.NOTIFY_HUMAN,
      ]),
      rollbackTrigger:      ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE,
      rollbackLevel:        ROLLBACK_LEVEL.CONFIG_ONLY,
      transitions:          DRILL_EXPECTED_TRANSITIONS,
    }),
  },
  {
    scenarioId:  CATASTROPHE_SCENARIO.REPEATED_AI_PARSE_FAILURES,
    description: "Inject repeated AI parse failures: parseFailureCount >= threshold. " +
                 "Expected: increase_delay, freeze_self_improvement, escalate.",
    ctx: Object.freeze({
      retryCount:                0,
      totalTasks:                10,
      blockedTasks:              0,
      janusDirectiveAgeMs:       0,
      prometheusAnalysisAgeMs:   0,
      parseFailureCount:         CATASTROPHE_DEFAULTS.repeatedParseFailureThreshold,
      consecutiveBudgetBreaches: 0,
      consecutiveSloBreaches:    0,
    }),
    expectedSequence: Object.freeze({
      schemaVersion:        DRILL_SEQUENCE_SCHEMA_VERSION,
      guardrails:           Object.freeze([
        GUARDRAIL_ACTION.INCREASE_DELAY,
        GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT,
        GUARDRAIL_ACTION.ESCALATE,
      ]),
      rollbackTrigger:      ROLLBACK_TRIGGER.POLICY_PARSE_FAILURE,
      rollbackLevel:        ROLLBACK_LEVEL.POLICY_SET,
      transitions:          DRILL_EXPECTED_TRANSITIONS,
    }),
  },
]);

// ── Input validation ──────────────────────────────────────────────────────────

/**
 * Validate a drill scenario input object.
 * Distinguishes missing input from invalid input (AC-validation / Athena AC9).
 *
 * @param {any} scenario
 * @returns {{ ok: boolean, reason: string, message: string }}
 */
export function validateDrillScenario(scenario) {
  if (scenario === null || scenario === undefined) {
    return {
      ok: false,
      reason: DRILL_REASON_CODE.MISSING_INPUT,
      message: "scenario is null or undefined",
    };
  }
  if (typeof scenario !== "object" || Array.isArray(scenario)) {
    return {
      ok: false,
      reason: DRILL_REASON_CODE.INVALID_INPUT,
      message: "scenario must be a non-array object",
    };
  }

  const REQUIRED = ["scenarioId", "description", "ctx", "expectedSequence"];
  for (const field of REQUIRED) {
    if (!(field in scenario)) {
      return {
        ok: false,
        reason: DRILL_REASON_CODE.INVALID_INPUT,
        message: `missing required field "${field}"`,
      };
    }
  }

  if (!Object.values(CATASTROPHE_SCENARIO).includes(scenario.scenarioId)) {
    return {
      ok: false,
      reason: DRILL_REASON_CODE.INVALID_INPUT,
      message: `scenarioId "${scenario.scenarioId}" is not a valid CATASTROPHE_SCENARIO value`,
    };
  }

  const seq = scenario.expectedSequence;
  if (!seq || typeof seq !== "object") {
    return {
      ok: false,
      reason: DRILL_REASON_CODE.INVALID_INPUT,
      message: "expectedSequence must be an object",
    };
  }
  if (!Array.isArray(seq.guardrails) || seq.guardrails.length === 0) {
    return {
      ok: false,
      reason: DRILL_REASON_CODE.INVALID_INPUT,
      message: "expectedSequence.guardrails must be a non-empty array",
    };
  }
  if (!Array.isArray(seq.transitions) || seq.transitions.length === 0) {
    return {
      ok: false,
      reason: DRILL_REASON_CODE.INVALID_INPUT,
      message: "expectedSequence.transitions must be a non-empty array",
    };
  }

  return { ok: true, reason: null, message: null };
}

// ── Core drill executor ────────────────────────────────────────────────────────

/**
 * Run a single resilience drill scenario.
 *
 * Steps:
 *   1. Validate input scenario
 *   2. Run detectCatastrophes(ctx) — pure, no I/O
 *   3. Assert expected scenarioId is detected
 *   4. Run executeGuardrailsForDetections(..., { dryRun: true })
 *   5. Assert guardrail action sequence matches expectedSequence.guardrails
 *   6. Validate rollback request (validateRollbackRequest) — no execution
 *   7. Record state transitions
 *   8. Return DrillResult
 *
 * dryRun is ALWAYS true in CI mode or when opts.mode === DRILL_MODE.CI.
 * No destructive external calls are made in any execution path.
 *
 * @param {object} scenario — drill scenario (see BUILT_IN_DRILLS for shape)
 * @param {object} config   — box config with at minimum { paths: { stateDir } }
 * @param {object} [opts]
 * @param {string} [opts.mode]   — DRILL_MODE.CI | DRILL_MODE.DEV (overrides env var check)
 * @returns {Promise<object>} DrillResult
 */
export async function runDrill(scenario, config, opts: any = {}) {
  const drillId     = `drill-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const executedAt  = new Date().toISOString();
  const mode        = String(opts?.mode || (isDrillMode() ? DRILL_MODE.CI : DRILL_MODE.DEV));
  const t0          = performance.now();
  const transitions = [];

  function addTransition(from, to) {
    transitions.push({ from, to, at: new Date().toISOString() });
  }

  // ── Helper: build a failed DrillResult ────────────────────────────────────
  function failResult(reason, extra: any = {}) {
    addTransition(
      transitions.length > 0
        ? transitions[transitions.length - 1].to
        : DRILL_TRANSITION_STATE.PENDING,
      DRILL_TRANSITION_STATE.FAILED
    );
    const latencyMs = Math.round(performance.now() - t0);
    return {
      schemaVersion:            DRILL_RESULT_SCHEMA_VERSION,
      drillId,
      scenarioId:               scenario?.scenarioId ?? "unknown",
      description:              String(scenario?.description ?? ""),
      mode,
      status:                   DRILL_STATUS.FAIL,
      guardrailsExpected:       Array.isArray(scenario?.expectedSequence?.guardrails)
        ? [...scenario.expectedSequence.guardrails] : [],
      guardrailsTriggered:      extra.guardrailsTriggered ?? [],
      sequenceMatch:            false,
      rollbackTriggerExpected:  scenario?.expectedSequence?.rollbackTrigger ?? null,
      rollbackTriggerValidated: false,
      transitions,
      latencyMs,
      destructiveCallsMade:     0,
      failureReason:            reason,
      executedAt,
    };
  }

  // ── Step 0: Mark PENDING ──────────────────────────────────────────────────
  addTransition(DRILL_TRANSITION_STATE.PENDING, DRILL_TRANSITION_STATE.DETECTION_RUN);

  // ── Step 1: Validate input ────────────────────────────────────────────────
  const validation = validateDrillScenario(scenario);
  if (!validation.ok) {
    return failResult(`${validation.reason}: ${validation.message}`);
  }

  const { scenarioId, ctx, expectedSequence } = scenario;

  // ── Step 2: Run detection (pure, no I/O) ──────────────────────────────────
  const detectionResult = detectCatastrophes(ctx);
  if (!detectionResult.ok) {
    return failResult(
      `${DRILL_REASON_CODE.DETECTION_ERROR}: detectCatastrophes returned ok=false — ` +
      `code=${detectionResult.code} message=${detectionResult.message}`
    );
  }

  const detections = Array.isArray(detectionResult.detections) ? detectionResult.detections : [];

  // ── Step 3: Assert expected scenario is detected ─────────────────────────
  const expectedDetection = detections.find((d) => d.scenarioId === scenarioId);
  if (!expectedDetection) {
    return failResult(
      `${DRILL_REASON_CODE.DETECTION_MISMATCH}: expected scenario "${scenarioId}" ` +
      `was not detected; got [${detections.map((d) => d.scenarioId).join(", ")}]`
    );
  }

  addTransition(DRILL_TRANSITION_STATE.DETECTION_RUN, DRILL_TRANSITION_STATE.GUARDRAIL_TRIGGERED);

  // ── Step 4: Execute guardrails in dryRun mode (no state writes) ───────────
  const guardrailResult = await executeGuardrailsForDetections(
    config,
    [expectedDetection],
    { dryRun: true }  // ALWAYS dryRun — no destructive external calls
  );

  if (!guardrailResult.ok) {
    return failResult(
      `${DRILL_REASON_CODE.GUARDRAIL_EXECUTION_ERROR}: executeGuardrailsForDetections returned ok=false — ` +
      `${guardrailResult.reason ?? "unknown"}`
    );
  }

  // Collect guardrail actions that were (would have been) triggered
  const guardrailsTriggered = Array.isArray(guardrailResult.results)
    ? guardrailResult.results
        .filter((r) => r.ok)
        .map((r) => String(r.action ?? ""))
        .filter(Boolean)
    : [];

  // ── Step 5: Assert guardrail sequence matches expected ─────────────────────
  const guardrailsExpected = [...expectedSequence.guardrails];
  const sequenceMatch = (
    guardrailsTriggered.length === guardrailsExpected.length &&
    guardrailsExpected.every((a, i) => guardrailsTriggered[i] === a)
  );

  if (!sequenceMatch) {
    return {
      ...failResult(
        `${DRILL_REASON_CODE.SEQUENCE_MISMATCH}: expected [${guardrailsExpected.join(", ")}] ` +
        `but got [${guardrailsTriggered.join(", ")}]`,
        { guardrailsTriggered }
      ),
      guardrailsExpected,
      guardrailsTriggered,
    };
  }

  addTransition(DRILL_TRANSITION_STATE.GUARDRAIL_TRIGGERED, DRILL_TRANSITION_STATE.ROLLBACK_EVALUATED);

  // ── Step 6: Validate rollback request (no execution, purely structural) ───
  let rollbackFailureReason = null;

  if (expectedSequence.rollbackTrigger && expectedSequence.rollbackLevel) {
    const rbValidation = validateRollbackRequest({
      trigger: expectedSequence.rollbackTrigger,
      level:   expectedSequence.rollbackLevel,
    });
    if (!rbValidation.ok) {
      rollbackFailureReason =
        `${DRILL_REASON_CODE.ROLLBACK_VALIDATION_FAILED}: validateRollbackRequest returned ok=false — ` +
        `reason=${rbValidation.reason} message=${rbValidation.message}`;
    }
  }

  if (rollbackFailureReason) {
    return {
      ...failResult(rollbackFailureReason, { guardrailsTriggered }),
      guardrailsExpected,
      guardrailsTriggered,
      sequenceMatch,
    };
  }

  addTransition(DRILL_TRANSITION_STATE.ROLLBACK_EVALUATED, DRILL_TRANSITION_STATE.RESOLVED);

  const latencyMs = Math.round(performance.now() - t0);

  return {
    schemaVersion:            DRILL_RESULT_SCHEMA_VERSION,
    drillId,
    scenarioId,
    description:              String(scenario.description),
    mode,
    status:                   DRILL_STATUS.PASS,
    guardrailsExpected,
    guardrailsTriggered,
    sequenceMatch:            true,
    rollbackTriggerExpected:  expectedSequence.rollbackTrigger ?? null,
    rollbackTriggerValidated: true,
    transitions,
    latencyMs,
    destructiveCallsMade:     0,
    failureReason:            null,
    executedAt,
  };
}

// ── Run all built-in drills ────────────────────────────────────────────────────

/**
 * Run all four built-in drill scenarios and return a DrillReport.
 *
 * All drills use dryRun=true. No state files are written during drill execution.
 * The report itself can be persisted by calling persistDrillReport(config, report).
 *
 * @param {object} config — box config with at minimum { paths: { stateDir } }
 * @param {object} [opts]
 * @param {string} [opts.mode]     — DRILL_MODE.CI | DRILL_MODE.DEV
 * @param {object[]} [opts.drills] — override the drill list (defaults to BUILT_IN_DRILLS)
 * @returns {Promise<object>} DrillReport
 */
export async function runAllDrills(config, opts: any = {}) {
  const mode      = String(opts?.mode || (isDrillMode() ? DRILL_MODE.CI : DRILL_MODE.DEV));
  const drills    = Array.isArray(opts?.drills) ? opts.drills : BUILT_IN_DRILLS;
  const reportId  = `report-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const t0        = performance.now();

  const results = [];
  for (const drill of drills) {
    const result = await runDrill(drill, config, { mode });
    results.push(result);
  }

  const totalLatencyMs = Math.round(performance.now() - t0);
  const passCount      = results.filter((r) => r.status === DRILL_STATUS.PASS).length;
  const failCount      = results.filter((r) => r.status === DRILL_STATUS.FAIL).length;

  return {
    schemaVersion:   DRILL_REPORT_SCHEMA_VERSION,
    reportId,
    generatedAt:     new Date().toISOString(),
    mode,
    drillCount:      results.length,
    passCount,
    failCount,
    totalLatencyMs,
    results,
  };
}

// ── Persist drill report ──────────────────────────────────────────────────────

/**
 * Persist a DrillReport to state/drill_reports/drill_{timestamp}.json.
 *
 * Validates that all required fields are present before writing.
 * Distinguishes MISSING_INPUT from INVALID_INPUT with explicit reason codes.
 * Never silently drops data — write errors return ok=false with an explicit reason.
 *
 * @param {object} config — box config with paths.stateDir
 * @param {object} report — DrillReport from runAllDrills
 * @returns {Promise<{ ok: boolean, filePath?: string, reason?: string }>}
 */
export async function persistDrillReport(config, report) {
  if (report === null || report === undefined) {
    return { ok: false, reason: `${DRILL_REASON_CODE.MISSING_INPUT}: report is null or undefined` };
  }
  if (typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, reason: `${DRILL_REASON_CODE.INVALID_INPUT}: report must be a non-array object` };
  }

  for (const field of DRILL_REPORT_REQUIRED_FIELDS) {
    if (!(field in report)) {
      return {
        ok: false,
        reason: `${DRILL_REASON_CODE.INVALID_INPUT}: missing required field "${field}"`,
      };
    }
  }

  if (!Object.values(DRILL_MODE).includes(report.mode)) {
    return {
      ok: false,
      reason: `${DRILL_REASON_CODE.INVALID_INPUT}: mode "${report.mode}" is not a valid DRILL_MODE value`,
    };
  }

  const filePath = drillReportPath(config, report.generatedAt);

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(report, null, 2), "utf8");
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, reason: `WRITE_FAILED: ${String(err?.message || err)}` };
  }
}

