/**
 * plan_critic.js — Internal critic for Prometheus dual-pass planning.
 *
 * Pass-A: Prometheus generates plans (existing flow).
 * Pass-B: This critic evaluates each plan against a rubric and flags issues.
 * Plans that fail the critic gate are demoted or removed before Athena review.
 *
 * This is NOT a replacement for Athena; it is a fast, deterministic pre-filter
 * that catches obvious plan deficiencies cheaply (no AI call).
 */
import { EQUAL_DIMENSION_SET, normalizeLeverageRank, MAX_ACCEPTANCE_CRITERIA_PER_TASK, MAX_FILES_IN_SCOPE_PER_TASK } from "./plan_contract_validator.js";

/**
 * Critic rubric dimensions. Each returns a 0-1 score.
 * @enum {string}
 */
export const CRITIC_DIMENSION = Object.freeze({
  HAS_MEASURABLE_AC:      "HAS_MEASURABLE_AC",
  HAS_VERIFICATION:       "HAS_VERIFICATION",
  HAS_CLEAR_SCOPE:        "HAS_CLEAR_SCOPE",
  HAS_DEPENDENCIES:       "HAS_DEPENDENCIES",
  NO_VAGUE_TASK:          "NO_VAGUE_TASK",
  REASONABLE_RISK:        "REASONABLE_RISK",
  HAS_LEVERAGE_RANK:      "HAS_LEVERAGE_RANK",
  BALANCED_DIMENSIONS:    "BALANCED_DIMENSIONS",
  CAPACITY_FIRST:         "CAPACITY_FIRST",
  NON_RIGID_PLAN:         "NON_RIGID_PLAN",
  IMPLEMENTATION_EVIDENCE: "IMPLEMENTATION_EVIDENCE",
  /** Hard-reject dimension: 0.0 when AC count > MAX or files > MAX; 1.0 otherwise. */
  PACKET_SIZE_COMPLIANT:  "PACKET_SIZE_COMPLIANT",
  /**
   * Topic-name-only drift detector: 0.0 when a plan's task/context only references
   * quarantined research topic names without concrete file or code evidence.
   * Catches low-signal plans that drifted from degraded-research-mode context.
   */
  NO_TOPIC_NAME_DRIFT:    "NO_TOPIC_NAME_DRIFT",
});

/** Minimum composite score to pass the critic gate (0-1 scale). */
export const CRITIC_PASS_THRESHOLD = 0.4;

/** Minimum AC richness score for Athena acceptance (Packet 9). */
export const AC_RICHNESS_THRESHOLD = 0.5;

const CRITIC_DIMENSION_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  [CRITIC_DIMENSION.CAPACITY_FIRST]: 2.4,
  [CRITIC_DIMENSION.BALANCED_DIMENSIONS]: 1.25,
  [CRITIC_DIMENSION.IMPLEMENTATION_EVIDENCE]: 1.2,
  [CRITIC_DIMENSION.PACKET_SIZE_COMPLIANT]: 1.1,
});

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function computeWeightedCriticScore(dimensions: Record<string, number>): number {
  const entries = Object.entries(dimensions);
  if (entries.length === 0) return 0;
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const [dimension, value] of entries) {
    const weight = CRITIC_DIMENSION_WEIGHTS[dimension] ?? 1;
    weightedTotal += value * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedTotal / totalWeight : 0;
}

function computePlanCapacityProfile(plan: any): number {
  const capacityDelta = Number(plan?.capacityDelta);
  const requestROI = Number(plan?.requestROI);
  if (!Number.isFinite(capacityDelta) || capacityDelta <= 0 || !Number.isFinite(requestROI) || requestROI <= 1) {
    return 0;
  }
  const capacitySignal = clamp01(capacityDelta / 0.25, 0);
  const roiSignal = clamp01((requestROI - 1) / 1.5, 0);
  return Math.round((((capacitySignal * 0.65) + (roiSignal * 0.35)) * 1000)) / 1000;
}

/**
 * Evaluate AC (acceptance criteria) richness for a plan.
 * Returns a 0-1 score based on quantity and quality of criteria.
 *
 * @param {object} plan
 * @returns {{ score: number, issues: string[], passed: boolean }}
 */
export function evaluateACRichness(plan) {
  if (!plan) return { score: 0, issues: ["Plan is null"], passed: false };

  const issues = [];
  let score = 0;

  const ac = Array.isArray(plan.acceptance_criteria) ? plan.acceptance_criteria : [];
  const verification = String(plan.verification || "").trim();

  // Score based on AC array population
  if (ac.length === 0) {
    issues.push("acceptance_criteria array is empty");
  } else if (ac.length === 1) {
    score += 0.3;
    issues.push("Only 1 acceptance criterion — should have ≥2 measurable conditions");
  } else {
    score += 0.5;
  }

  // Score based on verification command presence
  if (/npm\s+test|npm\s+run/.test(verification)) {
    score += 0.25;
  } else if (verification.length > 20) {
    score += 0.1;
  } else {
    issues.push("No concrete verification command (npm test/npm run)");
  }

  // Score based on measurability keywords in AC
  const measurable = ac.some(c => /pass|fail|assert|count|exist|contain|match|output|exit/i.test(c));
  if (measurable) {
    score += 0.25;
  } else if (ac.length > 0) {
    issues.push("Acceptance criteria lack measurable keywords (pass/fail/assert/exist/count)");
  }

  return { score: Math.min(1, Math.round(score * 100) / 100), issues, passed: score >= AC_RICHNESS_THRESHOLD };
}

/**
 * @typedef {object} CriticResult
 * @property {boolean} passed — whether the plan passed the critic gate
 * @property {number} score — composite score 0-1
 * @property {object} dimensions — per-dimension scores
 * @property {string[]} issues — list of identified issues
 */

/**
 * Evaluate a single plan against the critic rubric.
 *
 * @param {object} plan — normalized plan object
 * @returns {CriticResult}
 */
export function critiquePlan(plan) {
  if (!plan || typeof plan !== "object") {
    return { passed: false, score: 0, dimensions: {}, issues: ["Plan is null or invalid"] };
  }

  const issues = [];
  const dimensions: Record<string, any> = {};

  // 1. Measurable acceptance criteria
  const verification = String(plan.verification || plan.acceptanceCriteria || "").trim();
  const hasAC = verification.length > 10;
  dimensions[CRITIC_DIMENSION.HAS_MEASURABLE_AC] = hasAC ? 1.0 : 0.0;
  if (!hasAC) issues.push("Missing or too-short acceptance criteria / verification");

  // 2. Verification command present
  const hasVerification = /npm\s+test|npm\s+run|node\s+--test|npx\s+/.test(verification);
  dimensions[CRITIC_DIMENSION.HAS_VERIFICATION] = hasVerification ? 1.0 : (verification.length > 20 ? 0.5 : 0.0);
  if (!hasVerification && verification.length <= 20) issues.push("No concrete verification command");

  // 3. Clear scope (files, module, or component mentioned)
  const task = String(plan.task || "").trim();
  const context = String(plan.context || "").trim();
  const scopeText = `${task} ${context}`;
  const hasScope = /\.(js|ts|json|md|yml|yaml)\b/.test(scopeText) || /src\/|tests\/|config/.test(scopeText);
  dimensions[CRITIC_DIMENSION.HAS_CLEAR_SCOPE] = hasScope ? 1.0 : 0.0;
  if (!hasScope) issues.push("No specific files or modules referenced in scope");

  // 4. Dependencies declared (bonus, not penalized if absent)
  const hasDeps = Array.isArray(plan.dependencies) && plan.dependencies.length > 0;
  dimensions[CRITIC_DIMENSION.HAS_DEPENDENCIES] = hasDeps ? 1.0 : 0.5;

  // 5. Vague task detection
  const vaguePatterns = /improve|enhance|optimize|refactor|clean up|look into|investigate/i;
  const isVague = vaguePatterns.test(task) && task.length < 40;
  dimensions[CRITIC_DIMENSION.NO_VAGUE_TASK] = isVague ? 0.0 : 1.0;
  if (isVague) issues.push(`Task appears vague: "${task.slice(0, 60)}"`);

  // 6. Risk assessment
  const riskLevel = String(plan.riskLevel || "").toLowerCase();
  const hasRisk = riskLevel.length > 0;
  dimensions[CRITIC_DIMENSION.REASONABLE_RISK] = hasRisk ? 1.0 : 0.5;

  // 7. Leverage rank — plans must declare which capacity dimension(s) they improve.
  // Non-empty leverage_rank signals the plan was intentionally ranked against alternatives.
  const leverageRank = normalizeLeverageRank(plan.leverage_rank);
  const hasLeverageRank = leverageRank.length > 0;
  dimensions[CRITIC_DIMENSION.HAS_LEVERAGE_RANK] = hasLeverageRank ? 1.0 : 0.3;
  if (!hasLeverageRank) {
    issues.push("leverage_rank is empty — plan should declare which capacity dimension(s) it improves");
  }

  // 8. Balanced dimensions (normalized leverage rank must map to the canonical 10-dim set)
  const balanceRatio = leverageRank.length > 0
    ? Math.min(1, leverageRank.length / Math.max(1, EQUAL_DIMENSION_SET.length))
    : 0;
  dimensions[CRITIC_DIMENSION.BALANCED_DIMENSIONS] = Math.round(balanceRatio * 100) / 100;
  if (leverageRank.length === 0) {
    issues.push("No canonical dimension mapping in leverage_rank");
  }

  // 9. Capacity-first justification: must include positive capacityDelta and positive requestROI
  const capacityDelta = Number(plan.capacityDelta);
  const requestROI = Number(plan.requestROI);
  const hasCapacityFirst = Number.isFinite(capacityDelta) && capacityDelta > 0
    && Number.isFinite(requestROI) && requestROI > 1;
  dimensions[CRITIC_DIMENSION.CAPACITY_FIRST] = hasCapacityFirst ? 1.0 : 0.0;
  if (!hasCapacityFirst) {
    issues.push("capacity-first justification missing or weak (capacityDelta>0 and requestROI>1 required)");
  }

  // 10. Rigidity detection: penalize defensive-only recommendations
  const planText = `${String(plan.task || "")} ${String(plan.scope || "")} ${String(plan.before_state || "")} ${String(plan.after_state || "")}`.toLowerCase();
  const defensiveOnly = /(?:ban|block|forbid|deny|freeze|prevent|guardrail|lockdown|hard[- ]?gate)/.test(planText)
    && !/(?:implement|build|add|create|refactor|optimi[sz]e|improve|automate|ship|wire)/.test(planText);
  dimensions[CRITIC_DIMENSION.NON_RIGID_PLAN] = defensiveOnly ? 0.0 : 1.0;
  if (defensiveOnly) {
    issues.push("Task appears defensive-only/rigid without capacity-building implementation detail");
  }

  const implementationStatus = String(plan.implementationStatus || "").toLowerCase();
  const lowLeverageOrRedundant = (Array.isArray(plan.leverage_rank) && leverageRank.length < 2)
    || ["implemented", "implemented_correctly", "already_implemented", "completed", "complete"].includes(implementationStatus)
    || /\balready\b|\bredundant\b|\bduplicate\b|\bno-op\b/.test(planText);
  const implementationEvidence = Array.isArray(plan.implementationEvidence) ? plan.implementationEvidence : [];
  const hasImplementationEvidence = implementationEvidence.some(entry => String(entry || "").trim().length > 0);
  dimensions[CRITIC_DIMENSION.IMPLEMENTATION_EVIDENCE] = lowLeverageOrRedundant
    ? (hasImplementationEvidence && hasCapacityFirst ? 1.0 : 0.0)
    : 1.0;
  if (lowLeverageOrRedundant && !hasImplementationEvidence) {
    issues.push("low-leverage/redundant packet missing implementationEvidence");
  }
  if (lowLeverageOrRedundant && !hasCapacityFirst) {
    issues.push("low-leverage/redundant packet missing measurable capacity-first justification");
  }

  // 12. Packet size compliance: hard-reject when AC or file count exceeds contractual caps.
  // This mirrors the CRITICAL violation in plan_contract_validator (TASK_TOO_LARGE) and
  // ensures oversized packets are demoted by the critic even before contract validation runs.
  const acCount = Array.isArray(plan.acceptance_criteria) ? plan.acceptance_criteria.length : 0;
  const fileCount = Array.isArray(plan.target_files)
    ? plan.target_files.length
    : (Array.isArray(plan.filesInScope) ? plan.filesInScope.length : 0);
  const isOversized = acCount > MAX_ACCEPTANCE_CRITERIA_PER_TASK || fileCount > MAX_FILES_IN_SCOPE_PER_TASK;
  dimensions[CRITIC_DIMENSION.PACKET_SIZE_COMPLIANT] = isOversized ? 0.0 : 1.0;
  if (acCount > MAX_ACCEPTANCE_CRITERIA_PER_TASK) {
    issues.push(`Oversized packet: ${acCount} acceptance criteria exceeds max (${MAX_ACCEPTANCE_CRITERIA_PER_TASK}) — must decompose`);
  }
  if (fileCount > MAX_FILES_IN_SCOPE_PER_TASK) {
    issues.push(`Oversized packet: ${fileCount} files in scope exceeds max (${MAX_FILES_IN_SCOPE_PER_TASK}) — must decompose`);
  }

  // 13. Topic-name-only drift detection: catches plans that were generated from a
  // degraded-planning-mode context and only reference quarantined research topic names
  // without concrete file/code evidence.  A plan is flagged when its combined text
  // heavily signals "research topic" framing without any repository-concrete anchors.
  const driftText = `${task} ${context} ${String(plan.scope || "")}`;
  // Evidence anchors: file extensions, src/ paths, test commands, function-call syntax
  const hasConcreteEvidence = /\.(ts|js|json|md|yml|yaml)\b/.test(driftText)
    || /src\/|tests\/|state\/|scripts\//.test(driftText)
    || /npm\s+(test|run)|node\s+--|npx\s+/.test(driftText)
    || /\b\w+\(/.test(driftText);
  // Topic-name framing: research-mode phrases indicating topic-name sourcing
  const topicNameFraming = (
    (driftText.match(/\bresearch\b/gi) || []).length >= 2
    || /research completed on|failed density|topic names? as|all topics/i.test(driftText)
    || /degraded planning mode/i.test(driftText)
  );
  const hasTopicNameDrift = topicNameFraming && !hasConcreteEvidence;
  dimensions[CRITIC_DIMENSION.NO_TOPIC_NAME_DRIFT] = hasTopicNameDrift ? 0.0 : 1.0;
  if (hasTopicNameDrift) {
    issues.push("Task appears to be derived from low-signal research topic names without concrete repository evidence — must anchor to specific files or tests");
  }

  // Composite score (capacity-first weighted)
  const score = computeWeightedCriticScore(dimensions);

  return {
    passed: score >= CRITIC_PASS_THRESHOLD,
    score: Math.round(score * 100) / 100,
    dimensions,
    issues
  };
}

/**
 * Run the critic pass on all plans (Pass-B of dual-pass planning).
 *
 * @param {object[]} plans — array of normalized plan objects
 * @param {{ threshold?: number }} opts
 * @returns {{ approved: object[], rejected: object[], results: CriticResult[] }}
 */
export function runCriticPass(plans, opts: any = {}) {
  if (!Array.isArray(plans)) return { approved: [], rejected: [], results: [] };

  const threshold = opts.threshold || CRITIC_PASS_THRESHOLD;
  const approved = [];
  const rejected = [];
  const results = [];

  for (const plan of plans) {
    const result = critiquePlan(plan);
    results.push(result);

    if (result.score >= threshold) {
      approved.push(plan);
    } else {
      rejected.push(plan);
    }
  }

  return { approved, rejected, results };
}

/**
 * Repair a plan by enriching it with deterministic fixes for critic issues (Packet 7).
 * This is the "repair" pass in generate→critic→repair.
 *
 * @param {object} plan — the plan to repair
 * @param {CriticResult} criticResult — critic output for this plan
 * @returns {{ plan: object, repaired: boolean, repairs: string[] }}
 */
export function repairPlan(plan, criticResult) {
  if (!plan || !criticResult) return { plan, repaired: false, repairs: [] };

  const repaired = { ...plan };
  const repairs = [];

  // Repair missing acceptance criteria
  if (criticResult.dimensions[CRITIC_DIMENSION.HAS_MEASURABLE_AC] < 1.0) {
    const task = String(plan.task || "").toLowerCase();
    const defaultAC = ["npm test passes with no new failures", "npm run lint passes with no new errors"];
    if (/fix|bug|error/.test(task)) defaultAC.push("Regression test confirms fix");
    if (/add|create|implement/.test(task)) defaultAC.push("Changed files covered by at least one test assertion");
    repaired.acceptance_criteria = Array.isArray(plan.acceptance_criteria) && plan.acceptance_criteria.length > 0
      ? plan.acceptance_criteria
      : defaultAC;
    repaired.verification = repaired.verification || defaultAC.join("\n");
    repairs.push("Added default acceptance criteria");
  }

  // Repair missing verification command
  if (criticResult.dimensions[CRITIC_DIMENSION.HAS_VERIFICATION] < 1.0) {
    const existing = String(repaired.verification || "").trim();
    if (!existing || existing.length <= 20) {
      repaired.verification = existing ? `${existing}\nnpm test` : "npm test";
      repairs.push("Added npm test as verification command");
    }
  }

  // Repair missing scope
  if (criticResult.dimensions[CRITIC_DIMENSION.HAS_CLEAR_SCOPE] < 1.0) {
    const task = String(plan.task || "");
    // Try to infer scope from task title
    const fileMatch = task.match(/(?:src|tests|scripts)\/[^\s,)]+/);
    if (fileMatch) {
      repaired.scope = fileMatch[0];
      repairs.push(`Inferred scope from task: ${fileMatch[0]}`);
    }
  }

  if (criticResult.dimensions[CRITIC_DIMENSION.CAPACITY_FIRST] < 1.0) {
    if (!Number.isFinite(Number(repaired.capacityDelta)) || Number(repaired.capacityDelta) <= 0) {
      repaired.capacityDelta = 0.1;
    }
    if (!Number.isFinite(Number(repaired.requestROI)) || Number(repaired.requestROI) <= 1) {
      repaired.requestROI = 1.2;
    }
    repairs.push("Added capacity-first scoring fields");
  }

  return { plan: repaired, repaired: repairs.length > 0, repairs };
}

/**
 * Score a candidate set (array of plans) as a single aggregate.
 *
 * Aggregates `critiquePlan` scores across all plans and returns:
 *   - setScore: mean critic score across the candidate set (0–1)
 *   - dimensionCoverage: fraction of distinct CRITIC_DIMENSION keys that have ≥1 plan scoring 1.0
 *   - planCount: number of plans in the candidate set
 *
 * @param {object[]} plans - candidate plan set to score
 * @returns {{ setScore: number, dimensionCoverage: number, planCount: number }}
 */
export function scoreCandidateSet(plans: object[]): {
  setScore: number;
  dimensionCoverage: number;
  planCount: number;
  capacityScore: number;
} {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { setScore: 0, dimensionCoverage: 0, planCount: 0, capacityScore: 0 };
  }
  const results = plans.map(p => critiquePlan(p));
  const totalScore = results.reduce((acc, r) => acc + r.score, 0);
  const setScore = Math.round((totalScore / results.length) * 1000) / 1000;
  const capacityScore = Math.round(
    (plans.reduce((sum, plan) => sum + computePlanCapacityProfile(plan), 0) / plans.length) * 1000
  ) / 1000;

  // Dimension coverage: fraction of CRITIC_DIMENSION keys that have at least one plan scoring 1.0
  const allDimKeys = Object.values(CRITIC_DIMENSION);
  const coveredDims = allDimKeys.filter(dimKey =>
    results.some(r => r.dimensions[dimKey] === 1.0)
  );
  const dimensionCoverage = allDimKeys.length > 0
    ? Math.round((coveredDims.length / allDimKeys.length) * 1000) / 1000
    : 0;

  return { setScore, dimensionCoverage, planCount: plans.length, capacityScore };
}

export interface CandidateSetGateMetrics {
  contractPassRate?: number;
  viablePlanCount?: number;
  freshnessPenalty?: number;
  allPlansBlocked?: boolean;
}

export interface CandidateSetScore {
  setScore: number;
  dimensionCoverage: number;
  planCount: number;
  capacityScore: number;
  contractPassRate: number;
  viableRatio: number;
  freshnessPenalty: number;
  allPlansBlocked: boolean;
  effectiveScore: number;
}

export function scoreCandidateSetWithGates(
  plans: object[],
  gateMetrics: CandidateSetGateMetrics = {},
): CandidateSetScore {
  const base = scoreCandidateSet(plans);
  if (base.planCount === 0) {
    return {
      ...base,
      contractPassRate: 0,
      viableRatio: 0,
      freshnessPenalty: 1,
      allPlansBlocked: true,
      effectiveScore: 0,
    };
  }

  const contractPassRate = clamp01(Number(gateMetrics.contractPassRate), 1);
  const viablePlanCount = Number.isFinite(Number(gateMetrics.viablePlanCount))
    ? Math.max(0, Math.min(base.planCount, Math.floor(Number(gateMetrics.viablePlanCount))))
    : base.planCount;
  const viableRatio = clamp01(viablePlanCount / Math.max(1, base.planCount), 1);
  const freshnessPenalty = clamp01(Number(gateMetrics.freshnessPenalty), 0);
  const allPlansBlocked = gateMetrics.allPlansBlocked === true || viablePlanCount === 0 || contractPassRate === 0;
  if (allPlansBlocked) {
    return {
      ...base,
      contractPassRate,
      viableRatio,
      freshnessPenalty,
      allPlansBlocked: true,
      effectiveScore: 0,
    };
  }
  const gateMultiplier = 0.6 + (contractPassRate * 0.2) + (viableRatio * 0.2);
  const capacityMultiplier = 0.55 + (base.capacityScore * 0.45);
  const effectiveScore = Math.round(
    Math.max(0, Math.min(1, base.setScore * gateMultiplier * capacityMultiplier * (1 - freshnessPenalty))) * 1000
  ) / 1000;

  return {
    ...base,
    contractPassRate,
    viableRatio,
    freshnessPenalty,
    allPlansBlocked,
    effectiveScore,
  };
}

/**
 * Score differential below which two candidate sets are treated as tied.
 * When candidates are within this threshold, uncertainty-aware tie-breaks apply.
 */
export const CANDIDATE_TIE_THRESHOLD = 0.05 as const;

/**
 * Maximum number of candidate sets to evaluate in selectBestCandidateSet.
 * Bounds the cost of candidate comparison to prevent O(n) plan-critic loops.
 */
export const MAX_CANDIDATE_SETS = 5 as const;

/**
 * Select the best candidate plan set from multiple alternatives using rubric scoring
 * and uncertainty-aware tie-breaks.
 *
 * Selection algorithm:
 *   1. Score each candidate set via scoreCandidateSet (bounded to MAX_CANDIDATE_SETS).
 *   2. Rank by setScore descending.
 *   3. When the top two candidates are within CANDIDATE_TIE_THRESHOLD:
 *        - Prefer higher dimensionCoverage (broader quality signal).
 *        - If still tied, prefer fewer plans (lower blast radius).
 *        - If still tied, use the original order (stable, first-found wins).
 *   4. Return the winning set with selection metadata.
 *
 * @param candidates - array of candidate plan sets (each set is an array of plans)
 * @param opts - optional { threshold?: number } to override tie-break threshold
 * @returns {{ bestCandidates: object[], rank: number, score: number, tieBreakUsed: boolean, reason: string }}
 */
export function selectBestCandidateSet(
  candidates: object[][],
  opts: {
    threshold?: number;
    gateMetricsByCandidate?: CandidateSetGateMetrics[];
  } = {},
): {
  bestCandidates: object[];
  rank: number;
  score: number;
  tieBreakUsed: boolean;
  reason: string;
} {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { bestCandidates: [], rank: 0, score: 0, tieBreakUsed: false, reason: "no_candidates" };
  }

  const bounded = candidates.slice(0, MAX_CANDIDATE_SETS);
  const tieThreshold = typeof opts.threshold === "number" ? opts.threshold : CANDIDATE_TIE_THRESHOLD;
  const gateMetricsByCandidate = Array.isArray(opts.gateMetricsByCandidate) ? opts.gateMetricsByCandidate : [];

  const scored = bounded.map((set, idx) => ({
    set,
    idx,
    ...scoreCandidateSetWithGates(Array.isArray(set) ? set : [], gateMetricsByCandidate[idx]),
  }));

  // Primary sort: effectiveScore descending.
  scored.sort((a, b) => {
    if (a.allPlansBlocked !== b.allPlansBlocked) return a.allPlansBlocked ? 1 : -1;
    if (b.effectiveScore !== a.effectiveScore) return b.effectiveScore - a.effectiveScore;
    // Tie-break 1: higher capacity profile
    if (b.capacityScore !== a.capacityScore) return b.capacityScore - a.capacityScore;
    // Tie-break 2: higher contract pass rate
    if (b.contractPassRate !== a.contractPassRate) return b.contractPassRate - a.contractPassRate;
    // Tie-break 3: higher viable ratio
    if (b.viableRatio !== a.viableRatio) return b.viableRatio - a.viableRatio;
    // Tie-break 4: higher dimensionCoverage
    if (b.dimensionCoverage !== a.dimensionCoverage) return b.dimensionCoverage - a.dimensionCoverage;
    // Tie-break 5: lower freshness penalty
    if (a.freshnessPenalty !== b.freshnessPenalty) return a.freshnessPenalty - b.freshnessPenalty;
    // Tie-break 6: fewer plans (lower blast radius)
    if (a.planCount !== b.planCount) return a.planCount - b.planCount;
    // Tie-break 7: original index (stable)
    return a.idx - b.idx;
  });

  const best = scored[0];
  const second = scored[1];

  const tieBreakUsed = second !== undefined && Math.abs(best.effectiveScore - second.effectiveScore) <= tieThreshold;

  const reason = best.allPlansBlocked
    ? "all_candidates_blocked"
    : tieBreakUsed
    ? `tie_break_applied: effective_score_within_${tieThreshold}_contract_${best.contractPassRate}_coverage_${best.dimensionCoverage}`
    : `clear_winner: score=${best.effectiveScore}`;

  return {
    bestCandidates: Array.isArray(best.set) ? best.set : [],
    rank: best.idx,
    score: best.effectiveScore,
    tieBreakUsed,
    reason,
  };
}

/**
 * Full dual-pass: run critic on all plans, repair rejected ones, re-evaluate.
 *
 * @param {object[]} plans
 * @param {{ threshold?: number }} opts
 * @returns {{ plans: object[], repairCount: number, finalApproved: number, finalRejected: number, results: CriticResult[] }}
 */
export function dualPassCriticRepair(plans, opts: any = {}) {
  if (!Array.isArray(plans)) return { plans: [], repairCount: 0, finalApproved: 0, finalRejected: 0, results: [] };

  const threshold = opts.threshold || CRITIC_PASS_THRESHOLD;
  const firstPass = runCriticPass(plans, { threshold });

  // Repair rejected plans
  let repairCount = 0;
  const repairedPlans = [];

  for (let i = 0; i < plans.length; i++) {
    const result = firstPass.results[i];
    if (result.score >= threshold) {
      repairedPlans.push({ ...plans[i], _criticScore: result.score, _criticIssues: result.issues });
    } else {
      const { plan: fixedPlan, repaired, repairs } = repairPlan(plans[i], result);
      if (repaired) repairCount++;
      const reResult = critiquePlan(fixedPlan);
      repairedPlans.push({ ...fixedPlan, _criticScore: reResult.score, _criticIssues: reResult.issues, _repairs: repairs });
    }
  }

  // Final pass to classify
  const finalResults = repairedPlans.map(p => critiquePlan(p));
  const finalApproved = finalResults.filter(r => r.score >= threshold).length;
  const finalRejected = finalResults.filter(r => r.score < threshold).length;

  return { plans: repairedPlans, repairCount, finalApproved, finalRejected, results: finalResults };
}
