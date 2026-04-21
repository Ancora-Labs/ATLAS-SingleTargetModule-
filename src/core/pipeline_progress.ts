/**
 * Pipeline Progress Tracker
 *
 * Writes state/pipeline_progress.json at every major stage of the
 * Janus → Prometheus → Athena → Workers pipeline so the dashboard can
 * render a real-time progress bar with human-readable descriptions.
 *
 * Schema contract (pipeline_progress.json):
 * {
 *   stage:       string  — one of PIPELINE_STAGE_ENUM values
 *   stageLabel:  string  — human-readable label for the stage
 *   percent:     number  — 0–100 inclusive
 *   detail:      string  — current detail text
 *   steps:       Array<{ id: string, label: string, pct: number, status: "done"|"active"|"pending" }>
 *   updatedAt:   string  — ISO 8601 timestamp of last update
 *   startedAt:   string|null — ISO 8601 timestamp when cycle started; null when idle
 *   completedAt: string|undefined — ISO 8601 timestamp; present only on cycle_complete
 * }
 */

import path from "node:path";
import { writeJson, readJson } from "./fs_utils.js";

/**
 * Explicit enumeration of all valid stage IDs.
 * Covers every step of the Janus → Prometheus → Athena → Workers pipeline.
 */
export const PIPELINE_STAGE_ENUM = Object.freeze([
  "idle",
  "janus_awakening",
  "janus_reading",
  "janus_thinking",
  "janus_decided",
  "prometheus_starting",
  "prometheus_reading_repo",
  "prometheus_analyzing",
  "prometheus_audit",
  "prometheus_done",
  "athena_reviewing",
  "athena_approved",
  "workers_dispatching",
  "workers_running",
  "workers_finishing",
  "cycle_complete",
]);

/** Reason codes for updatePipelineProgress validation errors. */
export const PROGRESS_ERROR_CODE = Object.freeze({
  MISSING_STEP_ID: "MISSING_STEP_ID",
  INVALID_STEP_ID: "INVALID_STEP_ID",
});

export const PIPELINE_SEGMENT_HISTORY_MAX = 20;

/** Ordered pipeline steps with weight-based percentages. */
const STEPS = [
  { id: "idle",                    label: "Idle",                               pct: 0   },
  { id: "janus_awakening",         label: "Janus Awakening",                    pct: 5   },
  { id: "janus_reading",           label: "Janus Reading System State",         pct: 8   },
  { id: "janus_thinking",          label: "Janus Analyzing (AI)",               pct: 12  },
  { id: "janus_decided",           label: "Janus Decided",                      pct: 18  },
  { id: "prometheus_starting",     label: "Prometheus Awakening",               pct: 22  },
  { id: "prometheus_reading_repo", label: "Prometheus Reading Repository",      pct: 32  },
  { id: "prometheus_analyzing",    label: "Prometheus Deep Analysis (AI)",      pct: 45  },
  { id: "prometheus_audit",        label: "Prometheus Read Audit",              pct: 55  },
  { id: "prometheus_done",         label: "Prometheus Analysis Complete",       pct: 60  },
  { id: "athena_reviewing",        label: "Athena Reviewing Plan",              pct: 65  },
  { id: "athena_approved",         label: "Athena Plan Approved",               pct: 72  },
  { id: "workers_dispatching",     label: "Dispatching Workers",                pct: 78  },
  { id: "workers_running",         label: "Workers Running",                    pct: 85  },
  { id: "workers_finishing",       label: "Workers Finishing",                  pct: 95  },
  { id: "cycle_complete",          label: "Cycle Complete",                     pct: 100 },
];

function getStateDir(config) {
  return config?.paths?.stateDir || "state";
}

function progressPath(config) {
  return path.join(getStateDir(config), "pipeline_progress.json");
}

/**
 * Update the pipeline progress.
 *
 * Validation:
 *   - Missing stepId (null/undefined/empty string) → throws with code MISSING_STEP_ID
 *   - Unknown stepId (not in PIPELINE_STAGE_ENUM)  → throws with code INVALID_STEP_ID
 *
 * @param {object}  config      BOX config
 * @param {string}  stepId      One of the PIPELINE_STAGE_ENUM values
 * @param {string}  [detail]    Human-readable detail of what is happening right now
 * @param {object}  [extra]     Optional extra fields (e.g. { thinkingSnippet, workersDone, workersTotal })
 */
export async function updatePipelineProgress(config, stepId, detail, extra) {
  if (stepId === null || stepId === undefined || String(stepId).trim() === "") {
    const err = new Error(`updatePipelineProgress: stepId is required`);
    (err as any).code = PROGRESS_ERROR_CODE.MISSING_STEP_ID;
    throw err;
  }
  const stepIndex = STEPS.findIndex(s => s.id === stepId);
  if (stepIndex < 0) {
    const err = new Error(`updatePipelineProgress: unknown stepId '${stepId}' — must be one of: ${PIPELINE_STAGE_ENUM.join(", ")}`);
    (err as any).code = PROGRESS_ERROR_CODE.INVALID_STEP_ID;
    throw err;
  }

  const current = STEPS[stepIndex];

  const steps = STEPS.map((s, i) => ({
    id: s.id,
    label: s.label,
    pct: s.pct,
    status: i < stepIndex ? "done" : i === stepIndex ? "active" : "pending",
  }));

  const payload = {
    stage: current.id,
    stageLabel: current.label,
    percent: current.pct,
    detail: detail || current.label,
    steps,
    updatedAt: new Date().toISOString(),
    ...(extra || {}),
  };
  const extraObj = (extra && typeof extra === "object") ? extra as Record<string, unknown> : {};

  // Preserve startedAt from the previous state if mid-pipeline
  if (stepId !== "idle" && stepId !== "cycle_complete") {
    try {
      const prev = await readJson(progressPath(config), {});
      payload.startedAt = prev.startedAt || payload.updatedAt;
      // Accumulate SLO-relevant stage timestamps
      const prevTimestamps = (prev.stageTimestamps && typeof prev.stageTimestamps === "object") ? prev.stageTimestamps : {};
      payload.stageTimestamps = { ...prevTimestamps };
      if (SLO_TIMESTAMP_STAGES.includes(stepId)) {
        payload.stageTimestamps[stepId] = payload.updatedAt;
      }
      const prevSegmentHistory = Array.isArray(prev.segmentHistory) ? prev.segmentHistory : [];
      if (extraObj.runSegmentRollover && typeof extraObj.runSegmentRollover === "object") {
        payload.segmentHistory = [...prevSegmentHistory, extraObj.runSegmentRollover].slice(-PIPELINE_SEGMENT_HISTORY_MAX);
      } else {
        payload.segmentHistory = prevSegmentHistory.slice(-PIPELINE_SEGMENT_HISTORY_MAX);
      }
      if (extraObj.runSegment && typeof extraObj.runSegment === "object") {
        payload.runSegment = extraObj.runSegment;
      } else if (prev.runSegment && typeof prev.runSegment === "object") {
        payload.runSegment = prev.runSegment;
      }
    } catch {
      payload.startedAt = payload.updatedAt;
      payload.stageTimestamps = {};
      if (SLO_TIMESTAMP_STAGES.includes(stepId)) {
        payload.stageTimestamps[stepId] = payload.updatedAt;
      }
      if (extraObj.runSegment && typeof extraObj.runSegment === "object") {
        payload.runSegment = extraObj.runSegment;
      }
      payload.segmentHistory = extraObj.runSegmentRollover && typeof extraObj.runSegmentRollover === "object"
        ? [extraObj.runSegmentRollover]
        : [];
    }
  } else if (stepId === "idle") {
    payload.startedAt = null;
    payload.stageTimestamps = {};
    payload.runSegment = null;
    payload.segmentHistory = [];
  } else {
    // cycle_complete — keep startedAt, accumulate final timestamp
    try {
      const prev = await readJson(progressPath(config), {});
      payload.startedAt = prev.startedAt || null;
      const prevTimestamps = (prev.stageTimestamps && typeof prev.stageTimestamps === "object") ? prev.stageTimestamps : {};
      payload.stageTimestamps = { ...prevTimestamps, cycle_complete: payload.updatedAt };
      const prevSegmentHistory = Array.isArray(prev.segmentHistory) ? prev.segmentHistory : [];
      if (extraObj.runSegmentRollover && typeof extraObj.runSegmentRollover === "object") {
        payload.segmentHistory = [...prevSegmentHistory, extraObj.runSegmentRollover].slice(-PIPELINE_SEGMENT_HISTORY_MAX);
      } else {
        payload.segmentHistory = prevSegmentHistory.slice(-PIPELINE_SEGMENT_HISTORY_MAX);
      }
      if (extraObj.runSegment && typeof extraObj.runSegment === "object") {
        payload.runSegment = extraObj.runSegment;
      } else if (prev.runSegment && typeof prev.runSegment === "object") {
        payload.runSegment = prev.runSegment;
      }
    } catch {
      payload.stageTimestamps = { cycle_complete: payload.updatedAt };
      payload.segmentHistory = extraObj.runSegmentRollover && typeof extraObj.runSegmentRollover === "object"
        ? [extraObj.runSegmentRollover]
        : [];
      if (extraObj.runSegment && typeof extraObj.runSegment === "object") {
        payload.runSegment = extraObj.runSegment;
      }
    }
    payload.completedAt = payload.updatedAt;
    // Persist an explicit terminal block reason when the cycle ends without all canonical
    // events present. This prevents silent null-event persistence.
    // The spread at the top of payload may have included a raw terminalBlockReason — normalize it here.
    delete (payload as any).terminalBlockReason;
    if (extraObj.terminalBlockReason && typeof extraObj.terminalBlockReason === "string") {
      const trimmed = extraObj.terminalBlockReason.trim();
      if (trimmed) (payload as any).terminalBlockReason = trimmed;
    }
  }

  await writeJson(progressPath(config), payload);
}

/**
 * Read current pipeline progress (for dashboard).
 */
export async function readPipelineProgress(config) {
  return readJson(progressPath(config), {
    stage: "idle",
    stageLabel: "Idle",
    percent: 0,
    detail: "System ready",
    steps: STEPS.map(s => ({ ...s, status: "pending" })),
    updatedAt: null,
    startedAt: null,
  });
}

/** Export STEPS for tests/diagnostics. */
export { STEPS as PIPELINE_STEPS };

/**
 * SLO-relevant stages whose entry timestamps must be recorded in stageTimestamps.
 *
 * Field contract (Athena missing item resolved):
 *   stageTimestamps is the authoritative source for all SLO latency inputs.
 *   Dispatch latency reads athena_approved → workers_dispatching from stageTimestamps.
 *   decision latency reads janus_awakening → janus_decided from stageTimestamps.
 *   verification completion reads workers_dispatching → cycle_complete from stageTimestamps.
 *
 * cycleId contract (Athena missing item resolved):
 *   pipeline_progress.startedAt is the canonical cycle identifier.
 */
export const SLO_TIMESTAMP_STAGES = Object.freeze([
  "janus_awakening",
  "janus_decided",
  "athena_approved",
  "workers_dispatching",
  "workers_finishing",
  "cycle_complete",
]);

/**
 * Minimum funnel completionRate (dispatched→completed) required for a queue to be
 * considered execution-effective.  When cycle_analytics.json reports a completionRate
 * below this value (and at least one plan was dispatched in the previous cycle), the
 * queue is treated as NOT viable even if pending work exists — replan suppression is
 * lifted so Janus can trigger a fresh Prometheus analysis rather than continue
 * dispatching work that consistently fails to complete.
 *
 * Value chosen at 0.2: a cycle where fewer than 1-in-5 dispatched plans complete
 * indicates a systemic execution failure, not normal throughput variance.
 */
export const QUEUE_VIABILITY_MIN_COMPLETION_RATE = 0.2;

/**
 * Compute whether the current plan queue has viable pending work.
 *
 * A queue is "viable" when ALL of the following are true:
 *   1. prometheus_analysis.json contains at least one plan, AND
 *   2. athena_plan_review.json shows approved=true, AND
 *   3. the dispatch_checkpoint is NOT already "complete" for this plan set, AND
 *   4. cycle_analytics.json funnel.completionRate is null (no data) OR ≥
 *      QUEUE_VIABILITY_MIN_COMPLETION_RATE (execution-effective).
 *
 * Condition 4 ensures Janus only suppresses replans when queued work is both
 * pending AND execution-effective.  A queue with a very low completion rate
 * (workers consistently failing) is not considered viable — replan suppression
 * is lifted so the system can replan rather than keep dispatching failing work.
 *
 * This is used by janus_supervisor to gate age-based replanning:
 * if there are viable pending plans, a Prometheus replan triggered solely by
 * plan-age is suppressed — the existing approved work is executed first.
 *
 * Returns:
 *   viable         — true when pending work exists and should be executed
 *   pendingCount   — estimated number of pending plans
 *   totalCount     — total plan count in prometheus_analysis
 *   reason         — machine-readable reason code
 *   completionRate — funnel completionRate from cycle_analytics (null if absent)
 *
 * Never throws — all read errors return viable=false with reason="read-error".
 */
export async function computeQueueViability(config: object): Promise<{
  viable: boolean;
  pendingCount: number;
  totalCount: number;
  reason: string;
  completionRate: number | null;
}> {
  const stateDir = (config as any)?.paths?.stateDir || "state";
  try {
    const prometheusAnalysis = await readJson(
      path.join(stateDir, "prometheus_analysis.json"), null
    );
    const totalCount = Array.isArray(prometheusAnalysis?.plans)
      ? prometheusAnalysis.plans.length : 0;

    if (totalCount === 0) {
      return { viable: false, pendingCount: 0, totalCount: 0, reason: "no-plans", completionRate: null };
    }

    const athenaReview = await readJson(
      path.join(stateDir, "athena_plan_review.json"), null
    );
    if (!athenaReview?.approved) {
      return { viable: false, pendingCount: 0, totalCount, reason: "athena-not-approved", completionRate: null };
    }

    const checkpoint = await readJson(
      path.join(stateDir, "dispatch_checkpoint.json"), null
    );

    // If checkpoint is marked complete for this plan set, nothing pending
    if (checkpoint?.status === "complete") {
      const checkpointPlanCount = Number(checkpoint?.planCount ?? checkpoint?.totalPlans ?? 0);
      if (checkpointPlanCount === totalCount) {
        return { viable: false, pendingCount: 0, totalCount, reason: "all-complete", completionRate: null };
      }
    }

    // Estimate pending count from checkpoint progress
    const batchTotal = Number(checkpoint?.totalPlans || totalCount);
    const batchDone = Math.min(
      Number(checkpoint?.completedPlans || 0),
      batchTotal,
    );
    const completedEstimate = batchTotal > 0
      ? Math.round((batchDone / batchTotal) * totalCount) : 0;
    const pendingCount = Math.max(0, totalCount - completedEstimate);

    if (pendingCount === 0) {
      return { viable: false, pendingCount: 0, totalCount, reason: "all-complete", completionRate: null };
    }

    // ── Execution-effectiveness gate: check funnel completionRate ────────────
    // Read cycle_analytics.json directly (no import from cycle_analytics.ts to
    // avoid circular dependency: cycle_analytics already imports pipeline_progress).
    // If the previous cycle's funnel.completionRate is below QUEUE_VIABILITY_MIN_COMPLETION_RATE
    // and at least one plan was dispatched, the queue is execution-ineffective:
    // suppress replan suppression so Janus can trigger a fresh plan.
    let completionRate: number | null = null;
    try {
      const cycleAnalytics = await readJson(
        path.join(stateDir, "cycle_analytics.json"), null
      );
      // cycle_analytics.json may be a snapshot or wrapped in {lastCycle: ...}
      const funnelSource = cycleAnalytics?.funnel ?? cycleAnalytics?.lastCycle?.funnel ?? null;
      const rawRate = funnelSource?.completionRate;
      const rawDispatched = funnelSource?.dispatched;
      if (typeof rawRate === "number" && Number.isFinite(rawRate)) {
        completionRate = rawRate;
        const dispatched = typeof rawDispatched === "number" && Number.isFinite(rawDispatched)
          ? rawDispatched : 1; // treat unknown dispatched as >0 to be conservative
        if (dispatched > 0 && completionRate < QUEUE_VIABILITY_MIN_COMPLETION_RATE) {
          return {
            viable: false,
            pendingCount,
            totalCount,
            reason: "low-completion-rate",
            completionRate,
          };
        }
      }
    } catch {
      // Non-fatal: if cycle_analytics is missing or unreadable, skip this gate.
      // Absence of analytics data should not block execution.
    }

    return {
      viable: true,
      pendingCount,
      totalCount,
      reason: `${pendingCount}/${totalCount}-pending`,
      completionRate,
    };
  } catch {
    return { viable: false, pendingCount: 0, totalCount: 0, reason: "read-error", completionRate: null };
  }
}

/**
 * Canonical schema for pipeline_progress.json.
 * Published for tests and dashboard consumers to validate against.
 */
export const PIPELINE_PROGRESS_SCHEMA = Object.freeze({
  required: ["stage", "stageLabel", "percent", "detail", "steps", "updatedAt", "startedAt"],
  stageEnum: PIPELINE_STAGE_ENUM,
  percentRange: [0, 100],
  stepStatusEnum: Object.freeze(["done", "active", "pending"]),
  /** completedAt is present only when stage === "cycle_complete" */
  conditionalFields: Object.freeze({
    completedAt:         "cycle_complete",
    /** terminalBlockReason is present on cycle_complete when canonical events are null (early exit) */
    terminalBlockReason: "cycle_complete_with_null_events",
  }),
  /** stageTimestamps accumulates ISO entry times for SLO-relevant stages */
  sloTimestampStages: SLO_TIMESTAMP_STAGES,
  /** maximum retained run segment rollover records */
  segmentHistoryMax: PIPELINE_SEGMENT_HISTORY_MAX,
});

/**
 * Canonical system status enum.
 * All valid values for runtime.systemStatus in the dashboard payload.
 *
 * Values:
 *   offline   — daemon not running and no completion record
 *   completed — project finished (daemon stopped, completion ledger entry found)
 *   degraded  — orchestratorHealth.orchestratorStatus === "degraded" (SLO breach etc.)
 *   idle      — daemon running but no active workers or pipeline activity
 *   working   — pipeline is actively progressing through stages or workers are running
 */
export const SYSTEM_STATUS_ENUM = Object.freeze([
  "offline",
  "completed",
  "degraded",
  "idle",
  "working",
]);

/**
 * Reason codes for degraded/fallback system status.
 * Emitted as degradedReason or statusSource annotation in the dashboard payload.
 *
 * Machine-readable values checked by tests and monitoring.
 */
export const SYSTEM_STATUS_REASON_CODE = Object.freeze({
  /** orchestratorHealth.orchestratorStatus === "degraded" */
  HEALTH_FILE_DEGRADED:   "HEALTH_FILE_DEGRADED",
  /** daemon process is not running */
  DAEMON_OFFLINE:         "DAEMON_OFFLINE",
  /** pipeline_progress.json is absent or stale (> 10 min old) — fell back to heuristics */
  FALLBACK_HEURISTIC:     "FALLBACK_HEURISTIC",
  /** pipeline_progress.json could not be read */
  MISSING_PIPELINE_STATE: "MISSING_PIPELINE_STATE",
});

