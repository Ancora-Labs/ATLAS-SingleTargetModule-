/**
 * Counterfactual Replay Harness — T-023
 *
 * Replays prior cycles with candidate policy decisions to estimate alternate
 * outcomes before live deployment. All replay operations are OFFLINE — no live
 * state is mutated during replay.
 *
 * Key contracts:
 *   - DEFAULT_CYCLE_WINDOW = 10  (N is always explicit)
 *   - LOW_CONFIDENCE_THRESHOLD = 0.4  (numeric; flags uncertain projections)
 *   - REPLAY_STATUS: "ok" | "degraded" | "error"
 *   - REPLAY_DEGRADED_REASON: enumerated reason codes for all degraded paths
 *
 * Policy candidate interface (input):
 *   {
 *     id: string,              — unique identifier for this candidate
 *     description: string,     — human-readable label
 *     thresholds: {
 *       maxRetries: number,    — max task retries before abort (integer ≥ 1)
 *       timeoutMinutes: number,— task timeout in minutes (positive number)
 *       minSuccessRate: number — minimum required success rate [0, 1]
 *     }
 *   }
 *
 * Policy evaluation output per (policy, cycle) pair — PolicyEvalResult:
 *   {
 *     policyId: string,
 *     cycleIndex: number,       — 0-based index into loaded cycles (0 = oldest)
 *     metrics: OutcomeMetrics,  — projected metrics under this policy
 *     baselineMetrics: OutcomeMetrics, — actual metrics from cycle data
 *     delta: DeltaMetrics,      — difference (metrics − baseline)
 *     confidenceScore: number,  — [0, 1]; low when sample is small or data is sparse
 *     lowConfidence: boolean,   — true when confidenceScore < LOW_CONFIDENCE_THRESHOLD
 *     lowConfidenceReason: string|null,
 *     status: "ok" | "error",
 *     errorReason: REPLAY_DEGRADED_REASON code | null
 *   }
 *
 * OutcomeMetrics schema:
 *   {
 *     tasksCompleted: number,    — count of tasks with correct/delayed-correct label
 *     workerSuccessRate: number, — fraction [0, 1] of tasks that succeeded
 *     avgAttempts: number,       — average attempts per task (1.0 if unknown)
 *     cycleHealth: "good" | "fair" | "poor",
 *     weightedScore: number|null — weighted decision quality score [0, 1]
 *   }
 *
 * Reproducibility metadata (ReplayResult root fields):
 *   {
 *     replayId: string,          — 16-hex unique ID (crypto.randomBytes)
 *     replayTimestamp: string,   — ISO8601
 *     status: REPLAY_STATUS,     — "ok" | "degraded" | "error"
 *     degradedReason: string|null,
 *     cycleWindow: number,       — N requested
 *     cyclesLoaded: number,      — how many cycles were actually loaded
 *     inputHash: string,         — SHA256 hex of serialized cycle inputs (determinism proof)
 *     sourceFiles: string[],     — state files that contributed cycle data
 *     policyResults: PolicyEvalResult[]
 *   }
 *
 * Results are stored at: state/replay_results/<replayId>.json
 */

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { readJsonSafe, READ_JSON_REASON, writeJson } from "./fs_utils.js";
import { extractPostmortemEntries, migrateData, STATE_FILE_TYPE } from "./schema_registry.js";
import { normalizeDecisionQualityLabel, DECISION_QUALITY_LABEL } from "./athena_reviewer.js";
import { loadRouteROILedger } from "./model_policy.js";
import { auditReplayPolicySignals } from "./parser_replay_harness.js";

const DECISION_QUALITY_WEIGHTS = Object.freeze({
  [DECISION_QUALITY_LABEL.CORRECT]: 1.0,
  [DECISION_QUALITY_LABEL.DELAYED_CORRECT]: 0.6,
  [DECISION_QUALITY_LABEL.INCORRECT]: 0.0,
  [DECISION_QUALITY_LABEL.INCONCLUSIVE]: 0.3,
});

function computeWeightedDecisionScore(postmortems) {
  if (!Array.isArray(postmortems) || postmortems.length === 0) {
    return { score: null, labelCounts: {}, total: 0 };
  }
  const labelCounts = {};
  for (const label of Object.values(DECISION_QUALITY_LABEL)) {
    labelCounts[label] = 0;
  }
  let weightedSum = 0;
  let count = 0;
  for (const postmortem of postmortems) {
    const label = normalizeDecisionQualityLabel(postmortem);
    labelCounts[label] = (labelCounts[label] || 0) + 1;
    weightedSum += DECISION_QUALITY_WEIGHTS[label] ?? DECISION_QUALITY_WEIGHTS[DECISION_QUALITY_LABEL.INCONCLUSIVE];
    count++;
  }
  return {
    score: count > 0 ? weightedSum / count : null,
    labelCounts,
    total: count,
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Default number of recent cycles to load for replay.
 * Always explicit — never inferred or caller-guessed.
 */
export const DEFAULT_CYCLE_WINDOW = 10;

/**
 * Confidence threshold below which a projection is flagged as low-confidence.
 * Numeric and explicit: confidenceScore < 0.4 → lowConfidence = true.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.4;

// ── Status / Reason Enums ─────────────────────────────────────────────────────

/**
 * Top-level status for a replay run.
 * Must be set on every result — no silent fallback allowed.
 *
 * ok       — all cycles loaded and all policies evaluated successfully
 * degraded — partial data; some cycles or policies produced errors
 * error    — replay could not proceed (no cycles, invalid policy list)
 */
export const REPLAY_STATUS = Object.freeze({
  OK:       "ok",
  DEGRADED: "degraded",
  ERROR:    "error"
});

/**
 * Machine-readable reason codes for degraded/error replay results.
 *
 * MISSING_CYCLES       — source file not found (ENOENT)
 * INVALID_CYCLE        — cycle data found but fails structure validation
 * POLICY_ERROR         — a policy candidate threw during evaluation
 * INSUFFICIENT_CYCLES  — fewer cycles loaded than requested (< N)
 * INVALID_POLICY       — policy candidate is missing required fields
 * SIGNAL_REGRESSION    — replay-only policy signal contract is malformed
 */
export const REPLAY_DEGRADED_REASON = Object.freeze({
  MISSING_CYCLES:      "MISSING_CYCLES",
  INVALID_CYCLE:       "INVALID_CYCLE",
  POLICY_ERROR:        "POLICY_ERROR",
  INSUFFICIENT_CYCLES: "INSUFFICIENT_CYCLES",
  INVALID_POLICY:      "INVALID_POLICY",
  SIGNAL_REGRESSION:   "SIGNAL_REGRESSION",
});

export const REPLAY_CHECKPOINT_CONTRACT_VERSION = 1;

// ── Outcome Metrics Helpers ───────────────────────────────────────────────────

/**
 * Determine cycle health label from a worker success rate.
 *   good  — successRate >= 0.75
 *   fair  — successRate >= 0.4
 *   poor  — successRate < 0.4
 *
 * @param {number} successRate  [0, 1]
 * @returns {"good"|"fair"|"poor"}
 */
function healthLabel(successRate) {
  if (successRate >= 0.75) return "good";
  if (successRate >= 0.4)  return "fair";
  return "poor";
}

/**
 * Compute OutcomeMetrics from an array of postmortem-style entries.
 * Each entry must have at least a `decisionQuality` or derivable label.
 *
 * @param {Array<object>} entries
 * @returns {OutcomeMetrics}
 */
export function computeOutcomeMetrics(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      tasksCompleted:    0,
      workerSuccessRate: 0,
      avgAttempts:       1,
      cycleHealth:       "poor",
      weightedScore:     null
    };
  }

  const succeeded = entries.filter(e => {
    const label = normalizeDecisionQualityLabel(e);
    return label === DECISION_QUALITY_LABEL.CORRECT ||
           label === DECISION_QUALITY_LABEL.DELAYED_CORRECT;
  });

  const workerSuccessRate = entries.length > 0 ? succeeded.length / entries.length : 0;

  // avgAttempts: use entry.attempts if present, else default to 1
  const attemptsSum = entries.reduce((sum, e) => sum + (Number(e.attempts) || 1), 0);
  const avgAttempts = attemptsSum / entries.length;

  const { score: weightedScore } = computeWeightedDecisionScore(entries);

  return {
    tasksCompleted:    succeeded.length,
    workerSuccessRate: Math.round(workerSuccessRate * 1000) / 1000,
    avgAttempts:       Math.round(avgAttempts * 100) / 100,
    cycleHealth:       healthLabel(workerSuccessRate),
    weightedScore:     weightedScore !== null ? Math.round(weightedScore * 1000) / 1000 : null
  };
}

/**
 * Compute confidence score for a projection.
 *
 * Confidence is based on:
 *   - Sample size: more entries → higher confidence (saturates at 10)
 *   - Data quality: presence of decisionQuality labels boosts confidence
 *
 * Returns a value in [0, 1].
 *
 * @param {Array<object>} entries
 * @returns {number}
 */
export function computeConfidenceScore(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;

  // Size factor: confidence saturates at DEFAULT_CYCLE_WINDOW samples
  // Size dominates (80%) — a single entry should always be low-confidence.
  const sizeFactor = Math.min(entries.length / DEFAULT_CYCLE_WINDOW, 1.0);

  // Quality factor: fraction of entries that have a recognized decision quality label
  const knownLabels = new Set(Object.values(DECISION_QUALITY_LABEL));
  const labeled = entries.filter(e => knownLabels.has(normalizeDecisionQualityLabel(e)));
  const qualityFactor = labeled.length / entries.length;

  return Math.round((sizeFactor * 0.8 + qualityFactor * 0.2) * 1000) / 1000;
}

// ── Policy Validation ─────────────────────────────────────────────────────────

/**
 * Validate a policy candidate object.
 *
 * Returns { ok: true } or { ok: false, reason: REPLAY_DEGRADED_REASON.INVALID_POLICY,
 *   missingFields: string[], invalidFields: string[] }
 *
 * Distinguishes:
 *   - Missing input: required field absent → INVALID_POLICY + missingFields
 *   - Invalid input: field present but wrong type/range → INVALID_POLICY + invalidFields
 *
 * @param {object} policy
 * @returns {{ ok: boolean, reason: string|null, missingFields: string[], invalidFields: string[] }}
 */
export function validatePolicyCandidate(policy) {
  const missingFields = [];
  const invalidFields = [];

  if (policy === null || policy === undefined || typeof policy !== "object") {
    return {
      ok: false,
      reason: REPLAY_DEGRADED_REASON.INVALID_POLICY,
      missingFields: ["<policy object>"],
      invalidFields: []
    };
  }

  if (!("id" in policy)) {
    missingFields.push("id");
  } else if (typeof policy.id !== "string" || !policy.id.trim()) {
    invalidFields.push("id");
  }

  if (!("description" in policy)) {
    missingFields.push("description");
  } else if (typeof policy.description !== "string") {
    invalidFields.push("description");
  }

  if (!("thresholds" in policy)) {
    missingFields.push("thresholds");
  } else if (typeof policy.thresholds !== "object" || policy.thresholds === null) {
    invalidFields.push("thresholds");
  } else {
    const t = policy.thresholds;
    if (!("maxRetries" in t))          missingFields.push("thresholds.maxRetries");
    else if (!Number.isInteger(t.maxRetries) || t.maxRetries < 1)
                                        invalidFields.push("thresholds.maxRetries");

    if (!("timeoutMinutes" in t))       missingFields.push("thresholds.timeoutMinutes");
    else if (typeof t.timeoutMinutes !== "number" || t.timeoutMinutes <= 0)
                                        invalidFields.push("thresholds.timeoutMinutes");

    if (!("minSuccessRate" in t))       missingFields.push("thresholds.minSuccessRate");
    else if (typeof t.minSuccessRate !== "number" || t.minSuccessRate < 0 || t.minSuccessRate > 1)
                                        invalidFields.push("thresholds.minSuccessRate");
  }

  if (missingFields.length > 0 || invalidFields.length > 0) {
    return {
      ok: false,
      reason: REPLAY_DEGRADED_REASON.INVALID_POLICY,
      missingFields,
      invalidFields
    };
  }

  return { ok: true, reason: null, missingFields: [], invalidFields: [] };
}

// ── Policy Application ────────────────────────────────────────────────────────

/**
 * Apply a policy candidate to a set of cycle entries and compute projected metrics.
 *
 * This is a PURE function — no I/O, no state mutation.
 *
 * The counterfactual model:
 *   - Entries that failed due to retries are re-evaluated under the new maxRetries.
 *   - Entries whose attempts exceed maxRetries → projected as INCORRECT.
 *   - Entries that succeeded are kept as-is.
 *   - The minSuccessRate threshold does not change outcomes but is recorded in the delta.
 *
 * @param {Array<object>} cycleEntries  — postmortem entries for this cycle
 * @param {object} policy               — validated policy candidate
 * @returns {Array<object>}             — projected entries (shallow-cloned, label overridden)
 */
export function applyPolicyToEntries(cycleEntries, policy) {
  if (!Array.isArray(cycleEntries)) return [];
  const { maxRetries } = policy.thresholds;

  return cycleEntries.map(entry => {
    const attempts = Number(entry.attempts) || 1;
    // If this task used more attempts than the policy allows, it would have been
    // aborted — project it as INCORRECT.
    if (attempts > maxRetries) {
      return {
        ...entry,
        decisionQualityLabel: DECISION_QUALITY_LABEL.INCORRECT,
        _projectedByPolicy: policy.id
      };
    }
    return { ...entry, _projectedByPolicy: policy.id };
  });
}

// ── Cycle Data Loading ────────────────────────────────────────────────────────

/**
 * Load the last N postmortem-derived cycle snapshots from state.
 *
 * Source: athena_postmortems.json → extractPostmortemEntries → last N entries.
 * Entries are sorted by timestamp (ascending) so index 0 = oldest.
 *
 * Returns:
 *   {
 *     ok: boolean,
 *     cycles: Array<object>[],   — one entry per cycle slot (array of entries per slot)
 *     reason: REPLAY_DEGRADED_REASON | null,
 *     sourceFiles: string[],
 *     raw: object|null           — raw parsed data before extraction
 *   }
 *
 * @param {string} stateDir
 * @param {number} n
 * @returns {Promise<object>}
 */
export async function loadCycleSnapshots(stateDir, n) {
  const sourceFile = path.join(stateDir, "athena_postmortems.json");
  const result = await readJsonSafe(sourceFile);

  if (!result.ok) {
    const reason = result.reason === READ_JSON_REASON.MISSING
      ? REPLAY_DEGRADED_REASON.MISSING_CYCLES
      : REPLAY_DEGRADED_REASON.INVALID_CYCLE;
    return { ok: false, cycles: [], reason, sourceFiles: [], raw: null };
  }

  const migrated = migrateData(result.data, STATE_FILE_TYPE.ATHENA_POSTMORTEMS);
  if (!migrated.ok) {
    return {
      ok: false,
      cycles: [],
      reason: REPLAY_DEGRADED_REASON.INVALID_CYCLE,
      sourceFiles: ["athena_postmortems.json"],
      raw: result.data
    };
  }

  const entries = extractPostmortemEntries(migrated.data);
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      ok: false,
      cycles: [],
      reason: REPLAY_DEGRADED_REASON.MISSING_CYCLES,
      sourceFiles: ["athena_postmortems.json"],
      raw: result.data
    };
  }

  // Sort entries by timestamp ascending (oldest first), then take last N.
  const sorted = [...entries].sort((a, b) => {
    const ta = String(a.timestamp || a.reviewedAt || "");
    const tb = String(b.timestamp || b.reviewedAt || "");
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  const window = sorted.slice(-n);

  // Wrap each entry as a single-element "cycle" array for uniform processing.
  // In future, multiple entries per cycle can be grouped here.
  const cycles = window.map(entry => [entry]);

  return {
    ok: true,
    cycles,
    reason: null,
    sourceFiles: ["athena_postmortems.json"],
    raw: result.data
  };
}

// ── Input Hashing ─────────────────────────────────────────────────────────────

/**
 * Compute a deterministic SHA256 hash of the cycle inputs.
 * Same input → same hash → double-run diff = empty → determinism verified.
 *
 * @param {Array<Array<object>>} cycles
 * @returns {string}  16-char hex prefix of SHA256
 */
export function computeInputHash(cycles) {
  const serialized = JSON.stringify(cycles);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

async function readReplayCheckpointCompatibility(stateDir) {
  const dispatchCheckpointPath = path.join(stateDir, "dispatch_checkpoint.json");
  const result = await readJsonSafe(dispatchCheckpointPath);
  if (!result.ok) {
    if (result.reason === READ_JSON_REASON.MISSING) {
      return { compatible: true, reason: null, sourceFiles: [] };
    }
    return {
      compatible: false,
      reason: REPLAY_DEGRADED_REASON.INVALID_CYCLE,
      sourceFiles: ["dispatch_checkpoint.json"],
    };
  }

  const checkpoint = result.data && typeof result.data === "object" ? result.data : null;
  if (!checkpoint) {
    return {
      compatible: false,
      reason: REPLAY_DEGRADED_REASON.INVALID_CYCLE,
      sourceFiles: ["dispatch_checkpoint.json"],
    };
  }

  const schemaVersion = Number((checkpoint as any).schemaVersion || 1);
  const replayContractVersion = Number((checkpoint as any)?.replayCompatibility?.replayContractVersion || 0);
  if (schemaVersion >= 2 && replayContractVersion !== REPLAY_CHECKPOINT_CONTRACT_VERSION) {
    return {
      compatible: false,
      reason: REPLAY_DEGRADED_REASON.INVALID_CYCLE,
      sourceFiles: ["dispatch_checkpoint.json"],
    };
  }

  return {
    compatible: true,
    reason: null,
    sourceFiles: ["dispatch_checkpoint.json"],
  };
}

async function loadJsonIfPresent(filePath) {
  const result = await readJsonSafe(filePath);
  return result.ok ? result.data : null;
}

async function loadBoundaryCheckpoints(stateDir, prefix) {
  let files;
  try {
    files = (await fs.readdir(stateDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const snapshots = [];
  for (const fileName of files) {
    const payload = await loadJsonIfPresent(path.join(stateDir, fileName));
    if (payload && typeof payload === "object") {
      snapshots.push(payload);
    }
  }
  return snapshots;
}

function extractCandidatePlanningSnapshot(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const snapshot = (source as any).candidatePlanning ?? (source as any)._candidatePlanning;
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : null;
}

async function loadReplayPolicySignals(config, stateDir) {
  const overrides = config?.replay?.policySignals && typeof config.replay.policySignals === "object"
    ? config.replay.policySignals
    : {};
  const dispatchCheckpoint = overrides.dispatchCheckpoint && typeof overrides.dispatchCheckpoint === "object"
    ? overrides.dispatchCheckpoint
    : await loadJsonIfPresent(path.join(stateDir, "dispatch_checkpoint.json"));
  const plannerCheckpoints = Array.isArray(overrides.plannerCheckpoints)
    ? overrides.plannerCheckpoints
    : await loadBoundaryCheckpoints(stateDir, "boundary_checkpoint_planner");
  const attemptCheckpoints = Array.isArray(overrides.attemptCheckpoints)
    ? overrides.attemptCheckpoints
    : await loadBoundaryCheckpoints(stateDir, "boundary_checkpoint_attempt");
  const plannerSnapshot = plannerCheckpoints.find((checkpoint) => extractCandidatePlanningSnapshot(checkpoint)) ?? null;

  return {
    expectedDomains: overrides.expectedDomains ?? config?.replay?.expectedSignalDomains ?? [],
    candidatePlanning: overrides.candidatePlanning ?? extractCandidatePlanningSnapshot(plannerSnapshot),
    dispatchPlans: overrides.dispatchPlans
      ?? (Array.isArray((dispatchCheckpoint as any)?.dispatchPlanSnapshot) ? (dispatchCheckpoint as any).dispatchPlanSnapshot : []),
    attemptCheckpoints,
    routingTelemetry: Array.isArray(overrides.routingTelemetry)
      ? overrides.routingTelemetry
      : await loadRouteROILedger(config),
  };
}

// ── Main Replay Entry Point ───────────────────────────────────────────────────

/**
 * Run a counterfactual replay with the given policy candidates.
 *
 * @param {object} config
 *   config.paths.stateDir — directory containing state files
 *   config.replay?.cycleWindow — override DEFAULT_CYCLE_WINDOW (optional)
 * @param {Array<object>} policyCandidates — array of policy candidate objects
 * @returns {Promise<ReplayResult>}
 */
export async function runReplay(config, policyCandidates) {
  const stateDir = config?.paths?.stateDir || "state";
  const cycleWindow = Number(config?.replay?.cycleWindow) || DEFAULT_CYCLE_WINDOW;
  const replayId = crypto.randomBytes(8).toString("hex");
  const replayTimestamp = new Date().toISOString();

  // ── Validate policy candidates (missing vs invalid input) ─────────────────
  if (!Array.isArray(policyCandidates) || policyCandidates.length === 0) {
    return {
      replayId,
      replayTimestamp,
      status: REPLAY_STATUS.ERROR,
      degradedReason: REPLAY_DEGRADED_REASON.INVALID_POLICY,
      cycleWindow,
      cyclesLoaded: 0,
      inputHash: "",
      sourceFiles: [],
      policyResults: []
    };
  }

  const policyValidations = policyCandidates.map(p => ({ policy: p, validation: validatePolicyCandidate(p) }));
  const invalidPolicies = policyValidations.filter(pv => !pv.validation.ok);
  if (invalidPolicies.length > 0) {
    // Some policies are invalid — return error with details embedded in results
    const policyResults = invalidPolicies.map(pv => ({
      policyId:            String(pv.policy?.id || "<unknown>"),
      cycleIndex:          -1,
      metrics:             null,
      baselineMetrics:     null,
      delta:               null,
      confidenceScore:     0,
      lowConfidence:       true,
      lowConfidenceReason: "policy failed validation",
      status:              "error",
      errorReason:         REPLAY_DEGRADED_REASON.INVALID_POLICY,
      validationDetail:    pv.validation
    }));
    return {
      replayId,
      replayTimestamp,
      status: REPLAY_STATUS.ERROR,
      degradedReason: REPLAY_DEGRADED_REASON.INVALID_POLICY,
      cycleWindow,
      cyclesLoaded: 0,
      inputHash: "",
      sourceFiles: [],
      policyResults
    };
  }

  // ── Load cycle snapshots ──────────────────────────────────────────────────
  const snapshotResult = await loadCycleSnapshots(stateDir, cycleWindow);

  if (!snapshotResult.ok) {
    return {
      replayId,
      replayTimestamp,
      status:         REPLAY_STATUS.ERROR,
      degradedReason: snapshotResult.reason,
      cycleWindow,
      cyclesLoaded:   0,
      inputHash:      "",
      sourceFiles:    snapshotResult.sourceFiles,
      policyResults:  []
    };
  }

  const { cycles, sourceFiles } = snapshotResult;
  const checkpointCompatibility = await readReplayCheckpointCompatibility(stateDir);
  const inputHash = computeInputHash(cycles);
  const policySignalAudit = auditReplayPolicySignals(await loadReplayPolicySignals(config, stateDir));

  const topLevelStatus = (!checkpointCompatibility.compatible || policySignalAudit.regressionCount > 0 || cycles.length < cycleWindow)
    ? REPLAY_STATUS.DEGRADED
    : REPLAY_STATUS.OK;

  const topLevelReason = !checkpointCompatibility.compatible
    ? checkpointCompatibility.reason
    : policySignalAudit.regressionCount > 0
      ? REPLAY_DEGRADED_REASON.SIGNAL_REGRESSION
    : cycles.length < cycleWindow
      ? REPLAY_DEGRADED_REASON.INSUFFICIENT_CYCLES
      : null;

  // ── Evaluate each policy against each cycle ───────────────────────────────
  const policyResults = [];

  for (const { policy } of policyValidations) {
    for (let i = 0; i < cycles.length; i++) {
      const cycleEntries = cycles[i];

      let projectedEntries;
      let evalError = null;
      try {
        projectedEntries = applyPolicyToEntries(cycleEntries, policy);
      } catch (err) {
        evalError = err;
      }

      if (evalError) {
        policyResults.push({
          policyId:            policy.id,
          cycleIndex:          i,
          metrics:             null,
          baselineMetrics:     null,
          delta:               null,
          confidenceScore:     0,
          lowConfidence:       true,
          lowConfidenceReason: `policy evaluation threw: ${evalError.message}`,
          status:              "error",
          errorReason:         REPLAY_DEGRADED_REASON.POLICY_ERROR
        });
        continue;
      }

      const baselineMetrics   = computeOutcomeMetrics(cycleEntries);
      const projectedMetrics  = computeOutcomeMetrics(projectedEntries);
      const confidenceScore   = computeConfidenceScore(cycleEntries);
      const lowConfidence     = confidenceScore < LOW_CONFIDENCE_THRESHOLD;

      let lowConfidenceReason = null;
      if (lowConfidence) {
        if (cycleEntries.length === 0) {
          lowConfidenceReason = "no entries in cycle";
        } else if (cycleEntries.length < 3) {
          lowConfidenceReason = `small sample: only ${cycleEntries.length} entry/entries`;
        } else {
          lowConfidenceReason = "insufficient labeled entries for reliable projection";
        }
      }

      const delta = {
        tasksCompleted:    projectedMetrics.tasksCompleted    - baselineMetrics.tasksCompleted,
        workerSuccessRate: Math.round((projectedMetrics.workerSuccessRate - baselineMetrics.workerSuccessRate) * 1000) / 1000,
        avgAttempts:       Math.round((projectedMetrics.avgAttempts       - baselineMetrics.avgAttempts)       * 100) / 100,
        weightedScore:     projectedMetrics.weightedScore !== null && baselineMetrics.weightedScore !== null
          ? Math.round((projectedMetrics.weightedScore - baselineMetrics.weightedScore) * 1000) / 1000
          : null
      };

      policyResults.push({
        policyId:            policy.id,
        cycleIndex:          i,
        metrics:             projectedMetrics,
        baselineMetrics,
        delta,
        confidenceScore,
        lowConfidence,
        lowConfidenceReason,
        status:              "ok",
        errorReason:         null
      });
    }
  }

  // ── Final status accounting ───────────────────────────────────────────────
  const hasErrors    = policyResults.some(r => r.status === "error");
  const finalStatus  = hasErrors
    ? (topLevelStatus === REPLAY_STATUS.OK ? REPLAY_STATUS.DEGRADED : topLevelStatus)
    : topLevelStatus;

  const result = {
    replayId,
    replayTimestamp,
    status:        finalStatus,
    degradedReason: topLevelReason,
    cycleWindow,
    cyclesLoaded:  cycles.length,
    inputHash,
    sourceFiles: [...sourceFiles, ...checkpointCompatibility.sourceFiles],
    checkpointReplayCompatibility: {
      compatible: checkpointCompatibility.compatible,
      reason: checkpointCompatibility.reason,
      contractVersion: REPLAY_CHECKPOINT_CONTRACT_VERSION,
    },
    policySignalAudit,
    policyResults
  };

  // ── Persist result (offline — never mutates live state files) ────────────
  const resultsDir = path.join(stateDir, "replay_results");
  try {
    await fs.mkdir(resultsDir, { recursive: true });
    await writeJson(path.join(resultsDir, `${replayId}.json`), result);
  } catch { /* storage failure must not abort the replay result */ }

  return result;
}
