/**
 * Canary Engine — State machine for staged config rollout with auto-promotion and auto-rollback.
 *
 * ## Canary rollout flow (T-022)
 *
 *   1. startCanary()         — Stage a config change in the canary ledger. The change is written
 *                              to box.config.json immediately so the running system observes it.
 *                              The old (control) value is preserved in the ledger as the rollback target.
 *
 *   2. processRunningCanaries() — Called each self-improvement cycle. Records a metric snapshot
 *                              for every running canary experiment.
 *                              Snapshot recording is sampled by canaryRatio:
 *                                effectiveCycles = ceil(minCyclesToObserve / canaryRatio)
 *                              This means a lower ratio results in a longer observation window,
 *                              giving the system more time to detect instability.
 *
 *   3. evaluateAndAdvance()  — After enough snapshots:
 *                                • Check rollback signals first (fast failure path).
 *                                • If rollback triggered → rollbackCanary().
 *                                • If promotion thresholds met → promoteCanary().
 *                                • Otherwise → continue observing.
 *
 *   4. promoteCanary()       — Mark the canary as promoted. The change is already in
 *                              box.config.json; promotion records provenance and emits audit event.
 *
 *   5. rollbackCanary()      — Revert box.config.json to the control value and emit audit event.
 *
 * ## Rollback target state (AC4 / AC13)
 *   The `controlValue` stored in the canary ledger entry is the rollback target.
 *   On rollback, the engine writes controlValue back to box.config.json at configPath.
 *
 * ## canaryRatio semantics (AC1)
 *   canaryRatio ∈ (0, 1].
 *   effectiveCyclesToObserve = ceil(minCyclesToObserve / canaryRatio).
 *   Lower ratio = longer observation window = more conservative promotion decision.
 *   Default: 0.2 (20% → 5× the minimum observation period).
 *   Config key: canary.defaultRatio
 *
 * ## Experiment ID provenance (AC5)
 *   canaryId: "canary-<sha1-12>" stored in state/canary_ledger.json.
 *   experimentId: links to state/experiment_registry.json (may be null if no experiment is active).
 *   Both IDs are emitted in every audit log entry.
 */

import path from "node:path";
import fs   from "node:fs/promises";
import { warn } from "./logger.js";
import {
  CANARY_STATUS,
  CANARY_AUDIT_EVENT,
  buildCanaryId,
  loadLedger,
  saveLedger,
  appendAuditLog
} from "./canary_ledger.js";
import {
  DEFAULT_PROMOTION_THRESHOLDS,
  DEFAULT_ROLLBACK_THRESHOLDS,
  collectCanaryMetrics,
  evaluatePromotion,
  evaluateRollback,
  aggregateMetricSnapshots
} from "./canary_metrics.js";

// ── Default config ────────────────────────────────────────────────────────────

/**
 * Default canary configuration values.
 * All keys correspond to box.config.json#canary.* (AC3 / AC12 / AC13).
 */
export const CANARY_DEFAULTS = Object.freeze({
  enabled:           true,
  defaultRatio:      0.2,
  minCyclesToObserve: 2,
  promotion: DEFAULT_PROMOTION_THRESHOLDS,
  rollback:  DEFAULT_ROLLBACK_THRESHOLDS,
  auditLogPath: "state/canary_audit.jsonl",
  ledgerPath:   "state/canary_ledger.json"
});

// ── Config helpers ────────────────────────────────────────────────────────────

/**
 * Read canary config from box.config.json, applying CANARY_DEFAULTS for any missing key.
 *
 * @param {object} config - full runtime config (loadConfig() result)
 * @returns {object}
 */
export function getCanaryConfig(config) {
  const c = config?.canary || {};
  return {
    enabled:           typeof c.enabled           === "boolean" ? c.enabled           : CANARY_DEFAULTS.enabled,
    defaultRatio:      typeof c.defaultRatio       === "number"  ? c.defaultRatio       : CANARY_DEFAULTS.defaultRatio,
    minCyclesToObserve: typeof c.minCyclesToObserve === "number"  ? c.minCyclesToObserve : CANARY_DEFAULTS.minCyclesToObserve,
    promotion: {
      minTaskSuccessRate: typeof c.promotion?.minTaskSuccessRate === "number"
        ? c.promotion.minTaskSuccessRate
        : CANARY_DEFAULTS.promotion.minTaskSuccessRate,
      maxErrorRate: typeof c.promotion?.maxErrorRate === "number"
        ? c.promotion.maxErrorRate
        : CANARY_DEFAULTS.promotion.maxErrorRate
    },
    rollback: {
      triggerErrorRate: typeof c.rollback?.triggerErrorRate === "number"
        ? c.rollback.triggerErrorRate
        : CANARY_DEFAULTS.rollback.triggerErrorRate,
      triggerTaskSuccessRateLow: typeof c.rollback?.triggerTaskSuccessRateLow === "number"
        ? c.rollback.triggerTaskSuccessRateLow
        : CANARY_DEFAULTS.rollback.triggerTaskSuccessRateLow
    }
  };
}

// ── State machine operations ──────────────────────────────────────────────────

/**
 * Start a new canary experiment for a config path change.
 *
 * - Writes the canary value to box.config.json immediately (change goes live).
 * - Records the controlValue (old value) in the ledger as the rollback target (AC4).
 * - Emits a CANARY_STARTED audit event (AC1 / AC14).
 * - Returns the canaryId for downstream reference (AC5).
 *
 * Returns { ok: false, status: "CANARY_DISABLED" } when canary is disabled in config.
 * Returns { ok: false, status: "ALREADY_RUNNING", canaryId } when a canary for this
 * path is already running (prevents duplicate experiments).
 *
 * @param {object}  config        - full runtime config
 * @param {string}  configPath    - dot-notation config key (e.g. "runtime.workerTimeoutMinutes")
 * @param {unknown} controlValue  - current (old) value — rollback target
 * @param {unknown} canaryValue   - proposed new value
 * @param {string|null} [experimentId] - links to experiment_registry (may be null)
 * @returns {Promise<{ ok: boolean, canaryId?: string, status?: string, errors?: Array<object> }>}
 */
export async function startCanary(config, configPath, controlValue, canaryValue, experimentId = null) {
  const canaryConfig = getCanaryConfig(config);

  if (!canaryConfig.enabled) {
    return { ok: false, status: "CANARY_DISABLED" };
  }

  if (!configPath || typeof configPath !== "string") {
    return {
      ok: false,
      status: "INVALID_INPUT",
      errors: [{ field: "configPath", code: "MISSING_FIELD", message: "configPath is required" }]
    };
  }

  const stateDir = config.paths?.stateDir || "state";
  const ledger   = await loadLedger(stateDir);

  // Prevent duplicate running canaries for the same path
  const existing = (ledger.experiments || []).find(
    e => e.configPath === configPath && e.status === CANARY_STATUS.RUNNING
  );
  if (existing) {
    return { ok: false, status: "ALREADY_RUNNING", canaryId: existing.canaryId };
  }

  const now      = new Date().toISOString();
  const canaryId = buildCanaryId(configPath, canaryValue, now);
  const ratio    = canaryConfig.defaultRatio;

  // Write canary value to box.config.json so the running system observes it
  const applyResult = await _applyConfigValue(config, configPath, canaryValue);
  if (!applyResult.ok) {
    return {
      ok:     false,
      status: "CONFIG_WRITE_FAILED",
      errors: [{ field: configPath, code: "INVALID_VALUE", message: applyResult.error }]
    };
  }

  const entry = {
    canaryId,
    experimentId:    experimentId || null,
    configPath,
    controlValue,
    canaryValue,
    canaryRatio:     ratio,
    status:          CANARY_STATUS.RUNNING,
    statusReason:    null,
    metricSnapshots: [],
    createdAt:       now,
    promotedAt:      null,
    rolledBackAt:    null
  };

  ledger.experiments = ledger.experiments || [];
  ledger.experiments.push(entry);
  await saveLedger(stateDir, ledger);

  await appendAuditLog(stateDir, {
    event:        CANARY_AUDIT_EVENT.CANARY_STARTED,
    experimentId: experimentId || null,
    canaryId,
    timestamp:    now,
    configPath,
    canaryRatio:  ratio,
    metrics:      null,
    reason:       null
  });

  return { ok: true, canaryId };
}

/**
 * Record a metric snapshot for a running canary experiment.
 *
 * - Emits a CANARY_METRIC_SNAPSHOT audit event.
 * - After recording, calls evaluateAndAdvance to check for promotion/rollback.
 *
 * Returns { ok: false, status: "NOT_FOUND" } when canaryId does not exist.
 * Returns { ok: false, status: "NOT_RUNNING" } when canary is not in running state.
 *
 * @param {string} stateDir
 * @param {string} canaryId
 * @param {object} metrics   - result of collectCanaryMetrics()
 * @param {string} [cycleId] - opaque cycle identifier for provenance
 * @returns {Promise<{ ok: boolean, status?: string }>}
 */
export async function recordMetricSnapshot(stateDir, canaryId, metrics, cycleId = null) {
  const ledger = await loadLedger(stateDir);
  const idx    = (ledger.experiments || []).findIndex(e => e.canaryId === canaryId);

  if (idx === -1) {
    return { ok: false, status: "NOT_FOUND" };
  }

  const entry = ledger.experiments[idx];
  if (entry.status !== CANARY_STATUS.RUNNING) {
    return { ok: false, status: "NOT_RUNNING" };
  }

  const snapshot = {
    cycleId:   cycleId || `cycle-${Date.now()}`,
    timestamp: new Date().toISOString(),
    metrics
  };

  entry.metricSnapshots = entry.metricSnapshots || [];
  entry.metricSnapshots.push(snapshot);

  await saveLedger(stateDir, ledger);

  await appendAuditLog(stateDir, {
    event:        CANARY_AUDIT_EVENT.CANARY_METRIC_SNAPSHOT,
    experimentId: entry.experimentId,
    canaryId,
    timestamp:    snapshot.timestamp,
    configPath:   entry.configPath,
    canaryRatio:  entry.canaryRatio,
    metrics,
    reason:       null
  });

  return { ok: true, status: "SNAPSHOT_RECORDED" };
}

/**
 * Evaluate a running canary and advance its state if thresholds are met.
 *
 * Evaluation order (fast-fail first):
 *   1. Check rollback signals on the latest snapshot (immediate early exit).
 *   2. If effectiveCyclesToObserve not yet reached → continue observing.
 *   3. Evaluate aggregated promotion thresholds.
 *   4. If promotion → promoteCanary(); if not → rollbackCanary().
 *
 * effectiveCyclesToObserve = ceil(minCyclesToObserve / canaryRatio)
 *
 * Returns:
 *   { action: "rollback" | "promote" | "continue", reason: string }
 *
 * @param {object} config    - full runtime config
 * @param {string} canaryId
 * @returns {Promise<{ action: string, reason: string, ok: boolean }>}
 */
export async function evaluateAndAdvance(config, canaryId) {
  const canaryConfig = getCanaryConfig(config);
  const stateDir     = config.paths?.stateDir || "state";
  const ledger       = await loadLedger(stateDir);
  const entry        = (ledger.experiments || []).find(e => e.canaryId === canaryId);

  if (!entry) {
    return { ok: false, action: "error", reason: "CANARY_NOT_FOUND" };
  }
  if (entry.status !== CANARY_STATUS.RUNNING) {
    return { ok: false, action: "error", reason: `CANARY_NOT_RUNNING:status=${entry.status}` };
  }

  const snapshots = entry.metricSnapshots || [];
  if (snapshots.length === 0) {
    return { ok: true, action: "continue", reason: "NO_SNAPSHOTS_YET" };
  }

  // Fast-fail: check rollback signals on the latest snapshot
  const latestMetrics = snapshots[snapshots.length - 1].metrics;
  const rollbackCheck = evaluateRollback(latestMetrics, canaryConfig.rollback);
  if (rollbackCheck.rollback) {
    await rollbackCanary(config, canaryId, rollbackCheck.reason);
    return { ok: true, action: "rollback", reason: rollbackCheck.reason };
  }

  // Check if we've reached the effective observation window
  const effectiveCycles = Math.ceil(canaryConfig.minCyclesToObserve / (entry.canaryRatio || canaryConfig.defaultRatio));
  if (snapshots.length < effectiveCycles) {
    const remaining = effectiveCycles - snapshots.length;
    return { ok: true, action: "continue", reason: `AWAITING_OBSERVATIONS:need=${remaining}more` };
  }

  // Evaluate aggregated metrics against promotion thresholds
  const aggregated     = aggregateMetricSnapshots(snapshots.map(s => s.metrics));
  const promotionCheck = evaluatePromotion(aggregated, canaryConfig.promotion);

  if (promotionCheck.promote) {
    await promoteCanary(config, canaryId, promotionCheck.reason);
    return { ok: true, action: "promote", reason: promotionCheck.reason };
  }

  // Not enough quality — rollback
  await rollbackCanary(config, canaryId, promotionCheck.reason);
  return { ok: true, action: "rollback", reason: promotionCheck.reason };
}

/**
 * Promote a running canary experiment.
 *
 * The canary value is already in box.config.json. This operation:
 *   - Marks the ledger entry as "promoted".
 *   - Emits a CANARY_PROMOTED audit event.
 *
 * @param {object} config
 * @param {string} canaryId
 * @param {string} [reason]
 * @returns {Promise<{ ok: boolean, status?: string }>}
 */
export async function promoteCanary(config, canaryId, reason = "PROMOTED") {
  const stateDir = config.paths?.stateDir || "state";
  const ledger   = await loadLedger(stateDir);
  const idx      = (ledger.experiments || []).findIndex(e => e.canaryId === canaryId);

  if (idx === -1) return { ok: false, status: "NOT_FOUND" };

  const entry = ledger.experiments[idx];
  if (entry.status !== CANARY_STATUS.RUNNING) {
    return { ok: false, status: `NOT_RUNNING:current=${entry.status}` };
  }

  const now = new Date().toISOString();
  ledger.experiments[idx] = {
    ...entry,
    status:       CANARY_STATUS.PROMOTED,
    statusReason: reason,
    promotedAt:   now
  };

  await saveLedger(stateDir, ledger);

  await appendAuditLog(stateDir, {
    event:        CANARY_AUDIT_EVENT.CANARY_PROMOTED,
    experimentId: entry.experimentId,
    canaryId,
    timestamp:    now,
    configPath:   entry.configPath,
    canaryRatio:  entry.canaryRatio,
    metrics:      null,
    reason
  });

  return { ok: true, status: "PROMOTED" };
}

/**
 * Roll back a running canary experiment.
 *
 * Rollback target state (AC4 / AC13):
 *   Writes entry.controlValue back to box.config.json at entry.configPath.
 *
 * Also:
 *   - Marks the ledger entry as "rolled_back".
 *   - Emits a CANARY_ROLLED_BACK audit event.
 *
 * Returns { ok: false, status: "CONFIG_REVERT_FAILED" } if the config write fails.
 * In that case, the ledger entry is still updated to "rolled_back" with an explicit
 * statusReason so the failure is machine-observable. (AC10)
 *
 * @param {object} config
 * @param {string} canaryId
 * @param {string} [reason]
 * @returns {Promise<{ ok: boolean, status?: string }>}
 */
export async function rollbackCanary(config, canaryId, reason = "ROLLBACK") {
  const stateDir = config.paths?.stateDir || "state";
  const ledger   = await loadLedger(stateDir);
  const idx      = (ledger.experiments || []).findIndex(e => e.canaryId === canaryId);

  if (idx === -1) return { ok: false, status: "NOT_FOUND" };

  const entry = ledger.experiments[idx];
  if (entry.status !== CANARY_STATUS.RUNNING) {
    return { ok: false, status: `NOT_RUNNING:current=${entry.status}` };
  }

  const now = new Date().toISOString();

  // Revert box.config.json to the control (old) value — rollback target (AC4)
  const revertResult = await _applyConfigValue(config, entry.configPath, entry.controlValue);
  const finalReason  = revertResult.ok
    ? reason
    : `${reason}|CONFIG_REVERT_FAILED:${revertResult.error}`;

  ledger.experiments[idx] = {
    ...entry,
    status:       CANARY_STATUS.ROLLED_BACK,
    statusReason: finalReason,
    rolledBackAt: now
  };

  await saveLedger(stateDir, ledger);

  await appendAuditLog(stateDir, {
    event:        CANARY_AUDIT_EVENT.CANARY_ROLLED_BACK,
    experimentId: entry.experimentId,
    canaryId,
    timestamp:    now,
    configPath:   entry.configPath,
    canaryRatio:  entry.canaryRatio,
    metrics:      null,
    reason:       finalReason
  });

  if (!revertResult.ok) {
    warn(`[canary-engine] rollback config write failed for ${entry.configPath}: ${revertResult.error}`);
    return { ok: false, status: "CONFIG_REVERT_FAILED" };
  }

  return { ok: true, status: "ROLLED_BACK" };
}

// ── Cycle-level processing ────────────────────────────────────────────────────

/**
 * Process all running canary experiments for the current self-improvement cycle.
 *
 * For each running canary:
 *   1. Collect metrics from cycle outcomes.
 *   2. Record a metric snapshot.
 *   3. Evaluate and advance state (rollback / promote / continue).
 *
 * This is the main entry point called from runSelfImprovementCycle().
 *
 * @param {object} config   - full runtime config
 * @param {object} outcomes - result from collectCycleOutcomes()
 * @param {string} [cycleId]
 * @returns {Promise<Array<{ canaryId: string, action: string, reason: string }>>}
 */
export async function processRunningCanaries(config, outcomes, cycleId = null) {
  const canaryConfig = getCanaryConfig(config);
  if (!canaryConfig.enabled) return [];

  const stateDir = config.paths?.stateDir || "state";
  const ledger   = await loadLedger(stateDir);
  const running  = (ledger.experiments || []).filter(e => e.status === CANARY_STATUS.RUNNING);

  if (running.length === 0) return [];

  const metrics = collectCanaryMetrics(outcomes);
  const results = [];

  for (const entry of running) {
    try {
      await recordMetricSnapshot(stateDir, entry.canaryId, metrics, cycleId);
      const evaluation = await evaluateAndAdvance(config, entry.canaryId);
      results.push({ canaryId: entry.canaryId, action: evaluation.action, reason: evaluation.reason });
    } catch (err) {
      // Failure in canary processing must not crash the main self-improvement cycle.
      // Record an explicit failed status so the issue is machine-observable. (AC10)
      warn(`[canary-engine] processRunningCanaries error for ${entry.canaryId}: ${String(err?.message || err)}`);
      results.push({
        canaryId: entry.canaryId,
        action:   "error",
        reason:   `PROCESSING_ERROR:${String(err?.message || err).slice(0, 200)}`
      });
    }
  }

  return results;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Write a config value to box.config.json at the given dot-notation path.
 * Returns { ok: boolean, error?: string }.
 *
 * @param {object}  config
 * @param {string}  configPath
 * @param {unknown} value
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function _applyConfigValue(config, configPath, value) {
  const boxConfigPath = path.join(config.rootDir || ".", "box.config.json");

  let boxConfig;
  try {
    const raw = await fs.readFile(boxConfigPath, "utf8");
    boxConfig  = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `READ_FAILED:${err.code || err.message}` };
  }

  const keys   = String(configPath).split(".");
  let   target = boxConfig;

  for (let i = 0; i < keys.length - 1; i++) {
    if (target && typeof target === "object" && keys[i] in target) {
      target = target[keys[i]];
    } else {
      return { ok: false, error: `PATH_NOT_FOUND:${keys.slice(0, i + 1).join(".")}` };
    }
  }

  if (!target || typeof target !== "object") {
    return { ok: false, error: `PARENT_NOT_OBJECT:${configPath}` };
  }

  const lastKey     = keys[keys.length - 1];
  target[lastKey]   = value;

  try {
    await fs.writeFile(boxConfigPath, JSON.stringify(boxConfig, null, 2) + "\n", "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `WRITE_FAILED:${err.message}` };
  }
}
