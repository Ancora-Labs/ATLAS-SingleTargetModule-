/**
 * lesson_halflife.js — Time-decayed relevance scoring for postmortem lessons.
 *
 * Older lessons naturally lose relevance as the codebase evolves.
 * This module computes a relevance weight for each lesson based on its age,
 * so that Athena can prioritize recent learnings over stale ones.
 *
 * Formula: weight = 2^(-ageInDays / halfLifeDays)
 *   - age = 0     → weight = 1.0
 *   - age = half   → weight = 0.5
 *   - age = 2×half → weight = 0.25
 */

import {
  classifyLessonRetirementClass,
  isCarryForwardRetired,
  LESSON_RETIREMENT_CLASS,
} from "./carry_forward_ledger.js";

/** Default half-life in days. */
export const DEFAULT_HALF_LIFE_DAYS = 14;

/**
 * Compute the relevance weight of a lesson.
 *
 * @param {string|Date} reviewedAt — ISO timestamp of when the lesson was recorded
 * @param {{ halfLifeDays?: number, now?: number }} opts
 * @returns {number} weight in [0, 1]
 */
export function computeLessonWeight(reviewedAt, opts: any = {}) {
  if (!reviewedAt) return 0;

  const halfLife = opts.halfLifeDays || DEFAULT_HALF_LIFE_DAYS;
  const now = opts.now || Date.now();
  const ageMs = now - new Date(reviewedAt).getTime();
  if (ageMs <= 0) return 1.0;

  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return Math.pow(2, -ageDays / halfLife);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeSeverityImpact(value: unknown): number {
  const severity = String(value || "").toLowerCase().trim();
  if (severity === "critical") return 1.0;
  if (severity === "important" || severity === "warning" || severity === "high") return 0.8;
  if (severity === "medium") return 0.6;
  return 0.4;
}

function normalizeUnresolved(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (isCarryForwardRetired(entry)) return false;
  if (
    classifyLessonRetirementClass(entry) === LESSON_RETIREMENT_CLASS.CI
    && (entry.closedAt || entry.resolvedAt || entry.taskCompleted === true)
  ) {
    return true;
  }
  if (entry.followUpNeeded === true) return true;
  if (entry.closedAt || entry.resolvedAt) return false;
  const status = String(entry.status || "").toLowerCase().trim();
  return status === "open" || status === "pending" || status === "unresolved";
}

function pickLessonText(entry: any): string {
  return String(
    entry?.lessonLearned
    || entry?.lesson
    || entry?.followUpTask
    || entry?.summary
    || "",
  ).trim();
}

function pickReviewedAt(entry: any): string {
  return String(entry?.reviewedAt || entry?.addedAt || entry?.createdAt || "").trim();
}

function computeImpactScore(entry: any): number {
  const base = normalizeSeverityImpact(entry?.severity);
  const qualityScore = Number(entry?.qualityScore);
  const qualityPenalty = Number.isFinite(qualityScore)
    ? clamp01((10 - Math.max(0, Math.min(10, qualityScore))) / 10)
    : 0;
  const recurrence = Number(entry?.recurrenceCount);
  const recurrenceBoost = Number.isFinite(recurrence)
    ? clamp01(Math.max(0, recurrence - 1) / 4)
    : 0;
  return Math.round(clamp01((base * 0.7) + (qualityPenalty * 0.2) + (recurrenceBoost * 0.1)) * 1000) / 1000;
}

export type RankedLessonShortlistItem = {
  lesson: string;
  score: number;
  freshness: number;
  impact: number;
  unresolved: boolean;
  reviewedAt: string;
};

export function buildRankedLessonShortlists(
  entries: any[],
  opts: { limit?: number; halfLifeDays?: number; now?: number; unresolvedBoost?: number } = {},
): {
  recentTop10: RankedLessonShortlistItem[];
  highImpactTop10: RankedLessonShortlistItem[];
  unresolvedTop10: RankedLessonShortlistItem[];
  combinedTop10: RankedLessonShortlistItem[];
} {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { recentTop10: [], highImpactTop10: [], unresolvedTop10: [], combinedTop10: [] };
  }

  const limit = Math.max(1, Math.floor(Number(opts.limit) || 10));
  const unresolvedBoost = Number.isFinite(Number(opts.unresolvedBoost)) ? Number(opts.unresolvedBoost) : 0.25;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const scored: RankedLessonShortlistItem[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const lesson = pickLessonText(entry);
    if (lesson.length < 5) continue;
    const dedupeKey = lesson.toLowerCase().replace(/\s+/g, " ").trim();
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const reviewedAt = pickReviewedAt(entry);
    const freshness = computeLessonWeight(reviewedAt, { ...opts, now });
    const impact = computeImpactScore(entry);
    const unresolved = normalizeUnresolved(entry);
    const unresolvedFactor = unresolved ? (1 + unresolvedBoost) : 1;
    const rawScore = ((freshness * 0.6) + (impact * 0.4)) * unresolvedFactor;
    const score = Math.round(clamp01(rawScore) * 1000) / 1000;
    scored.push({ lesson, score, freshness: Math.round(freshness * 1000) / 1000, impact, unresolved, reviewedAt });
  }

  const byRecent = [...scored].sort((a, b) => {
    const aTs = Date.parse(a.reviewedAt || "");
    const bTs = Date.parse(b.reviewedAt || "");
    if (Number.isFinite(bTs) && Number.isFinite(aTs) && bTs !== aTs) return bTs - aTs;
    if (b.score !== a.score) return b.score - a.score;
    return a.lesson.localeCompare(b.lesson);
  });
  const byImpact = [...scored].sort((a, b) => {
    if (b.impact !== a.impact) return b.impact - a.impact;
    if (b.score !== a.score) return b.score - a.score;
    return a.lesson.localeCompare(b.lesson);
  });
  const byUnresolved = [...scored]
    .filter((item) => item.unresolved)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.impact !== a.impact) return b.impact - a.impact;
      return a.lesson.localeCompare(b.lesson);
    });

  const recentTop10 = byRecent.slice(0, limit);
  const highImpactTop10 = byImpact.slice(0, limit);
  const unresolvedTop10 = byUnresolved.slice(0, limit);
  const combinedTop10: RankedLessonShortlistItem[] = [];
  const combinedSeen = new Set<string>();
  for (const item of [...recentTop10, ...highImpactTop10, ...unresolvedTop10]) {
    const key = item.lesson.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || combinedSeen.has(key)) continue;
    combinedSeen.add(key);
    combinedTop10.push(item);
    if (combinedTop10.length >= limit) break;
  }

  return { recentTop10, highImpactTop10, unresolvedTop10, combinedTop10 };
}

/**
 * Rank postmortem lessons by time-decayed relevance.
 * Returns the top N lessons sorted by weight descending.
 *
 * @param {object[]} postmortems
 * @param {{ halfLifeDays?: number, now?: number, limit?: number }} opts
 * @returns {{ lesson: string, weight: number, reviewedAt: string }[]}
 */
export function rankLessonsByRelevance(postmortems, opts: any = {}) {
  if (!Array.isArray(postmortems)) return [];

  const limit = opts.limit || 10;
  const scored = [];

  for (const pm of postmortems) {
    const lesson = pm?.lessonLearned;
    if (!lesson || String(lesson).trim().length < 5) continue;

    const weight = computeLessonWeight(pm.reviewedAt, opts);
    scored.push({
      lesson: String(lesson).trim(),
      weight: Math.round(weight * 1000) / 1000,
      reviewedAt: pm.reviewedAt || ""
    });
  }

  scored.sort((a, b) => b.weight - a.weight);
  return scored.slice(0, limit);
}

// ── Curriculum-based learning promotion ───────────────────────────────────────

/**
 * Multiplier applied to lesson weight when the lesson overlaps with an active
 * research topic.  A boost > 1.0 accelerates research-confirmed lessons past
 * the promotion threshold faster than time-decayed-only scoring.
 */
export const CURRICULUM_WEIGHT_BOOST = 1.5;

/**
 * Minimum weight (after optional research-topic boost) for a lesson to be
 * promoted into the active curriculum for policy compilation.
 */
export const CURRICULUM_PROMOTION_THRESHOLD = 0.4;

/**
 * Compute a curriculum-adjusted weight for a lesson.
 *
 * If the lesson text overlaps with one of the provided research topic names
 * (case-insensitive substring match), the base weight is multiplied by
 * CURRICULUM_WEIGHT_BOOST, capped at 1.0.
 *
 * @param {string}   lessonText    — the lesson text
 * @param {number}   baseWeight    — weight from computeLessonWeight()
 * @param {string[]} researchTopics — active research topic names
 * @param {{ boost?: number }} opts
 * @returns {number} adjusted weight in [0, 1]
 */
export function computeCurriculumWeight(
  lessonText: string,
  baseWeight: number,
  researchTopics: string[],
  opts: { boost?: number } = {},
): number {
  if (!lessonText || typeof baseWeight !== "number") return baseWeight ?? 0;
  const boost = typeof opts.boost === "number" && opts.boost > 0 ? opts.boost : CURRICULUM_WEIGHT_BOOST;
  if (!Array.isArray(researchTopics) || researchTopics.length === 0) return baseWeight;

  const lessonLower = String(lessonText).toLowerCase();
  const isResearchBacked = researchTopics.some(topic => {
    const topicLower = String(topic || "").toLowerCase().trim();
    if (!topicLower) return false;
    return lessonLower.includes(topicLower) || topicLower.includes(lessonLower.slice(0, 40));
  });

  return isResearchBacked ? Math.min(1.0, baseWeight * boost) : baseWeight;
}

/**
 * Select lessons that have graduated to the active curriculum.
 *
 * A lesson is promoted when its curriculum-adjusted weight (base × optional
 * research-topic boost) meets or exceeds CURRICULUM_PROMOTION_THRESHOLD.
 * Returned items are sorted by weight descending and capped at `opts.limit`.
 *
 * @param {object[]} postmortems    — postmortem entries with lessonLearned and reviewedAt
 * @param {string[]} researchTopics — active research topic names for weight boost
 * @param {{ halfLifeDays?: number, now?: number, limit?: number, threshold?: number }} opts
 * @returns {{ lesson: string, weight: number, reviewedAt: string, researchBacked: boolean }[]}
 */
export function selectCurriculumItems(
  postmortems: any[],
  researchTopics: string[],
  opts: { halfLifeDays?: number; now?: number; limit?: number; threshold?: number } = {},
): Array<{ lesson: string; weight: number; reviewedAt: string; researchBacked: boolean }> {
  if (!Array.isArray(postmortems)) return [];

  const limit = opts.limit || 10;
  const threshold = typeof opts.threshold === "number" ? opts.threshold : CURRICULUM_PROMOTION_THRESHOLD;
  const items: Array<{ lesson: string; weight: number; reviewedAt: string; researchBacked: boolean }> = [];

  for (const pm of postmortems) {
    const lesson = pm?.lessonLearned;
    if (!lesson || String(lesson).trim().length < 5) continue;

    const baseWeight = computeLessonWeight(pm.reviewedAt, opts);
    const currWeight = computeCurriculumWeight(String(lesson), baseWeight, researchTopics || [], {});
    if (currWeight < threshold) continue;

    items.push({
      lesson: String(lesson).trim(),
      weight: Math.round(currWeight * 1000) / 1000,
      reviewedAt: pm.reviewedAt || "",
      researchBacked: currWeight > baseWeight,
    });
  }

  items.sort((a, b) => b.weight - a.weight);
  return items.slice(0, limit);
}

export function applyLessonDecayWindow(
  weight: number,
  inactiveCycles: number,
  opts: { decayPerCycle?: number } = {},
): number {
  const base = Number.isFinite(Number(weight)) ? Number(weight) : 0;
  const cycles = Math.max(0, Math.floor(Number(inactiveCycles) || 0));
  const decayPerCycle = Number.isFinite(Number(opts.decayPerCycle)) ? Number(opts.decayPerCycle) : 0.1;
  const factor = Math.max(0, 1 - (decayPerCycle * cycles));
  return Math.round(Math.max(0, Math.min(1, base * factor)) * 1000) / 1000;
}

/** Default half-life in cycles for policy impact decay. */
export const DEFAULT_POLICY_HALF_LIFE_CYCLES = 3;

/**
 * Compute a half-life decay weight using cycle count instead of wall-clock days.
 *
 * Formula: weight = 2^(-elapsedCycles / halfLifeCycles)
 *
 * @param {number} elapsedCycles
 * @param {{ halfLifeCycles?: number }} opts
 * @returns {number} weight in [0, 1]
 */
export function computeCycleHalfLifeWeight(
  elapsedCycles: number,
  opts: { halfLifeCycles?: number } = {},
): number {
  const cycles = Math.max(0, Number.isFinite(Number(elapsedCycles)) ? Number(elapsedCycles) : 0);
  const halfLifeCycles = Number.isFinite(Number(opts.halfLifeCycles)) && Number(opts.halfLifeCycles) > 0
    ? Number(opts.halfLifeCycles)
    : DEFAULT_POLICY_HALF_LIFE_CYCLES;
  if (cycles <= 0) return 1.0;
  const weight = Math.pow(2, -cycles / halfLifeCycles);
  return Math.round(Math.max(0, Math.min(1, weight)) * 1000) / 1000;
}

/**
 * Compute policy effectiveness after applying cycle half-life decay to the
 * observed improvement rate.
 *
 * @param {number} improvementRate - historical improvement ratio in [0, 1]
 * @param {number} inactiveCycles  - consecutive cycles without measurable improvement
 * @param {{ halfLifeCycles?: number }} opts
 * @returns {{ halfLifeWeight: number, decayedEffectiveness: number }}
 */
export function computeDecayedPolicyEffectiveness(
  improvementRate: number,
  inactiveCycles: number,
  opts: { halfLifeCycles?: number } = {},
): { halfLifeWeight: number; decayedEffectiveness: number } {
  const boundedImprovementRate = Math.max(
    0,
    Math.min(1, Number.isFinite(Number(improvementRate)) ? Number(improvementRate) : 0),
  );
  const halfLifeWeight = computeCycleHalfLifeWeight(inactiveCycles, opts);
  const decayedEffectiveness = Math.round(
    Math.max(0, Math.min(1, boundedImprovementRate * halfLifeWeight)) * 1000,
  ) / 1000;
  return { halfLifeWeight, decayedEffectiveness };
}

export const IMPACT_ATTRIBUTION_OUTCOME = Object.freeze({
  IMPROVED: "improved",
  NO_SIGNAL: "no_signal",
  SHOULD_RETIRE: "should_retire",
});

export interface ImpactAttributionWindowSignal {
  outcomeScore?: number | null;
  noSignalOutcome?: boolean | null;
  outcomeStatus?: string | null;
}

export interface ImpactAttributionWindowSummary {
  outcomeStatus: string;
  evidenceCount: number;
  improvedCount: number;
  noSignalCount: number;
  ineffectiveCount: number;
  averageOutcomeScore: number;
  evidenceWindowSatisfied: boolean;
  shouldRetire: boolean;
  reversible: boolean;
  retirementReason: string;
  reactivateWhen: string;
  reactivationThreshold: number;
  reactivationEvidenceWindow: number;
  reactivationSatisfied: boolean;
}

export function normalizeImpactAttributionOutcome(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (
    normalized === IMPACT_ATTRIBUTION_OUTCOME.IMPROVED
    || normalized === "improve"
    || normalized === "success"
    || normalized === "successful"
  ) {
    return IMPACT_ATTRIBUTION_OUTCOME.IMPROVED;
  }
  if (
    normalized === IMPACT_ATTRIBUTION_OUTCOME.NO_SIGNAL
    || normalized === "no-signal"
    || normalized === "unknown"
    || normalized === "hold"
    || normalized === "observed"
    || normalized === "noop"
    || normalized === "no-op"
  ) {
    return IMPACT_ATTRIBUTION_OUTCOME.NO_SIGNAL;
  }
  if (
    normalized === IMPACT_ATTRIBUTION_OUTCOME.SHOULD_RETIRE
    || normalized === "should-retire"
    || normalized === "retire"
    || normalized === "retired"
    || normalized === "low_yield"
    || normalized === "low-yield"
  ) {
    return IMPACT_ATTRIBUTION_OUTCOME.SHOULD_RETIRE;
  }
  return "";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function summarizeImpactAttributionWindow(
  records: ImpactAttributionWindowSignal[],
  opts: {
    minEvidenceWindow?: number;
    improvedThreshold?: number;
    retireThreshold?: number;
    reactivationEvidenceWindow?: number;
  } = {},
): ImpactAttributionWindowSummary {
  const minEvidenceWindow = Math.max(1, Math.floor(Number(opts.minEvidenceWindow) || 3));
  const improvedThreshold = clamp01(
    Number.isFinite(Number(opts.improvedThreshold)) ? Number(opts.improvedThreshold) : 0.55,
  );
  const retireThreshold = clamp01(
    Number.isFinite(Number(opts.retireThreshold))
      ? Number(opts.retireThreshold)
      : Math.max(0, improvedThreshold - 0.25),
  );
  const reactivationEvidenceWindow = Math.max(
    1,
    Math.floor(Number(opts.reactivationEvidenceWindow) || Math.min(2, minEvidenceWindow)),
  );
  const signals = Array.isArray(records)
    ? records.filter((record) => record && typeof record === "object")
    : [];
  const evidence = signals.slice(-Math.max(minEvidenceWindow, reactivationEvidenceWindow));

  let improvedCount = 0;
  let noSignalCount = 0;
  let ineffectiveCount = 0;
  let scoredCount = 0;
  let scoreTotal = 0;

  const classifiedSignals = evidence.map((record) => {
    const explicitStatus = normalizeImpactAttributionOutcome(record?.outcomeStatus);
    const boundedScore = Number.isFinite(Number(record?.outcomeScore))
      ? clamp01(Number(record?.outcomeScore))
      : null;
    const noSignalOutcome = record?.noSignalOutcome === true || explicitStatus === IMPACT_ATTRIBUTION_OUTCOME.NO_SIGNAL;
    let outcomeStatus = explicitStatus;
    if (!outcomeStatus) {
      if (noSignalOutcome) outcomeStatus = IMPACT_ATTRIBUTION_OUTCOME.NO_SIGNAL;
      else if (boundedScore !== null && boundedScore >= improvedThreshold) outcomeStatus = IMPACT_ATTRIBUTION_OUTCOME.IMPROVED;
      else if (boundedScore !== null && boundedScore <= retireThreshold) outcomeStatus = IMPACT_ATTRIBUTION_OUTCOME.SHOULD_RETIRE;
      else outcomeStatus = IMPACT_ATTRIBUTION_OUTCOME.NO_SIGNAL;
    }
    if (outcomeStatus === IMPACT_ATTRIBUTION_OUTCOME.IMPROVED) improvedCount += 1;
    else if (outcomeStatus === IMPACT_ATTRIBUTION_OUTCOME.NO_SIGNAL) noSignalCount += 1;
    else ineffectiveCount += 1;
    if (boundedScore !== null) {
      scoredCount += 1;
      scoreTotal += boundedScore;
    }
    return {
      outcomeStatus,
      outcomeScore: boundedScore,
    };
  });

  const evidenceCount = classifiedSignals.length;
  const averageOutcomeScore = scoredCount > 0 ? round3(scoreTotal / scoredCount) : 0;
  const evidenceWindowSatisfied = evidenceCount >= minEvidenceWindow;
  const shouldRetire = (
    evidenceWindowSatisfied
    && improvedCount === 0
    && ineffectiveCount > 0
    && averageOutcomeScore <= retireThreshold
  );
  const recentSignals = classifiedSignals.slice(-reactivationEvidenceWindow);
  const reactivationSatisfied = recentSignals.length >= reactivationEvidenceWindow
    && recentSignals.every((record) => record.outcomeStatus === IMPACT_ATTRIBUTION_OUTCOME.IMPROVED);
  const outcomeStatus = shouldRetire
    ? IMPACT_ATTRIBUTION_OUTCOME.SHOULD_RETIRE
    : improvedCount > 0
      ? IMPACT_ATTRIBUTION_OUTCOME.IMPROVED
      : IMPACT_ATTRIBUTION_OUTCOME.NO_SIGNAL;
  const retirementReason = shouldRetire
    ? `evidence_window_low_yield:${ineffectiveCount}/${evidenceCount}:avg=${averageOutcomeScore}`
    : outcomeStatus === IMPACT_ATTRIBUTION_OUTCOME.IMPROVED
      ? `observed_improvement:${improvedCount}/${evidenceCount}:avg=${averageOutcomeScore}`
      : `no_signal_window:${noSignalCount}/${evidenceCount}:avg=${averageOutcomeScore}`;

  return {
    outcomeStatus,
    evidenceCount,
    improvedCount,
    noSignalCount,
    ineffectiveCount,
    averageOutcomeScore,
    evidenceWindowSatisfied,
    shouldRetire,
    reversible: true,
    retirementReason,
    reactivateWhen: `record ${reactivationEvidenceWindow} improved evidence point(s) with average >= ${round3(improvedThreshold)}`,
    reactivationThreshold: round3(improvedThreshold),
    reactivationEvidenceWindow,
    reactivationSatisfied,
  };
}
