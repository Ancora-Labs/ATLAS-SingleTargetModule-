import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";

/** Minimum remaining USD required to allow a Claude call. */
export const BUDGET_THRESHOLD_USD = 0.2;

/** Rolling window size for completion yield computation (number of recent dispatches). */
export const ROLLING_YIELD_WINDOW_SIZE = 10;

/**
 * Minimum number of dispatches required in the window before throttling fires.
 * Below this count there is not enough signal to throttle.
 */
export const ROLLING_YIELD_MIN_DISPATCHES = 3;

/**
 * Minimum acceptable rolling completion yield (0–1).
 * When the fraction of "done" outcomes in the window falls at or below this
 * threshold (and the window is large enough), dispatch is throttled to prevent
 * premium-request waste spirals.
 */
export const ROLLING_YIELD_THROTTLE_THRESHOLD = 0.2;

/**
 * Structured eligibility contract produced on every pre-dispatch budget
 * reconciliation.  Always emitted — even when the budget gate is not
 * configured — so callers have a uniform surface for observability and
 * policy decisions.
 */
export interface BudgetEligibilityContract {
  /** True when dispatch is allowed from a budget perspective. */
  eligible: boolean;
  /** Remaining USD at reconciliation time.  null when unconfigured or unreadable. */
  remainingUsd: number | null;
  /** The USD threshold below-or-equal to which dispatch is blocked. */
  thresholdUsd: number;
  /** ISO timestamp of when the check ran. */
  checkedAt: string;
  /**
   * Human-readable reason when not eligible, or a non-fatal error note
   * when a read error occurred (fail-open path).  null when eligible and
   * no errors.
   */
  reason: string | null;
  /** False when no budgetFile path is configured (unlimited / unconstrained). */
  configured: boolean;
}

export async function loadBudget(config) {
  return readJson(config.paths.budgetFile, {
    initialUsd: config.env.budgetUsd,
    remainingUsd: config.env.budgetUsd,
    claudeCalls: 0,
    workerRuns: 0,
    updatedAt: new Date().toISOString()
  });
}

export async function chargeBudget(config, patch) {
  const budget = await loadBudget(config);
  budget.remainingUsd = Math.max(0, Number((budget.remainingUsd - (patch.usd ?? 0)).toFixed(4)));
  budget.claudeCalls += patch.claudeCalls ?? 0;
  budget.workerRuns += patch.workerRuns ?? 0;
  budget.updatedAt = new Date().toISOString();
  await writeJson(config.paths.budgetFile, budget);
  return budget;
}

export function canUseClaude(budget) {
  return budget.remainingUsd > BUDGET_THRESHOLD_USD;
}

/**
 * Reconcile current budget state into a BudgetEligibilityContract.
 *
 * Always returns a contract object regardless of configuration or errors:
 *   - Unconfigured budget path  → eligible=true, configured=false
 *   - Budget above threshold    → eligible=true, configured=true
 *   - Budget at/below threshold → eligible=false, configured=true
 *   - Read error                → eligible=true (fail-open), reason carries the error
 */
/**
 * Rolling completion yield contract produced by computeRollingCompletionYield.
 *
 * Always emitted — even when the log is absent or unconfigured — so callers
 * have a uniform surface for observability and throttle decisions.
 */
export interface RollingYieldContract {
  /** True when dispatch should be throttled due to low completion yield. */
  throttled: boolean;
  /** Completion yield in [0, 1]; 0 when there are no entries in the window. */
  yield: number;
  /** Number of dispatch entries considered (capped at ROLLING_YIELD_WINDOW_SIZE). */
  windowSize: number;
  /** Count of "done" outcomes in the window. */
  completions: number;
  /** Total dispatch entries in the window. */
  dispatches: number;
  /** Threshold below-or-equal to which throttling fires. */
  threshold: number;
  /** Human-readable reason when throttled, null otherwise. */
  reason: string | null;
  /** ISO timestamp of when the check ran. */
  checkedAt: string;
  /** False when no log file exists (fail-open — new deployments have no history). */
  configured: boolean;
}

/**
 * Compute the rolling completion yield from the premium usage log and return a
 * RollingYieldContract that callers can act on for throttle decisions.
 *
 * Fail-open contract:
 *   - No log file / empty log  → throttled=false, configured=false
 *   - Too few entries           → throttled=false (ROLLING_YIELD_MIN_DISPATCHES not met)
 *   - yield > threshold         → throttled=false
 *   - yield <= threshold        → throttled=true
 *   - Read/parse error          → throttled=false (fail-open), reason carries error note
 *
 * @param config  BOX config object; reads stateDir from config.paths.stateDir
 * @param opts    { windowSize?, minDispatches?, threshold? } — override defaults for tests
 */
export async function computeRollingCompletionYield(config, opts: {
  windowSize?: number;
  minDispatches?: number;
  threshold?: number;
} = {}): Promise<RollingYieldContract> {
  const windowSize  = opts.windowSize   ?? ROLLING_YIELD_WINDOW_SIZE;
  const minDispatch = opts.minDispatches ?? ROLLING_YIELD_MIN_DISPATCHES;
  const threshold   = opts.threshold    ?? ROLLING_YIELD_THROTTLE_THRESHOLD;
  const checkedAt   = new Date().toISOString();

  const stateDir = config?.paths?.stateDir || "state";
  const logPath  = path.join(stateDir, "premium_usage_log.json");

  const isProductiveOutcome = (outcome: unknown): boolean => {
    const normalized = String(outcome || "").trim().toLowerCase();
    return normalized === "done" || normalized === "success" || normalized === "partial";
  };

  try {
    const raw = await readJson(logPath, null);
    if (!Array.isArray(raw)) {
      return { throttled: false, yield: 0, windowSize, completions: 0, dispatches: 0, threshold, reason: null, checkedAt, configured: false };
    }

    const window = raw.slice(-windowSize);
    const dispatches   = window.length;
    const completions  = window.filter((e: any) => isProductiveOutcome(e?.outcome)).length;
    const yieldRatio   = dispatches > 0 ? completions / dispatches : 0;

    if (dispatches < minDispatch) {
      // Not enough signal — fail-open to avoid blocking on a near-empty log.
      return { throttled: false, yield: yieldRatio, windowSize, completions, dispatches, threshold, reason: null, checkedAt, configured: true };
    }

    const throttled = yieldRatio <= threshold;
    return {
      throttled,
      yield: yieldRatio,
      windowSize,
      completions,
      dispatches,
      threshold,
      reason: throttled
        ? `rolling_yield_throttle:yield=${yieldRatio.toFixed(2)},completions=${completions}/${dispatches},threshold=${threshold}`
        : null,
      checkedAt,
      configured: true,
    };
  } catch (err) {
    // Fail-open: any read or parse error must never block legitimate dispatch.
    return {
      throttled: false,
      yield: 0,
      windowSize,
      completions: 0,
      dispatches: 0,
      threshold,
      reason: `rolling_yield_read_error:${String((err as any)?.message || err)}`,
      checkedAt,
      configured: false,
    };
  }
}

export async function reconcileBudgetEligibility(config): Promise<BudgetEligibilityContract> {
  const thresholdUsd = BUDGET_THRESHOLD_USD;
  const checkedAt = new Date().toISOString();

  if (!config?.paths?.budgetFile) {
    return { eligible: true, remainingUsd: null, thresholdUsd, checkedAt, reason: null, configured: false };
  }

  try {
    const budget = await loadBudget(config);
    const eligible = budget.remainingUsd > thresholdUsd;
    return {
      eligible,
      remainingUsd: budget.remainingUsd,
      thresholdUsd,
      checkedAt,
      reason: eligible ? null : `budget_exhausted:remainingUsd=${budget.remainingUsd}`,
      configured: true,
    };
  } catch (err) {
    // Fail-open: a corrupt or missing budget file must not halt legitimate work.
    return {
      eligible: true,
      remainingUsd: null,
      thresholdUsd,
      checkedAt,
      reason: `budget_read_error:${String(err?.message || err)}`,
      configured: true,
    };
  }
}
