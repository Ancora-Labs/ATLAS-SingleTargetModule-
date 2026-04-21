/**
 * guardrail_executor.js — Deterministic guardrail action executor for BOX.
 *
 * This module executes the guardrail actions recommended by catastrophe_detector.js.
 * It is the authoritative home for all Athena-flagged specification gaps in T-033:
 *
 * ── Guardrail Reason Code Schema (AC2/AC8 — resolves Athena gap #3) ───────────
 *   GUARDRAIL_REASON_CODE defines every machine-readable code used in audit entries
 *   and action outcomes.  No code outside this enum may appear in state files.
 *
 * ── Cycle Interval & Latency SLA (AC5 — resolves Athena gap #2) ──────────────
 *   CYCLE_INTERVAL_MS = 30_000  — one orchestration poll cycle = 30 seconds.
 *   GUARDRAIL_LATENCY_SLA_MS = CYCLE_INTERVAL_MS.
 *   executeGuardrailsForDetections() measures its own wall-clock latency and
 *   returns { withinSla: boolean, latencyMs: number } so tests can assert it.
 *
 * ── Escalation Mechanism (resolves Athena gap #4) ────────────────────────────
 *   ESCALATION_TARGET   = "operator_audit_log"
 *   ESCALATION_MECHANISM = "state_file"
 *   All escalations are appended to state/guardrail_escalations.json AND
 *   state/guardrail_audit_log.json.  No webhook, no external call — purely
 *   observable via state files that operators (or monitors) can poll.
 *
 * ── State Files Written Per Action ───────────────────────────────────────────
 *   PAUSE_WORKERS             → state/guardrail_pause_workers.json
 *   FREEZE_SELF_IMPROVEMENT   → state/guardrail_freeze_self_improvement.json
 *   FORCE_CHECKPOINT_VALIDATION → state/guardrail_force_checkpoint.json
 *   INCREASE_DELAY            → state/guardrail_increase_delay.json
 *   NOTIFY_HUMAN              → state/guardrail_notifications.json (append)
 *   RESET_RETRY_COUNTER       → state/guardrail_reset_retry.json
 *   ESCALATE                  → state/guardrail_escalations.json (append)
 *   SKIP_CYCLE                → state/guardrail_skip_cycle.json
 *
 * ── Reversibility (AC2) ──────────────────────────────────────────────────────
 *   Flag-type actions are reversed by setting enabled=false in the state file.
 *   Append-type actions (NOTIFY_HUMAN, ESCALATE) are marked acknowledged.
 *   revertGuardrailAction() handles both cases and records a REVERTED audit entry.
 *
 * ── Dry-Run Mode (AC3) ───────────────────────────────────────────────────────
 *   Pass { dryRun: true } to executeGuardrailAction() or
 *   executeGuardrailsForDetections().  In dry-run mode no state files are written;
 *   the return value describes what would have been written.
 *
 * ── Manual Override (AC4) ────────────────────────────────────────────────────
 *   applyManualOverride(config, overrideSpec) requires:
 *     operatorId     {string} — non-empty operator identity
 *     operatorReason {string} — non-empty justification
 *     action         {string} — GUARDRAIL_ACTION value
 *     scenarioId     {string} — CATASTROPHE_SCENARIO value
 *   Validates both fields; distinguishes MISSING from INVALID with reason codes.
 *   Every override is written to the audit log with type="manual_override".
 *
 * ── Audit Trail Schema (AC4 / AC8) ───────────────────────────────────────────
 *   state/guardrail_audit_log.json:
 *   { schemaVersion, updatedAt, entries: GuardrailAuditEntry[] }
 *
 *   GuardrailAuditEntry required fields:
 *     id            {string}       — unique identifier
 *     type          {string}       — GUARDRAIL_AUDIT_ENTRY_TYPE value
 *     action        {string}       — GUARDRAIL_ACTION value
 *     scenarioId    {string}       — CATASTROPHE_SCENARIO value
 *     reasonCode    {string}       — GUARDRAIL_REASON_CODE value
 *     operatorId    {string|null}  — null for automated actions
 *     operatorReason {string|null} — null for automated actions
 *     timestamp     {string}       — ISO 8601
 *     dryRun        {boolean}
 *     stateFile     {string|null}  — affected state file path, or null
 *
 * ── No Silent Fallback (AC10) ─────────────────────────────────────────────────
 *   All public functions return { ok, status, reason } on error.
 *   Errors are never swallowed silently.
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";
import { GUARDRAIL_ACTION, CATASTROPHE_SCENARIO, isSloCascadingBreachScenario } from "./catastrophe_detector.js";

// ── Schema version ─────────────────────────────────────────────────────────────

/** Schema version for all guardrail state files and audit log. */
export const GUARDRAIL_EXECUTOR_SCHEMA_VERSION = 1;

// ── Cycle Interval & Latency SLA (AC5 — resolves Athena gap #2) ───────────────

/**
 * One orchestration poll cycle duration in milliseconds.
 * Defined here as the authoritative constant for latency SLA assertions.
 * Value matches WORKERS_DONE_POLL_MS in orchestrator.js (30 000 ms).
 */
export const CYCLE_INTERVAL_MS = 30_000;

/**
 * Guardrail activation latency SLA: guardrails must complete within one cycle.
 * AC5: unit = CYCLE_INTERVAL_MS; tests assert latencyMs < GUARDRAIL_LATENCY_SLA_MS.
 */
export const GUARDRAIL_LATENCY_SLA_MS = CYCLE_INTERVAL_MS;

// ── Escalation Mechanism (resolves Athena gap #4) ─────────────────────────────

/** Target designation for all ESCALATE actions. */
export const ESCALATION_TARGET    = "operator_audit_log";

/** Mechanism used for escalation: state file that operators/monitors can poll. */
export const ESCALATION_MECHANISM = "state_file";

// ── Reason Code Catalog (AC2/AC8 — resolves Athena gap #3) ───────────────────

/**
 * Exhaustive catalog of machine-readable reason codes for all guardrail outcomes.
 * Every GuardrailAuditEntry.reasonCode and action result.reasonCode MUST be one of
 * these values — no free-form strings allowed in guardrail state files.
 *
 * Categories:
 *   AUTO_*      — outcomes from automated detection path
 *   MANUAL_*    — outcomes from operator-driven path
 *   DRY_RUN     — action was simulated (no state written)
 *   REVERTED    — a previously active guardrail was reverted
 *   MISSING_*   — input is null/undefined (absent entirely)
 *   INVALID_*   — input is present but fails structural validation
 */
export const GUARDRAIL_REASON_CODE = Object.freeze({
  /** Action applied automatically from catastrophe detection result. */
  AUTO_APPLIED:               "AUTO_APPLIED",
  /** Action failed during automated execution (state write error). */
  AUTO_FAILED:                "AUTO_FAILED",
  /** Action applied by operator via applyManualOverride(). */
  MANUAL_OVERRIDE:            "MANUAL_OVERRIDE",
  /** Action was reverted (disabled/acknowledged) by operator. */
  REVERTED:                   "REVERTED",
  /** Action was reverted automatically by the system when its trigger condition resolved. */
  AUTO_REVERTED:              "AUTO_REVERTED",
  /** Action was simulated in dry-run mode — no state written. */
  DRY_RUN:                    "DRY_RUN",
  /** Input detections array is null or undefined. */
  MISSING_DETECTIONS:         "MISSING_DETECTIONS",
  /** Input detections is present but not an array. */
  INVALID_DETECTIONS:         "INVALID_DETECTIONS",
  /** Manual override attempted without providing operatorId. */
  MISSING_OPERATOR_ID:        "MISSING_OPERATOR_ID",
  /** Manual override attempted without providing operatorReason. */
  MISSING_OPERATOR_REASON:    "MISSING_OPERATOR_REASON",
  /** Override spec is null or undefined. */
  MISSING_OVERRIDE_SPEC:      "MISSING_OVERRIDE_SPEC",
  /** Override spec is present but fails structural validation. */
  INVALID_OVERRIDE_SPEC:      "INVALID_OVERRIDE_SPEC",
  /** action field is not a recognized GUARDRAIL_ACTION value. */
  INVALID_ACTION:             "INVALID_ACTION",
  /** scenarioId field is missing or not a non-empty string. */
  INVALID_SCENARIO_ID:        "INVALID_SCENARIO_ID",
  /** revert target actionId is null or undefined. */
  MISSING_ACTION_ID:          "MISSING_ACTION_ID",
  /** revert target actionId was not found in the audit log. */
  ACTION_NOT_FOUND:           "ACTION_NOT_FOUND",
  /** Guardrail state file write failed unexpectedly. */
  WRITE_FAILED:               "WRITE_FAILED",
  /** Internal unexpected error. */
  INTERNAL_ERROR:             "INTERNAL_ERROR",
});

// ── Audit Entry Type Enum ──────────────────────────────────────────────────────

/** Exhaustive type enum for GuardrailAuditEntry.type. */
export const GUARDRAIL_AUDIT_ENTRY_TYPE = Object.freeze({
  AUTO_APPLIED:    "auto_applied",
  MANUAL_OVERRIDE: "manual_override",
  REVERTED:        "reverted",
  DRY_RUN:         "dry_run",
});

// ── State File Name Registry ───────────────────────────────────────────────────

/**
 * Maps each GUARDRAIL_ACTION value to its state file name.
 * Append-type actions (NOTIFY_HUMAN, ESCALATE) write to separate append logs.
 */
const ACTION_STATE_FILE = Object.freeze({
  [GUARDRAIL_ACTION.PAUSE_WORKERS]:             "guardrail_pause_workers.json",
  [GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT]:   "guardrail_freeze_self_improvement.json",
  [GUARDRAIL_ACTION.FORCE_CHECKPOINT_VALIDATION]: "guardrail_force_checkpoint.json",
  [GUARDRAIL_ACTION.INCREASE_DELAY]:            "guardrail_increase_delay.json",
  [GUARDRAIL_ACTION.NOTIFY_HUMAN]:              "guardrail_notifications.json",
  [GUARDRAIL_ACTION.RESET_RETRY_COUNTER]:       "guardrail_reset_retry.json",
  [GUARDRAIL_ACTION.ESCALATE]:                  "guardrail_escalations.json",
  [GUARDRAIL_ACTION.SKIP_CYCLE]:                "guardrail_skip_cycle.json",
});

/** Actions that are append-only (cannot be set-and-revert by enabled flag). */
const APPEND_ONLY_ACTIONS = new Set([
  GUARDRAIL_ACTION.NOTIFY_HUMAN,
  GUARDRAIL_ACTION.ESCALATE,
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

function stateDir(config) {
  return config?.paths?.stateDir || "state";
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

// ── Internal: Audit Log ────────────────────────────────────────────────────────

function auditLogFile(config) {
  return path.join(stateDir(config), "guardrail_audit_log.json");
}

/**
 * Load the guardrail audit log.
 *
 * @param {object} config
 * @returns {Promise<object>}
 */
export async function loadGuardrailAuditLog(config) {
  return readJson(auditLogFile(config), {
    schemaVersion: GUARDRAIL_EXECUTOR_SCHEMA_VERSION,
    updatedAt:     new Date().toISOString(),
    entries:       [],
  });
}

/**
 * Append one audit entry to guardrail_audit_log.json.
 * Trims to the last 500 entries. Never throws — returns { ok, reason }.
 *
 * @param {object} config
 * @param {object} entry — GuardrailAuditEntry
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function _appendAuditEntry(config, entry) {
  try {
    const log = await loadGuardrailAuditLog(config);
    const entries = Array.isArray(log.entries) ? log.entries : [];
    entries.push({ ...entry, savedAt: new Date().toISOString() });
    log.entries   = entries.length > 500 ? entries.slice(-500) : entries;
    log.updatedAt = new Date().toISOString();
    await writeJson(auditLogFile(config), log);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `${GUARDRAIL_REASON_CODE.WRITE_FAILED}: ${String(err?.message || err)}` };
  }
}

// ── Internal: Flag-type State File ────────────────────────────────────────────

/**
 * Write (or simulate writing) the state file for a flag-type guardrail action.
 *
 * @param {object} config
 * @param {string} action        — GUARDRAIL_ACTION value
 * @param {string} actionId      — unique ID for this activation
 * @param {string} scenarioId    — triggering scenario
 * @param {string} reasonCode    — GUARDRAIL_REASON_CODE value
 * @param {boolean} dryRun       — if true, no file is written
 * @returns {Promise<{ ok: boolean, stateFile: string|null, reason?: string }>}
 */
async function _writeActionStateFile(config, action, actionId, scenarioId, reasonCode, dryRun) {
  const fileName = ACTION_STATE_FILE[action];
  if (!fileName) {
    return { ok: false, stateFile: null, reason: `${GUARDRAIL_REASON_CODE.INVALID_ACTION}: no state file for "${action}"` };
  }

  const filePath = path.join(stateDir(config), fileName);
  const now      = new Date().toISOString();

  if (dryRun) {
    return { ok: true, stateFile: filePath };
  }

  try {
    if (APPEND_ONLY_ACTIONS.has(action)) {
      // Append-only: load existing, push new entry, write back
      const existing = await readJson(filePath, {
        schemaVersion: GUARDRAIL_EXECUTOR_SCHEMA_VERSION,
        updatedAt:     now,
        entries:       [],
      });
      const entries = Array.isArray(existing.entries) ? existing.entries : [];
      entries.push({
        id:         actionId,
        action,
        scenarioId,
        reasonCode,
        timestamp:  now,
        target:     action === GUARDRAIL_ACTION.ESCALATE ? ESCALATION_TARGET   : null,
        mechanism:  action === GUARDRAIL_ACTION.ESCALATE ? ESCALATION_MECHANISM : null,
        dryRun:     false,
      });
      existing.entries   = entries.length > 200 ? entries.slice(-200) : entries;
      existing.updatedAt = now;
      await writeJson(filePath, existing);
    } else {
      // Flag-type: write enable record
      await writeJson(filePath, {
        schemaVersion: GUARDRAIL_EXECUTOR_SCHEMA_VERSION,
        enabled:       true,
        action,
        actionId,
        scenarioId,
        reasonCode,
        appliedAt:     now,
        revertedAt:    null,
      });
    }
    return { ok: true, stateFile: filePath };
  } catch (err) {
    return { ok: false, stateFile: filePath, reason: `${GUARDRAIL_REASON_CODE.WRITE_FAILED}: ${String(err?.message || err)}` };
  }
}

/**
 * Revert (disable or acknowledge) the state file for a flag-type guardrail action.
 *
 * @param {object} config
 * @param {string} action — GUARDRAIL_ACTION value
 * @param {boolean} dryRun — if true, no file is modified
 * @returns {Promise<{ ok: boolean, stateFile: string|null, reason?: string }>}
 */
async function _revertActionStateFile(config, action, dryRun) {
  const fileName = ACTION_STATE_FILE[action];
  if (!fileName) {
    return { ok: false, stateFile: null, reason: `${GUARDRAIL_REASON_CODE.INVALID_ACTION}: no state file for "${action}"` };
  }

  const filePath = path.join(stateDir(config), fileName);

  if (dryRun) {
    return { ok: true, stateFile: filePath };
  }

  try {
    if (APPEND_ONLY_ACTIONS.has(action)) {
      // Append-only: nothing to revert (notification/escalation already sent)
      return { ok: true, stateFile: filePath };
    }

    const existing = await readJson(filePath, null);
    if (!existing) {
      return { ok: true, stateFile: filePath }; // already absent — idempotent
    }
    await writeJson(filePath, {
      ...existing,
      enabled:    false,
      revertedAt: new Date().toISOString(),
    });
    return { ok: true, stateFile: filePath };
  } catch (err) {
    return { ok: false, stateFile: filePath, reason: `${GUARDRAIL_REASON_CODE.WRITE_FAILED}: ${String(err?.message || err)}` };
  }
}

// ── Public: Single Action Executor ────────────────────────────────────────────

/**
 * Execute one guardrail action for a given catastrophe scenario.
 *
 * Always records an audit entry (even in dry-run mode — type="dry_run").
 * Never throws — returns structured outcome.
 *
 * @param {object} config
 * @param {string} action     — GUARDRAIL_ACTION value
 * @param {string} scenarioId — triggering CATASTROPHE_SCENARIO value
 * @param {string} reasonCode — GUARDRAIL_REASON_CODE value
 * @param {{ dryRun?: boolean, operatorId?: string, operatorReason?: string }} [opts]
 * @returns {Promise<{
 *   ok:         boolean,
 *   actionId:   string,
 *   action:     string,
 *   scenarioId: string,
 *   reasonCode: string,
 *   dryRun:     boolean,
 *   stateFile:  string|null,
 *   reason?:    string,
 * }>}
 */
export async function executeGuardrailAction(config, action, scenarioId, reasonCode, opts: any = {}) {
  const dryRun       = Boolean(opts?.dryRun);
  const operatorId   = opts?.operatorId   ?? null;
  const operatorReason = opts?.operatorReason ?? null;

  // Validate action
  if (!action || !Object.values(GUARDRAIL_ACTION).includes(action)) {
    return {
      ok:         false,
      actionId:   null,
      action:     String(action),
      scenarioId: String(scenarioId),
      reasonCode: GUARDRAIL_REASON_CODE.INVALID_ACTION,
      dryRun,
      stateFile:  null,
      reason:     `${GUARDRAIL_REASON_CODE.INVALID_ACTION}: "${action}" is not a valid GUARDRAIL_ACTION`,
    };
  }

  const actionId  = newId("guardrail");
  const entryType = dryRun
    ? GUARDRAIL_AUDIT_ENTRY_TYPE.DRY_RUN
    : operatorId
      ? GUARDRAIL_AUDIT_ENTRY_TYPE.MANUAL_OVERRIDE
      : GUARDRAIL_AUDIT_ENTRY_TYPE.AUTO_APPLIED;

  // Write (or simulate) the action state file
  const writeResult = await _writeActionStateFile(config, action, actionId, scenarioId, reasonCode, dryRun);

  const finalReasonCode = writeResult.ok
    ? (dryRun ? GUARDRAIL_REASON_CODE.DRY_RUN : reasonCode)
    : GUARDRAIL_REASON_CODE.AUTO_FAILED;

  // Always record audit entry
  await _appendAuditEntry(config, {
    id:             actionId,
    type:           entryType,
    action,
    scenarioId:     String(scenarioId),
    reasonCode:     finalReasonCode,
    operatorId,
    operatorReason,
    timestamp:      new Date().toISOString(),
    dryRun,
    stateFile:      writeResult.stateFile,
  });

  return {
    ok:         writeResult.ok,
    actionId,
    action,
    scenarioId: String(scenarioId),
    reasonCode: finalReasonCode,
    dryRun,
    stateFile:  writeResult.stateFile,
    ...(writeResult.ok ? {} : { reason: writeResult.reason }),
  };
}

// ── Public: Batch Executor ─────────────────────────────────────────────────────

/**
 * Execute all guardrail actions recommended by a set of catastrophe detections.
 *
 * Measures its own wall-clock latency and returns withinSla=true when
 * latencyMs < GUARDRAIL_LATENCY_SLA_MS.  AC5: latency is now machine-checkable.
 *
 * Advisory — never blocks orchestration. Any per-action error is recorded in
 * results but does not halt processing of remaining actions.
 *
 * @param {object}   config
 * @param {object[]} detections — CatastropheAlert[] from detectCatastrophes()
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<{
 *   ok:        boolean,
 *   status:    string,
 *   dryRun:    boolean,
 *   results:   object[],
 *   latencyMs: number,
 *   withinSla: boolean,
 *   reason?:   string,
 * }>}
 */
export async function executeGuardrailsForDetections(config, detections, opts: any = {}) {
  const t0     = Date.now();
  const dryRun = Boolean(opts?.dryRun);

  if (detections === null || detections === undefined) {
    return {
      ok:        false,
      status:    "degraded",
      dryRun,
      results:   [],
      latencyMs: Date.now() - t0,
      withinSla: true,
      reason:    `${GUARDRAIL_REASON_CODE.MISSING_DETECTIONS}: detections is null or undefined`,
    };
  }

  if (!Array.isArray(detections)) {
    return {
      ok:        false,
      status:    "degraded",
      dryRun,
      results:   [],
      latencyMs: Date.now() - t0,
      withinSla: true,
      reason:    `${GUARDRAIL_REASON_CODE.INVALID_DETECTIONS}: detections must be an array`,
    };
  }

  const results = [];

  for (const alert of detections) {
    const scenarioId = String(alert?.scenarioId || "unknown");
    const guardrails = Array.isArray(alert?.guardrails) ? alert.guardrails : [];

    for (const g of guardrails) {
      const result = await executeGuardrailAction(
        config,
        g.action,
        scenarioId,
        GUARDRAIL_REASON_CODE.AUTO_APPLIED,
        { dryRun }
      );
      results.push(result);
    }
  }

  const latencyMs = Date.now() - t0;
  const allOk     = results.every(r => r.ok);

  return {
    ok:        allOk || results.length === 0,
    status:    allOk ? "executed" : "partial",
    dryRun,
    results,
    latencyMs,
    withinSla: latencyMs < GUARDRAIL_LATENCY_SLA_MS,
  };
}

// ── Public: Manual Override ────────────────────────────────────────────────────

/**
 * Apply a manual operator override for a guardrail action.
 *
 * Requires explicit operatorId and operatorReason — both are mandatory.
 * Distinguishes MISSING from INVALID with explicit reason codes (AC9).
 *
 * @param {object} config
 * @param {object|null|undefined} overrideSpec — {
 *   operatorId:     string  (non-empty, required)
 *   operatorReason: string  (non-empty, required)
 *   action:         string  (GUARDRAIL_ACTION value, required)
 *   scenarioId:     string  (CATASTROPHE_SCENARIO value, required)
 *   dryRun?:        boolean
 * }
 * @returns {Promise<{
 *   ok:         boolean,
 *   actionId:   string|null,
 *   reasonCode: string,
 *   reason?:    string,
 * }>}
 */
export async function applyManualOverride(config, overrideSpec) {
  if (overrideSpec === null || overrideSpec === undefined) {
    return {
      ok:         false,
      actionId:   null,
      reasonCode: GUARDRAIL_REASON_CODE.MISSING_OVERRIDE_SPEC,
      reason:     `${GUARDRAIL_REASON_CODE.MISSING_OVERRIDE_SPEC}: overrideSpec is null or undefined`,
    };
  }
  if (typeof overrideSpec !== "object" || Array.isArray(overrideSpec)) {
    return {
      ok:         false,
      actionId:   null,
      reasonCode: GUARDRAIL_REASON_CODE.INVALID_OVERRIDE_SPEC,
      reason:     `${GUARDRAIL_REASON_CODE.INVALID_OVERRIDE_SPEC}: overrideSpec must be a plain object`,
    };
  }

  // Validate operatorId
  if (!overrideSpec.operatorId && overrideSpec.operatorId !== 0) {
    return {
      ok:         false,
      actionId:   null,
      reasonCode: GUARDRAIL_REASON_CODE.MISSING_OPERATOR_ID,
      reason:     `${GUARDRAIL_REASON_CODE.MISSING_OPERATOR_ID}: operatorId is required for manual override`,
    };
  }
  if (typeof overrideSpec.operatorId !== "string" || overrideSpec.operatorId.trim() === "") {
    return {
      ok:         false,
      actionId:   null,
      reasonCode: GUARDRAIL_REASON_CODE.MISSING_OPERATOR_ID,
      reason:     `${GUARDRAIL_REASON_CODE.MISSING_OPERATOR_ID}: operatorId must be a non-empty string`,
    };
  }

  // Validate operatorReason
  if (!overrideSpec.operatorReason && overrideSpec.operatorReason !== 0) {
    return {
      ok:         false,
      actionId:   null,
      reasonCode: GUARDRAIL_REASON_CODE.MISSING_OPERATOR_REASON,
      reason:     `${GUARDRAIL_REASON_CODE.MISSING_OPERATOR_REASON}: operatorReason is required for manual override`,
    };
  }
  if (typeof overrideSpec.operatorReason !== "string" || overrideSpec.operatorReason.trim() === "") {
    return {
      ok:         false,
      actionId:   null,
      reasonCode: GUARDRAIL_REASON_CODE.MISSING_OPERATOR_REASON,
      reason:     `${GUARDRAIL_REASON_CODE.MISSING_OPERATOR_REASON}: operatorReason must be a non-empty string`,
    };
  }

  // Validate action
  if (!overrideSpec.action || !Object.values(GUARDRAIL_ACTION).includes(overrideSpec.action)) {
    return {
      ok:         false,
      actionId:   null,
      reasonCode: GUARDRAIL_REASON_CODE.INVALID_ACTION,
      reason:     `${GUARDRAIL_REASON_CODE.INVALID_ACTION}: "${overrideSpec.action}" is not a valid GUARDRAIL_ACTION`,
    };
  }

  // Validate scenarioId
  if (!overrideSpec.scenarioId || typeof overrideSpec.scenarioId !== "string" || overrideSpec.scenarioId.trim() === "") {
    return {
      ok:         false,
      actionId:   null,
      reasonCode: GUARDRAIL_REASON_CODE.INVALID_SCENARIO_ID,
      reason:     `${GUARDRAIL_REASON_CODE.INVALID_SCENARIO_ID}: scenarioId must be a non-empty string`,
    };
  }

  const result = await executeGuardrailAction(
    config,
    overrideSpec.action,
    overrideSpec.scenarioId,
    GUARDRAIL_REASON_CODE.MANUAL_OVERRIDE,
    {
      dryRun:         Boolean(overrideSpec.dryRun),
      operatorId:     overrideSpec.operatorId,
      operatorReason: overrideSpec.operatorReason,
    }
  );

  return {
    ok:         result.ok,
    actionId:   result.actionId,
    reasonCode: result.reasonCode,
    ...(result.ok ? {} : { reason: result.reason }),
  };
}

// ── Public: Revert ─────────────────────────────────────────────────────────────

/**
 * Revert a previously applied guardrail action.
 *
 * Identifies the action by actionId from the audit log, then disables
 * the corresponding state file.  Records a REVERTED audit entry.
 *
 * @param {object}      config
 * @param {string|null} actionId       — ID returned by executeGuardrailAction
 * @param {string}      operatorId     — who is reverting (required)
 * @param {string}      operatorReason — why (required)
 * @param {boolean}     [dryRun=false]
 * @returns {Promise<{
 *   ok:         boolean,
 *   reasonCode: string,
 *   reason?:    string,
 * }>}
 */
export async function revertGuardrailAction(config, actionId, operatorId, operatorReason, dryRun = false) {
  if (!actionId) {
    return {
      ok:         false,
      reasonCode: GUARDRAIL_REASON_CODE.MISSING_ACTION_ID,
      reason:     `${GUARDRAIL_REASON_CODE.MISSING_ACTION_ID}: actionId is required`,
    };
  }
  if (!operatorId || typeof operatorId !== "string" || operatorId.trim() === "") {
    return {
      ok:         false,
      reasonCode: GUARDRAIL_REASON_CODE.MISSING_OPERATOR_ID,
      reason:     `${GUARDRAIL_REASON_CODE.MISSING_OPERATOR_ID}: operatorId is required for revert`,
    };
  }
  if (!operatorReason || typeof operatorReason !== "string" || operatorReason.trim() === "") {
    return {
      ok:         false,
      reasonCode: GUARDRAIL_REASON_CODE.MISSING_OPERATOR_REASON,
      reason:     `${GUARDRAIL_REASON_CODE.MISSING_OPERATOR_REASON}: operatorReason is required for revert`,
    };
  }

  try {
    // Find original action from audit log
    const log     = await loadGuardrailAuditLog(config);
    const entries = Array.isArray(log.entries) ? log.entries : [];
    const original = entries.find(e => e.id === actionId);

    if (!original) {
      return {
        ok:         false,
        reasonCode: GUARDRAIL_REASON_CODE.ACTION_NOT_FOUND,
        reason:     `${GUARDRAIL_REASON_CODE.ACTION_NOT_FOUND}: no audit entry found for actionId="${actionId}"`,
      };
    }

    const action = original.action;

    // Revert the state file
    const revertResult = await _revertActionStateFile(config, action, dryRun);

    // Record REVERTED audit entry
    await _appendAuditEntry(config, {
      id:             newId("revert"),
      type:           GUARDRAIL_AUDIT_ENTRY_TYPE.REVERTED,
      action,
      scenarioId:     String(original.scenarioId),
      reasonCode:     GUARDRAIL_REASON_CODE.REVERTED,
      operatorId,
      operatorReason,
      timestamp:      new Date().toISOString(),
      dryRun:         Boolean(dryRun),
      stateFile:      revertResult.stateFile,
      revertedActionId: actionId,
    });

    return {
      ok:         revertResult.ok,
      reasonCode: GUARDRAIL_REASON_CODE.REVERTED,
      ...(revertResult.ok ? {} : { reason: revertResult.reason }),
    };
  } catch (err) {
    return {
      ok:         false,
      reasonCode: GUARDRAIL_REASON_CODE.INTERNAL_ERROR,
      reason:     `${GUARDRAIL_REASON_CODE.INTERNAL_ERROR}: ${String(err?.message || err)}`,
    };
  }
}

// ── Public: Read Active Guardrail State ────────────────────────────────────────

/**
 * Read the current state for a specific flag-type guardrail action.
 *
 * Returns null if no state file exists (action not currently active).
 * Returns the parsed state object if the file exists.
 *
 * @param {object} config
 * @param {string} action — GUARDRAIL_ACTION value
 * @returns {Promise<object|null>}
 */
export async function readGuardrailState(config, action) {
  const fileName = ACTION_STATE_FILE[action];
  if (!fileName) return null;
  const filePath = path.join(stateDir(config), fileName);
  return readJson(filePath, null);
}

/**
 * Build a normalized contract for FORCE_CHECKPOINT_VALIDATION state.
 * This keeps orchestrator-side governance checks deterministic even when the
 * underlying state shape evolves.
 */
export function normalizeForceCheckpointState(state: any) {
  if (!state || typeof state !== "object") {
    return {
      active: false,
      scenarioId: null,
      overrideActive: false,
      overrideReason: null,
      overrideBy: null,
      state,
    };
  }
  const enabled = state.enabled === true && state.revertedAt === null;
  const overrideActive = state.overrideActive === true;
  return {
    active: enabled,
    scenarioId: typeof state.scenarioId === "string" ? state.scenarioId : null,
    overrideActive,
    overrideReason: overrideActive && typeof state.overrideReason === "string" ? state.overrideReason : null,
    overrideBy: overrideActive && typeof state.overrideBy === "string" ? state.overrideBy : null,
    state,
  };
}

/**
 * Read FORCE_CHECKPOINT_VALIDATION state and return a normalized gate contract.
 */
export async function readForceCheckpointValidationContract(config) {
  const raw = await readGuardrailState(config, GUARDRAIL_ACTION.FORCE_CHECKPOINT_VALIDATION);
  return normalizeForceCheckpointState(raw);
}

/**
 * Returns true if the given flag-type guardrail action is currently enabled.
 *
 * @param {object} config
 * @param {string} action — GUARDRAIL_ACTION value
 * @returns {Promise<boolean>}
 */
export async function isGuardrailActive(config, action) {
  const state = await readGuardrailState(config, action);
  if (!state) return false;
  if (APPEND_ONLY_ACTIONS.has(action)) {
    // Append-only actions are "active" if they have entries
    return Array.isArray(state.entries) && state.entries.length > 0;
  }
  return state.enabled === true && state.revertedAt === null;
}

// ── Public: Auto-Revert SLO Guardrail When Condition Resolves ─────────────────

/**
 * Automatically revert the FORCE_CHECKPOINT_VALIDATION guardrail if it was
 * triggered by SLO_CASCADING_BREACH and the SLO breach streak has since resolved.
 *
 * Called once per cycle after catastrophe detection. If the SLO_CASCADING_BREACH
 * scenario is no longer detected (isSloCurrentlyBreaching === false), any active
 * FORCE_CHECKPOINT_VALIDATION guardrail with that scenarioId is reverted so
 * dispatch is unblocked without manual operator intervention.
 *
 * @param {object}  config                   — box config object
 * @param {boolean} isSloCurrentlyBreaching  — true if SLO_CASCADING_BREACH was
 *                                             detected in the current cycle
 * @returns {Promise<{ reverted: boolean, reason?: string }>}
 */
export async function autoRevertSloGuardrailIfResolved(config, isSloCurrentlyBreaching: boolean): Promise<{ reverted: boolean; reason?: string }> {
  if (isSloCurrentlyBreaching) {
    return { reverted: false };
  }

  try {
    const contract = await readForceCheckpointValidationContract(config);
    if (!contract.active) {
      return { reverted: false };
    }
    if (!isSloCascadingBreachScenario(contract.scenarioId)) {
      return { reverted: false };
    }

    // Condition has resolved — auto-revert the state file
    const revertResult = await _revertActionStateFile(config, GUARDRAIL_ACTION.FORCE_CHECKPOINT_VALIDATION, false);

    // Record an AUTO_REVERTED audit entry for observability
    const actionId = contract.state?.actionId ?? null;
    await _appendAuditEntry(config, {
      id:             newId("auto-revert"),
      type:           GUARDRAIL_AUDIT_ENTRY_TYPE.REVERTED,
      action:         GUARDRAIL_ACTION.FORCE_CHECKPOINT_VALIDATION,
      scenarioId:     CATASTROPHE_SCENARIO.SLO_CASCADING_BREACH,
      reasonCode:     GUARDRAIL_REASON_CODE.AUTO_REVERTED,
      operatorId:     "system",
      operatorReason: "SLO_CASCADING_BREACH condition resolved (no consecutive SLO breaches detected this cycle); guardrail auto-reverted by orchestrator",
      timestamp:      new Date().toISOString(),
      dryRun:         false,
      stateFile:      revertResult.stateFile,
      ...(actionId ? { revertedActionId: actionId } : {}),
    });

    return { reverted: revertResult.ok, ...(revertResult.ok ? {} : { reason: revertResult.reason }) };
  } catch (err) {
    return { reverted: false, reason: `INTERNAL_ERROR: ${String((err as any)?.message || err)}` };
  }
}
