/**
 * BOX Cycle-level SLO Checker
 *
 * Computes, evaluates, and persists Service Level Objective (SLO) metrics
 * for each completed orchestration cycle.
 *
 * cycle_id contract (Athena missing item resolved):
 *   pipeline_progress.startedAt is the canonical cycle identifier.
 *   It is an ISO 8601 timestamp written when the first non-idle stage begins.
 *
 * SLO input field contract (Athena missing item resolved):
 *   All latency timestamps are read from pipeline_progress.json.stageTimestamps.
 *   - Decision latency:          janus_awakening → janus_decided
 *   - Dispatch latency:          athena_approved → workers_dispatching
 *   - Verification completion:   workers_dispatching → cycle_complete
 *   Timestamps from janus_directive.json are NOT used — stageTimestamps is
 *   the single authoritative source to eliminate field ambiguity.
 *
 * slo_metrics.json schema (Athena missing item resolved — see SLO_METRICS_SCHEMA):
 *   Required fields, enums, and cycle key are fully specified below.
 *
 * Dashboard degraded path (Athena missing item resolved):
 *   A breach writes orchestratorStatus=degraded via writeOrchestratorHealth (orchestrator.js),
 *   NOT via appendAlert alone. The orchestrator calls writeOrchestratorHealth explicitly.
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";

// ── Enums ─────────────────────────────────────────────────────────────────────

/** SLO metric identifiers. */
export const SLO_METRIC = Object.freeze({
  DECISION_LATENCY: "decisionLatencyMs",
  DISPATCH_LATENCY: "dispatchLatencyMs",
  VERIFICATION_COMPLETION: "verificationCompletionMs",
  // Sub-metrics that split VERIFICATION_COMPLETION for finer latency attribution.
  // workerExecutionMs + verificationGateMs = verificationCompletionMs (backward-compat aggregate).
  // replayEvidenceMs is measured after cycle_complete and patched in via patchSloMetricsReplayEvidence.
  WORKER_EXECUTION: "workerExecutionMs",
  VERIFICATION_GATE: "verificationGateMs",
  REPLAY_EVIDENCE: "replayEvidenceMs",
});

/** SLO health status written to slo_metrics.json. */
export const SLO_STATUS = Object.freeze({
  OK: "ok",
  DEGRADED: "degraded",
});

/**
 * Machine-readable statusReason codes.
 * Never use free-form strings for SLO status reasons.
 */
export const SLO_REASON = Object.freeze({
  OK: "OK",
  BREACH_DETECTED: "BREACH_DETECTED",
  MISSING_TIMESTAMPS: "MISSING_TIMESTAMPS",
});

/**
 * Reason codes for individual missing timestamp cases.
 * Distinguishes missing-input from invalid-input (AC9).
 */
export const SLO_MISSING_REASON = Object.freeze({
  MISSING_TIMESTAMP_DECISION: "MISSING_TIMESTAMP_DECISION",
  MISSING_TIMESTAMP_DISPATCH: "MISSING_TIMESTAMP_DISPATCH",
  MISSING_TIMESTAMP_VERIFICATION: "MISSING_TIMESTAMP_VERIFICATION",
  // Sub-metric missing reasons — do not affect SLO breach/status logic.
  MISSING_TIMESTAMP_WORKER_EXECUTION: "MISSING_TIMESTAMP_WORKER_EXECUTION",
  MISSING_TIMESTAMP_VERIFICATION_GATE: "MISSING_TIMESTAMP_VERIFICATION_GATE",
});

/**
 * Reason codes for threshold validation errors (AC1, AC9, AC10).
 * THRESHOLD_MISSING: key absent from the configured slo.thresholds object.
 * THRESHOLD_INVALID: key present but value is not a positive finite number.
 * Neither case is a silent fallback — both are recorded in thresholdValidationErrors.
 */
export const SLO_THRESHOLD_REASON = Object.freeze({
  THRESHOLD_MISSING: "THRESHOLD_MISSING",
  THRESHOLD_INVALID: "THRESHOLD_INVALID",
});

/** Breach alert severity levels. Aligns with ALERT_SEVERITY in state_tracker.js. */
export const SLO_BREACH_SEVERITY = Object.freeze({
  HIGH: "high",
  CRITICAL: "critical",
});

// ── Field contract ────────────────────────────────────────────────────────────

/**
 * Defines which stageTimestamps fields are required for each SLO metric.
 * Source for all timestamps: pipeline_progress.json.stageTimestamps.
 * This is the authoritative field contract (Athena AC12 resolved).
 */
export const SLO_TIMESTAMP_CONTRACT = Object.freeze({
  [SLO_METRIC.DECISION_LATENCY]: Object.freeze({
    start: "janus_awakening",
    end: "janus_decided",
    missingReason: SLO_MISSING_REASON.MISSING_TIMESTAMP_DECISION,
  }),
  [SLO_METRIC.DISPATCH_LATENCY]: Object.freeze({
    start: "athena_approved",
    end: "workers_dispatching",
    missingReason: SLO_MISSING_REASON.MISSING_TIMESTAMP_DISPATCH,
  }),
  [SLO_METRIC.VERIFICATION_COMPLETION]: Object.freeze({
    start: "workers_dispatching",
    end: "cycle_complete",
    missingReason: SLO_MISSING_REASON.MISSING_TIMESTAMP_VERIFICATION,
  }),
});

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * Canonical schema for slo_metrics.json (Athena AC13 resolved).
 * Required fields, enums, and cycle key are fully specified.
 *
 * cycleId = pipeline_progress.startedAt (ISO 8601 string).
 */
export const SLO_METRICS_SCHEMA = Object.freeze({
  schemaVersion: 1,
  required: ["schemaVersion", "lastCycle", "history", "updatedAt"],
  cycleRecord: Object.freeze({
    required: [
      "cycleId",
      "startedAt",
      "completedAt",
      "metrics",
      "missingTimestamps",
      "thresholdValidationErrors",
      "sloBreaches",
      "status",
      "statusReason",
    ],
    /** cycleId is pipeline_progress.startedAt — the canonical cycle identifier. */
    cycleIdSource: "pipeline_progress.startedAt",
    statusEnum: Object.freeze([...Object.values(SLO_STATUS)]),
    statusReasonEnum: Object.freeze([...Object.values(SLO_REASON)]),
    metricNames: Object.freeze([...Object.values(SLO_METRIC)]),
    breachSeverityEnum: Object.freeze([...Object.values(SLO_BREACH_SEVERITY)]),
    missingReasonEnum: Object.freeze([...Object.values(SLO_MISSING_REASON)]),
    thresholdReasonEnum: Object.freeze([...Object.values(SLO_THRESHOLD_REASON)]),
  }),
  maxHistoryEntries: 100,
});

// ── Default thresholds ────────────────────────────────────────────────────────

/** Primary SLO metrics that have configurable thresholds and can trigger breaches. */
const PRIMARY_SLO_METRICS = Object.freeze([
  SLO_METRIC.DECISION_LATENCY,
  SLO_METRIC.DISPATCH_LATENCY,
  SLO_METRIC.VERIFICATION_COMPLETION,
]);

const DEFAULT_THRESHOLDS = Object.freeze({
  [SLO_METRIC.DECISION_LATENCY]: 120000,       // 2 min
  [SLO_METRIC.DISPATCH_LATENCY]: 30000,         // 30 s
  [SLO_METRIC.VERIFICATION_COMPLETION]: 3600000, // 1 hr
});

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Validate config-driven thresholds and return explicit validation errors (AC1, AC9, AC10).
 *
 * Rules:
 *   - If config.slo.thresholds is absent/null → use all defaults, no errors (expected first-run).
 *   - If config.slo.thresholds is an object and a key is absent → THRESHOLD_MISSING (explicit).
 *   - If a value is present but not a positive finite number → THRESHOLD_INVALID (explicit).
 * Neither case is silent: validation errors are returned and persisted in the cycle record.
 *
 * Only PRIMARY_SLO_METRICS are threshold-validated.
 * Sub-metrics (workerExecutionMs, verificationGateMs, replayEvidenceMs) are observational
 * only and have no configurable thresholds.
 *
 * @param {object} config
 * @returns {{ thresholds: object, validationErrors: Array }}
 */
function resolveThresholds(config) {
  const configured = config?.slo?.thresholds;
  const validationErrors = [];
  const thresholds: Record<string, any> = {};

  for (const metric of PRIMARY_SLO_METRICS) {
    const fallback = DEFAULT_THRESHOLDS[metric];

    if (!configured || typeof configured !== "object") {
      // No thresholds object configured — use defaults without emitting errors (first-run expected).
      thresholds[metric] = fallback;
      continue;
    }

    if (!(metric in configured)) {
      // Key absent from an explicitly provided thresholds object — record explicitly (AC10).
      validationErrors.push({
        metric,
        reason: SLO_THRESHOLD_REASON.THRESHOLD_MISSING,
        configured: undefined,
        fallback,
      });
      thresholds[metric] = fallback;
      continue;
    }

    const raw = configured[metric];
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      // Value present but invalid — never silently coerce; record reason (AC9, AC10).
      validationErrors.push({
        metric,
        reason: SLO_THRESHOLD_REASON.THRESHOLD_INVALID,
        configured: raw,
        fallback,
      });
      thresholds[metric] = fallback;
    } else {
      thresholds[metric] = value;
    }
  }

  return { thresholds, validationErrors };
}

function resolveBreachSeverity(config, metric, actual, threshold) {
  const configured = String(config?.slo?.breachSeverity?.[metric] || "").toLowerCase();
  if (configured === SLO_BREACH_SEVERITY.CRITICAL) return SLO_BREACH_SEVERITY.CRITICAL;
  if (configured === SLO_BREACH_SEVERITY.HIGH) return SLO_BREACH_SEVERITY.HIGH;
  // Auto-escalate to critical when actual exceeds 2× threshold
  return actual > threshold * 2 ? SLO_BREACH_SEVERITY.CRITICAL : SLO_BREACH_SEVERITY.HIGH;
}

/**
 * Validate and parse a raw timestamp string.
 * Distinguishes missing input from invalid input (AC9).
 *
 * @param {any} raw
 * @returns {{ ms: number, valid: true } | { valid: false, reason: "missing"|"invalid" }}
 */
function parseTimestamp(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { valid: false, reason: "missing" };
  }
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) {
    return { valid: false, reason: "invalid" };
  }
  return { valid: true, ms };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute SLO metrics for a completed cycle.
 *
 * This is a pure function — it reads no files and performs no I/O.
 * Call this after `cycle_complete` to evaluate latencies against thresholds.
 *
 * @param {object} config         - BOX config (used for slo.thresholds, slo.enabled)
 * @param {object} stageTimestamps - pipeline_progress.json.stageTimestamps
 * @param {string|null} startedAt  - pipeline_progress.json.startedAt (= cycleId)
 * @param {string|null} completedAt - pipeline_progress.json.completedAt
 * @param {object} [opts]         - Optional parameters
 * @param {number|null} [opts.replayEvidenceMs] - Time spent collecting replay evidence (post-cycle_complete).
 *                                                Measured externally and patched via patchSloMetricsReplayEvidence.
 * @returns {object} cycleRecord conforming to SLO_METRICS_SCHEMA.cycleRecord
 */
export function computeCycleSLOs(config, stageTimestamps, startedAt, completedAt, opts: { replayEvidenceMs?: number | null } = {}) {
  const sloEnabled = config?.slo?.enabled !== false;
  const timestamps = stageTimestamps && typeof stageTimestamps === "object" ? stageTimestamps : {};
  const { thresholds, validationErrors: thresholdValidationErrors } = resolveThresholds(config);

  const metrics = {
    [SLO_METRIC.DECISION_LATENCY]: null,
    [SLO_METRIC.DISPATCH_LATENCY]: null,
    [SLO_METRIC.VERIFICATION_COMPLETION]: null,
    // Sub-metrics — no breach checking; observability only.
    [SLO_METRIC.WORKER_EXECUTION]: null,
    [SLO_METRIC.VERIFICATION_GATE]: null,
    [SLO_METRIC.REPLAY_EVIDENCE]: null,
  };
  const missingTimestamps = [];
  const sloBreaches = [];

  if (sloEnabled) {
    for (const [metric, contract] of Object.entries(SLO_TIMESTAMP_CONTRACT)) {
      const startResult = parseTimestamp(timestamps[contract.start]);
      const endResult = parseTimestamp(timestamps[contract.end]);

      if (!startResult.valid || !endResult.valid) {
        missingTimestamps.push(contract.missingReason);
        // No SLO calculation on missing mandatory timestamps (AC5)
        continue;
      }

      const latencyMs = endResult.ms - startResult.ms;
      // Clamp to 0 — negative latency (clock skew) is treated as 0
      metrics[metric] = Math.max(0, latencyMs);

      const threshold = thresholds[metric];
      if (metrics[metric] > threshold) {
        sloBreaches.push({
          metric,
          threshold,
          actual: metrics[metric],
          severity: resolveBreachSeverity(config, metric, metrics[metric], threshold),
          reason: `${metric.toUpperCase().replace(/MS$/, "")}_BREACH`,
        });
      }
    }
  }

  const hasBreach = sloBreaches.length > 0;
  const hasMissing = missingTimestamps.length > 0;

  let status, statusReason;
  if (hasBreach && config?.slo?.degradedOnBreach !== false) {
    status = SLO_STATUS.DEGRADED;
    statusReason = SLO_REASON.BREACH_DETECTED;
  } else if (!sloEnabled || (!hasBreach && !hasMissing)) {
    status = SLO_STATUS.OK;
    statusReason = SLO_REASON.OK;
  } else if (hasMissing && !hasBreach) {
    status = SLO_STATUS.OK;
    statusReason = SLO_REASON.MISSING_TIMESTAMPS;
  } else {
    status = SLO_STATUS.OK;
    statusReason = SLO_REASON.OK;
  }

  // ── Sub-metrics: split verificationCompletionMs for finer latency attribution ──
  // These are observational only — they do not trigger breaches or affect SLO status.
  // workerExecutionMs + verificationGateMs ≈ verificationCompletionMs (the aggregate).
  // replayEvidenceMs covers post-cycle_complete replay evidence collection time.
  const workerExecutionStart = parseTimestamp(timestamps["workers_dispatching"]);
  const workerExecutionEnd   = parseTimestamp(timestamps["workers_finishing"]);
  const verificationGateEnd  = parseTimestamp(timestamps["cycle_complete"]);

  if (workerExecutionStart.valid && workerExecutionEnd.valid) {
    metrics[SLO_METRIC.WORKER_EXECUTION] = Math.max(0, workerExecutionEnd.ms - workerExecutionStart.ms);
  }
  if (workerExecutionEnd.valid && verificationGateEnd.valid) {
    metrics[SLO_METRIC.VERIFICATION_GATE] = Math.max(0, verificationGateEnd.ms - workerExecutionEnd.ms);
  }
  const _replayMs = opts?.replayEvidenceMs;
  if (typeof _replayMs === "number" && Number.isFinite(_replayMs) && _replayMs >= 0) {
    metrics[SLO_METRIC.REPLAY_EVIDENCE] = Math.round(_replayMs);
  }

  return {
    cycleId: startedAt || null,
    startedAt: startedAt || null,
    completedAt: completedAt || null,
    metrics,
    missingTimestamps,
    thresholdValidationErrors,
    sloBreaches,
    status,
    statusReason,
  };
}

function sloMetricsPath(config) {
  const stateDir = config?.paths?.stateDir || "state";
  return path.join(stateDir, "slo_metrics.json");
}

/**
 * Persist a computed cycle SLO record to slo_metrics.json.
 * Maintains a rolling history of up to SLO_METRICS_SCHEMA.maxHistoryEntries cycles.
 *
 * @param {object} config
 * @param {object} cycleRecord - output of computeCycleSLOs()
 */
export async function persistSloMetrics(config, cycleRecord) {
  const filePath = sloMetricsPath(config);
  const existing = await readJson(filePath, {
    schemaVersion: SLO_METRICS_SCHEMA.schemaVersion,
    lastCycle: null,
    history: [],
    updatedAt: null,
  });

  const history = Array.isArray(existing.history) ? existing.history : [];
  history.unshift(cycleRecord);
  if (history.length > SLO_METRICS_SCHEMA.maxHistoryEntries) {
    history.length = SLO_METRICS_SCHEMA.maxHistoryEntries;
  }

  await writeJson(filePath, {
    schemaVersion: SLO_METRICS_SCHEMA.schemaVersion,
    lastCycle: cycleRecord,
    history,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Patch the most-recent SLO cycle record with a measured replayEvidenceMs value.
 *
 * Call this after the replay evidence collection completes (post-cycle_complete).
 * Updates both lastCycle and the leading history entry atomically so downstream
 * analytics readers see a consistent replayEvidenceMs without re-running the full
 * SLO computation.
 *
 * @param {object} config
 * @param {number} replayEvidenceMs - measured elapsed ms for replay evidence collection
 */
export async function patchSloMetricsReplayEvidence(config: any, replayEvidenceMs: number): Promise<void> {
  if (!Number.isFinite(replayEvidenceMs) || replayEvidenceMs < 0) return;
  const filePath = sloMetricsPath(config);
  try {
    const existing = await readJson(filePath, null);
    if (!existing || typeof existing !== "object") return;
    const lastCycle = (existing as Record<string, unknown>).lastCycle;
    if (!lastCycle || typeof lastCycle !== "object") return;

    const patchedValue = Math.round(replayEvidenceMs);
    const patchMetrics = (record: Record<string, unknown>): Record<string, unknown> => ({
      ...record,
      metrics: {
        ...((record.metrics && typeof record.metrics === "object") ? record.metrics as Record<string, unknown> : {}),
        [SLO_METRIC.REPLAY_EVIDENCE]: patchedValue,
      },
    });

    const updatedLastCycle = patchMetrics(lastCycle as Record<string, unknown>);
    const history = Array.isArray((existing as Record<string, unknown>).history)
      ? [...(existing as Record<string, unknown>).history as unknown[]]
      : [];
    if (history.length > 0 && history[0] && typeof history[0] === "object") {
      history[0] = patchMetrics(history[0] as Record<string, unknown>);
    }

    await writeJson(filePath, {
      ...(existing as Record<string, unknown>),
      lastCycle: updatedLastCycle,
      history,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // patch is advisory — never block orchestration
  }
}

/**
 * Read the most recent SLO metrics from slo_metrics.json.
 * Returns null for lastCycle and empty history if the file does not exist.
 *
 * @param {object} config
 * @returns {object}
 */
export async function readSloMetrics(config) {
  return readJson(sloMetricsPath(config), {
    schemaVersion: SLO_METRICS_SCHEMA.schemaVersion,
    lastCycle: null,
    history: [],
    updatedAt: null,
  });
}

// ── Coupled alert detection ───────────────────────────────────────────────────

/**
 * Coupled alert type codes.
 * A coupled alert fires when two correlated failure signals are active simultaneously.
 */
export const COUPLED_ALERT_TYPE = Object.freeze({
  /**
   * Fires when verificationCompletionMs has an active SLO breach AND completion
   * yield (funnel.completionRate) collapses below the configured threshold in the
   * same cycle.  Both signals together indicate a systemic pipeline degradation —
   * jobs take too long AND fewer complete successfully.
   */
  YIELD_COLLAPSE_WITH_VERIFICATION_BREACH: "YIELD_COLLAPSE_WITH_VERIFICATION_BREACH",
});

/** Default completion yield threshold (0–1). Yield below this value is treated as collapsed. */
export const COUPLED_ALERT_DEFAULT_YIELD_THRESHOLD = 0.5;

/**
 * @typedef {object} CoupledAlert
 * @property {string} type                          - COUPLED_ALERT_TYPE value
 * @property {number} verificationBreachActualMs    - Actual verificationCompletionMs from the breach
 * @property {number} verificationBreachThresholdMs - Threshold that was exceeded
 * @property {string} verificationBreachSeverity    - SLO breach severity (SLO_BREACH_SEVERITY)
 * @property {number} completionYield               - Funnel completionRate at the time of alert
 * @property {number} yieldCollapseThreshold        - Threshold used for yield-collapse detection
 * @property {string|null} cycleId                  - Cycle identifier from sloRecord
 */

/**
 * Detect coupled alerts for the current cycle.
 *
 * Fires YIELD_COLLAPSE_WITH_VERIFICATION_BREACH when:
 *   1. sloRecord contains an active SLO breach for verificationCompletionMs, AND
 *   2. completionYield is below the configured yieldCollapseThreshold.
 *
 * Pure function — no file I/O.
 *
 * @param {object|null} sloRecord       - Output of computeCycleSLOs(). May be null.
 * @param {number|null} completionYield - funnel.completionRate (0–1) from computeCycleAnalytics(). May be null.
 * @param {object}      opts
 * @param {number}      [opts.yieldCollapseThreshold] - Collapse threshold (default: COUPLED_ALERT_DEFAULT_YIELD_THRESHOLD)
 * @returns {CoupledAlert[]}
 */
export function detectCoupledAlerts(
  sloRecord: any,
  completionYield: number | null,
  opts: { yieldCollapseThreshold?: number } = {},
): any[] {
  if (!sloRecord || typeof sloRecord !== "object") return [];

  const breaches: any[] = Array.isArray(sloRecord.sloBreaches) ? sloRecord.sloBreaches : [];
  const verificationBreach = breaches.find(b => b?.metric === SLO_METRIC.VERIFICATION_COMPLETION);
  if (!verificationBreach) return [];

  const yieldValue = (typeof completionYield === "number" && Number.isFinite(completionYield))
    ? completionYield
    : null;
  if (yieldValue === null) return [];

  const threshold = (typeof opts?.yieldCollapseThreshold === "number" && Number.isFinite(opts.yieldCollapseThreshold))
    ? opts.yieldCollapseThreshold
    : COUPLED_ALERT_DEFAULT_YIELD_THRESHOLD;

  if (yieldValue >= threshold) return [];

  return [{
    type: COUPLED_ALERT_TYPE.YIELD_COLLAPSE_WITH_VERIFICATION_BREACH,
    verificationBreachActualMs: verificationBreach.actual,
    verificationBreachThresholdMs: verificationBreach.threshold,
    verificationBreachSeverity: verificationBreach.severity,
    completionYield: yieldValue,
    yieldCollapseThreshold: threshold,
    cycleId: sloRecord.cycleId ?? null,
  }];
}

// ── Sustained breach detection ────────────────────────────────────────────────

/** Default configuration for sustained breach signature detection. */
export const SLO_SUSTAINED_BREACH_DEFAULTS = Object.freeze({
  minConsecutiveBreaches: 3,
});

/**
 * A sustained breach signature produced when one SLO metric has breached
 * in at least minConsecutiveBreaches consecutive cycles (most-recent-first).
 *
 * @typedef {object} SustainedBreachSignature
 * @property {string}   metric               - SLO metric identifier (SLO_METRIC value)
 * @property {number}   consecutiveBreaches  - How many consecutive leading cycles breached
 * @property {string[]} affectedCycleIds     - Provenance: cycleId of each contributing cycle
 * @property {number}   averageExcessMs      - Mean excess above threshold across contributing cycles
 * @property {number}   maxExcessMs          - Worst-case excess above threshold
 * @property {string}   severity             - Highest severity seen across the run (SLO_BREACH_SEVERITY)
 */

/**
 * Detect sustained SLO breach signatures from a history array.
 *
 * A signature is produced for each metric that has breached in the most-recent
 * consecutive N cycles where N >= minConsecutiveBreaches.  History is expected
 * most-recent-first (as returned by readSloMetrics().history).
 *
 * Pure function — performs no file I/O.
 *
 * @param {object[]} history - SLO cycle records (most-recent-first)
 * @param {object}   opts
 * @param {number}   [opts.minConsecutiveBreaches=3] - consecutive breach threshold
 * @returns {SustainedBreachSignature[]}
 */
export function detectSustainedBreachSignatures(history, opts: { minConsecutiveBreaches?: number } = {}): any[] {
  const min = Number(
    opts?.minConsecutiveBreaches ?? SLO_SUSTAINED_BREACH_DEFAULTS.minConsecutiveBreaches
  );
  if (!Array.isArray(history) || history.length === 0) return [];
  if (!Number.isFinite(min) || min < 1) return [];

  const metrics = Object.values(SLO_METRIC);

  // Per-metric accumulator: only consecutive from the start of history
  const acc: Record<string, {
    done: boolean;
    count: number;
    cycleIds: string[];
    excesses: number[];
    maxSeverity: string;
  }> = {};

  for (const m of metrics) {
    acc[m] = {
      done: false,
      count: 0,
      cycleIds: [],
      excesses: [],
      maxSeverity: SLO_BREACH_SEVERITY.HIGH,
    };
  }

  for (const record of history) {
    const breaches: any[] = Array.isArray(record?.sloBreaches) ? record.sloBreaches : [];
    const byMetric = new Map<string, any>();
    for (const b of breaches) {
      if (typeof b?.metric === "string") byMetric.set(b.metric, b);
    }

    for (const m of metrics) {
      const state = acc[m];
      if (state.done) continue; // streak already broken for this metric

      if (byMetric.has(m)) {
        const breach = byMetric.get(m);
        state.count++;
        const id = record?.cycleId ?? record?.startedAt ?? null;
        if (id != null) state.cycleIds.push(String(id));
        const excess =
          typeof breach.actual === "number" && typeof breach.threshold === "number"
            ? Math.max(0, breach.actual - breach.threshold)
            : 0;
        state.excesses.push(excess);
        if (breach.severity === SLO_BREACH_SEVERITY.CRITICAL) {
          state.maxSeverity = SLO_BREACH_SEVERITY.CRITICAL;
        }
      } else {
        // No breach for this metric in this cycle — consecutive streak broken
        state.done = true;
      }
    }
  }

  const signatures: any[] = [];
  for (const m of metrics) {
    const state = acc[m];
    if (state.count >= min) {
      const totalExcess = state.excesses.reduce((s, v) => s + v, 0);
      const avgExcess = state.excesses.length > 0
        ? Math.round(totalExcess / state.excesses.length)
        : 0;
      const maxExcess = state.excesses.length > 0
        ? Math.max(...state.excesses)
        : 0;
      signatures.push({
        metric: m,
        consecutiveBreaches: state.count,
        affectedCycleIds: state.cycleIds,
        averageExcessMs: avgExcess,
        maxExcessMs: maxExcess,
        severity: state.maxSeverity,
      });
    }
  }

  return signatures;
}

