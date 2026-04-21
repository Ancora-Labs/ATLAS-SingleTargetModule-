/**
 * Shadow Policy Evaluator — T-017
 *
 * Evaluates proposed policy changes against recent cycle history before promotion.
 * Shadow mode: reads only, never mutates runtime state.
 *
 * Cycle data source: state/improvement_reports.json, last N=20 cycles (configurable)
 * Block threshold:   configurable via selfImprovement.shadowPolicy.threshold (default: 0.10)
 *
 * Output schema (schemaVersion: 1):
 *   evaluatedAt        ISO timestamp
 *   sampleSize         number of usable cycles in the window
 *   baseline           { passRate: 0-1, taskCount: number } | null
 *   projected          { passRate: 0-1, taskCount: number } | null
 *   delta              projected.passRate - baseline.passRate | null
 *   blocked            true when promotion must be blocked
 *   blockReason        SHADOW_BLOCK_REASON code | null
 *   confidence         "low" | "medium" | "high"
 *   status             "ok" | "blocked" | "degraded"
 *   degraded           true when cycle data cannot be read
 *   degradedReason     SHADOW_DEGRADED_REASON code | null
 *   policyConstraints  { pathViolations: [...], commandViolations: [...] }
 *   successCriteria    { minimumPassRate, maximumRegressionDelta, owner, definedAt }
 *
 * Validation distinguishes missing input (NO_CYCLE_DATA / NO_BASELINE) from
 * invalid input (INVALID_CYCLE_DATA) with deterministic reason codes.
 * No silent fallback: degraded state sets explicit status and degradedReason.
 */

import path from "node:path";
import { readJsonSafe } from "./fs_utils.js";
import { isProtectedPath, validateShellCommand } from "./policy_engine.js";

// ── Reason-code enums ─────────────────────────────────────────────────────────

/**
 * Machine-readable reason codes for shadow evaluation block decisions.
 *
 * PASS_RATE_REGRESSION          — projected pass rate dropped more than the configured threshold
 * COMMAND_CONSTRAINT_VIOLATION  — proposed change includes a command blocked by current policy
 * INSUFFICIENT_DATA             — zero usable cycles in the sample window
 */
export const SHADOW_BLOCK_REASON = Object.freeze({
  PASS_RATE_REGRESSION:         "PASS_RATE_REGRESSION",
  COMMAND_CONSTRAINT_VIOLATION: "COMMAND_CONSTRAINT_VIOLATION",
  INSUFFICIENT_DATA:            "INSUFFICIENT_DATA",
});

/**
 * Machine-readable reason codes for degraded shadow evaluation.
 *
 * NO_CYCLE_DATA       — improvement_reports.json not found (missing input / ENOENT)
 * INVALID_CYCLE_DATA  — file present but fails structure validation (invalid input)
 * NO_BASELINE         — file parseable but contains no cycles with totalPlans > 0
 */
export const SHADOW_DEGRADED_REASON = Object.freeze({
  NO_CYCLE_DATA:      "NO_CYCLE_DATA",
  INVALID_CYCLE_DATA: "INVALID_CYCLE_DATA",
  NO_BASELINE:        "NO_BASELINE",
});

/**
 * Reason codes for policy constraint violations recorded in policyConstraints.
 *
 * PATH_CONSTRAINT_VIOLATION     — proposed config path matches a currently-protected path
 *                                 Behavior: VALIDATE and LOG (does not auto-block)
 * COMMAND_CONSTRAINT_VIOLATION  — proposed command is blocked by current policy
 *                                 Behavior: REJECT (sets blocked=true)
 */
export const SHADOW_PATH_REASON = Object.freeze({
  PATH_CONSTRAINT_VIOLATION:    "PATH_CONSTRAINT_VIOLATION",
  COMMAND_CONSTRAINT_VIOLATION: "COMMAND_CONSTRAINT_VIOLATION",
});

/** Output status enum. */
export const SHADOW_STATUS = Object.freeze({
  OK:       "ok",
  BLOCKED:  "blocked",
  DEGRADED: "degraded",
});

/** Confidence level enum based on sample size. */
export const SHADOW_CONFIDENCE = Object.freeze({
  LOW:    "low",    // < 3 usable cycles
  MEDIUM: "medium", // 3 – 9 usable cycles
  HIGH:   "high",   // >= 10 usable cycles
});

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default regression threshold (10 % pass-rate drop blocks promotion). */
export const DEFAULT_SHADOW_THRESHOLD    = 0.10;

/** Default sample window (last N improvement reports). */
export const DEFAULT_SHADOW_CYCLE_WINDOW = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map sample size to a confidence label. */
function computeConfidence(sampleSize) {
  if (sampleSize <  3) return SHADOW_CONFIDENCE.LOW;
  if (sampleSize < 10) return SHADOW_CONFIDENCE.MEDIUM;
  return SHADOW_CONFIDENCE.HIGH;
}

/**
 * Compute baseline pass rate from improvement reports.
 * Only considers reports where totalPlans > 0.
 * Returns { passRate, taskCount, sampleSize } or null when no usable data.
 */
function computeBaseline(reports) {
  const usable = Array.isArray(reports)
    ? reports.filter(r => Number(r?.outcomes?.totalPlans) > 0)
    : [];
  if (usable.length === 0) return null;

  let totalCompleted = 0;
  let totalTasks     = 0;
  for (const r of usable) {
    totalCompleted += Number(r.outcomes.completedCount) || 0;
    totalTasks     += Number(r.outcomes.totalPlans)     || 0;
  }

  return {
    passRate:   totalTasks > 0 ? totalCompleted / totalTasks : 0,
    taskCount:  totalTasks,
    sampleSize: usable.length,
  };
}

/**
 * Estimate the pass-rate delta a single proposed change would produce.
 * Uses a conservative heuristic — only well-understood change types
 * receive a non-zero projection; all others are neutral.
 *
 * Heuristic rules:
 *   - timeout/retry increases → +0.02 (historically improves completion)
 *   - timeout/retry decreases → −0.02
 *   - new blockedCommands entry → −0.05 (may block previously passing tasks)
 */
function estimateChangeDelta(change) {
  if (!change || typeof change !== "object") return 0;

  if (change.type === "config") {
    const key    = String(change.path || "").toLowerCase();
    const isTimeoutOrRetry = key.includes("timeout") || key.includes("maxretries") || key.includes("pollinterval");
    if (isTimeoutOrRetry) {
      const oldVal = typeof change.oldValue === "number" ? change.oldValue : null;
      const newVal = typeof change.newValue === "number" ? change.newValue : null;
      if (oldVal !== null && newVal !== null) {
        return newVal > oldVal ? 0.02 : -0.02;
      }
    }
  }

  if (change.type === "blockedCommands") {
    return -0.05;
  }

  return 0;
}

// ── Main Evaluator ─────────────────────────────────────────────────────────────

/**
 * Run shadow evaluation for a proposed set of policy/config changes.
 *
 * Proposed change object schema:
 *   {
 *     type:      "config" | "blockedCommands" | "protectedPaths" | "rolePolicies"
 *     path?:     string   — config key path (for type="config")
 *     command?:  string   — shell command text (for type="blockedCommands")
 *     oldValue?: any      — current value (for type="config" delta estimation)
 *     newValue?: any      — proposed value (for type="config" delta estimation)
 *   }
 *
 * @param {object}   currentPolicy    The currently loaded policy object.
 * @param {object[]} proposedChanges  Array of proposed changes to evaluate.
 * @param {object}   [options]
 * @param {string}   [options.stateDir="state"]      Path to state directory.
 * @param {number}   [options.threshold=0.10]        Regression threshold (0–1).
 * @param {number}   [options.cycleWindow=20]        Max cycles to sample.
 * @param {string}   [options.owner="self-improvement"] Owner for success criteria.
 * @returns {Promise<object>} Shadow evaluation result (schemaVersion: 1).
 */
export async function runShadowEvaluation(currentPolicy, proposedChanges, options: any = {}) {
  const stateDir    = options.stateDir    || "state";
  const threshold   = typeof options.threshold   === "number" ? options.threshold   : DEFAULT_SHADOW_THRESHOLD;
  const cycleWindow = typeof options.cycleWindow === "number" ? options.cycleWindow : DEFAULT_SHADOW_CYCLE_WINDOW;
  const owner       = options.owner               || "self-improvement";

  // ── 1. Load cycle history ──────────────────────────────────────────────────
  const reportsResult = await readJsonSafe(path.join(stateDir, "improvement_reports.json"));

  let degraded       = false;
  let degradedReason = null;
  let reports        = [];

  if (!reportsResult.ok) {
    // Missing input (ENOENT) and parse errors both reach here; use reason to distinguish.
    degraded       = true;
    degradedReason = SHADOW_DEGRADED_REASON.NO_CYCLE_DATA;
  } else if (!Array.isArray(reportsResult.data?.reports)) {
    // File present but structure is invalid.
    degraded       = true;
    degradedReason = SHADOW_DEGRADED_REASON.INVALID_CYCLE_DATA;
  } else {
    reports = reportsResult.data.reports.slice(-cycleWindow);
  }

  // ── 2. Compute baseline pass rate ──────────────────────────────────────────
  const baseline   = degraded ? null : computeBaseline(reports);
  const sampleSize = degraded ? 0    : (baseline?.sampleSize ?? 0);
  const confidence = computeConfidence(sampleSize);

  // NO_BASELINE: cycles present but none have totalPlans>0 (distinct from missing file).
  // An empty reports array (no history at all) is handled by INSUFFICIENT_DATA below.
  if (!degraded && baseline === null && reports.length > 0) {
    degraded       = true;
    degradedReason = SHADOW_DEGRADED_REASON.NO_BASELINE;
  }

  // ── 3. Validate proposed changes against current policy constraints ─────────
  const pathViolations    = [];
  const commandViolations = [];

  if (Array.isArray(proposedChanges)) {
    for (const change of proposedChanges) {
      // AC4 — PATH_CONSTRAINT_VIOLATION: validate and log (does NOT auto-block).
      if (change.type === "config" && change.path) {
        if (isProtectedPath(currentPolicy, change.path)) {
          pathViolations.push({
            path:   change.path,
            reason: SHADOW_PATH_REASON.PATH_CONSTRAINT_VIOLATION,
          });
        }
      }

      // AC4 — COMMAND_CONSTRAINT_VIOLATION: reject (blocks promotion).
      if (change.type === "blockedCommands" && change.command) {
        const cmdCheck = validateShellCommand(currentPolicy, change.command);
        if (!cmdCheck.ok) {
          commandViolations.push({
            command: change.command,
            reason:  SHADOW_PATH_REASON.COMMAND_CONSTRAINT_VIOLATION,
            detail:  cmdCheck.reason,
          });
        }
      }
    }
  }

  // ── 4. Compute projected pass rate (shadow simulation) ─────────────────────
  let projectedPassRateDelta = 0;

  if (!degraded && baseline !== null && Array.isArray(proposedChanges)) {
    for (const change of proposedChanges) {
      projectedPassRateDelta += estimateChangeDelta(change);
    }
  }

  const projectedPassRate = (!degraded && baseline !== null)
    ? Math.max(0, Math.min(1, baseline.passRate + projectedPassRateDelta))
    : null;

  const delta = (!degraded && baseline !== null && projectedPassRate !== null)
    ? projectedPassRate - baseline.passRate
    : null;

  // ── 5. Determine block status ──────────────────────────────────────────────
  let blocked     = false;
  let blockReason = null;

  if (commandViolations.length > 0) {
    // Command constraint violations always block (REJECT behavior).
    blocked     = true;
    blockReason = SHADOW_BLOCK_REASON.COMMAND_CONSTRAINT_VIOLATION;
  } else if (!degraded && sampleSize === 0) {
    // No usable cycle data — cannot evaluate safely.
    blocked     = true;
    blockReason = SHADOW_BLOCK_REASON.INSUFFICIENT_DATA;
  } else if (!degraded && delta !== null && delta < -threshold) {
    // Pass-rate regression exceeds configured threshold.
    blocked     = true;
    blockReason = SHADOW_BLOCK_REASON.PASS_RATE_REGRESSION;
  }

  // ── 6. Build success criteria ──────────────────────────────────────────────
  // AC5: explicit format — minimumPassRate, maximumRegressionDelta, owner, definedAt.
  const successCriteria = {
    minimumPassRate:        1 - threshold,
    maximumRegressionDelta: threshold,
    owner,
    definedAt: new Date().toISOString(),
  };

  // ── 7. Build result ────────────────────────────────────────────────────────
  const status = degraded  ? SHADOW_STATUS.DEGRADED
               : blocked   ? SHADOW_STATUS.BLOCKED
               : SHADOW_STATUS.OK;

  return {
    schemaVersion: 1,
    evaluatedAt:   new Date().toISOString(),
    sampleSize,
    baseline:      baseline  ? { passRate: baseline.passRate, taskCount: baseline.taskCount } : null,
    projected:     projectedPassRate !== null
                     ? { passRate: projectedPassRate, taskCount: baseline?.taskCount ?? 0 }
                     : null,
    delta,
    blocked,
    blockReason,
    confidence,
    status,
    degraded,
    degradedReason,
    policyConstraints: {
      pathViolations,
      commandViolations,
    },
    successCriteria,
  };
}
