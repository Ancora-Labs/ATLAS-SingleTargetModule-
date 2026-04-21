/**
 * Governance Freeze Engine — T-040
 *
 * Implements year-end stabilization freeze window:
 *   - At month 12 (December) or when manually enabled, applies freeze mode that
 *     blocks high-risk autonomous changes unless a critical incident override is provided.
 *   - Critical incident overrides require explicit incidentId AND rationale (>= 20 chars).
 *   - Weekly stabilization metrics are tracked during freeze to state/freeze_weekly_metrics.json
 *   - Year-end report documents roadmap outcomes vs objectives to state/year_end_report.json
 *   - Next-year seed question generated from unresolved systemic gaps to state/next_year_seed.json
 *
 * Athena resolutions:
 *   C1 — 'high-risk' is now defined by FREEZE_HIGH_RISK_LEVELS enum and RISK_SCORE_THRESHOLDS
 *   C3 — weekly metrics schema defined with explicit metric names and persistence path
 *   C4 — year-end report schema defined with required fields, enums, and output path
 *   C5 — 'systemic gap' is defined (see SYSTEMIC_GAP_SEVERITY); output location is explicit
 *   Month-12 trigger — implemented as calendar check on governanceFreeze.monthTrigger (default 12)
 *   Risk level — this module is HIGH risk (simultaneous changes to 3 core components)
 *   Rollback criteria — freeze lifted via config switch; throughput collapse triggers auto-disable
 *
 * Risk: HIGH — gates autonomous changes across orchestrator, self-improvement, and policy engine.
 */

import path from "node:path";
import { readJson, readJsonSafe, writeJson, READ_JSON_REASON } from "./fs_utils.js";

// ── Risk Level Enum ───────────────────────────────────────────────────────────

/**
 * Freeze risk level enum.
 * Athena C1 resolved — explicit named values replace vague "high-risk" string.
 * @enum {string}
 */
export const FREEZE_RISK_LEVEL = Object.freeze({
  LOW:      "low",
  MEDIUM:   "medium",
  HIGH:     "high",
  CRITICAL: "critical"
});

/**
 * Numeric score thresholds that map to FREEZE_RISK_LEVEL values.
 * riskScore >= CRITICAL → CRITICAL; >= HIGH → HIGH; >= MEDIUM → MEDIUM; else LOW.
 * Athena C1 resolved — freeze predicate is now machine-testable.
 */
export const RISK_SCORE_THRESHOLDS = Object.freeze({
  LOW:      0.0,
  MEDIUM:   0.3,
  HIGH:     0.7,
  CRITICAL: 0.9
});

/**
 * Risk levels considered "high-risk" and blocked during freeze without a critical override.
 * Athena C1 resolved — enum replaces undefined string "high-risk".
 */
export const FREEZE_HIGH_RISK_LEVELS = Object.freeze(["high", "critical"]);

/**
 * Risk levels considered "non-critical" and allowed through the freeze gate without override.
 * Athena C1 resolved — enum replaces undefined string "non-critical".
 */
export const FREEZE_NON_CRITICAL_LEVELS = Object.freeze(["low", "medium"]);

// ── Freeze Gate Result Enum ───────────────────────────────────────────────────

/**
 * Result codes returned by evaluateFreezeGate.
 * @enum {string}
 */
export const FREEZE_GATE_RESULT = Object.freeze({
  ALLOWED:          "allowed",
  BLOCKED:          "blocked",
  NOT_ACTIVE:       "not_active"
});

// ── Systemic Gap Severity Enum ────────────────────────────────────────────────

/**
 * Severity levels for systemic gaps.
 * Athena C5 resolved — 'systemic gap' is now explicitly typed.
 * @enum {string}
 */
export const SYSTEMIC_GAP_SEVERITY = Object.freeze({
  CRITICAL: "critical",
  HIGH:     "high",
  MEDIUM:   "medium",
  LOW:      "low"
});

// ── Schema Definitions ────────────────────────────────────────────────────────

/**
 * Schema for weekly freeze metrics persisted to state/freeze_weekly_metrics.json.
 * Athena C3 resolved — metric names, persistence path, and required fields are explicit.
 */
export const FREEZE_WEEKLY_METRICS_SCHEMA = Object.freeze({
  schemaVersion: 1,
  outputPath:    "freeze_weekly_metrics.json",

  /**
   * Named metric fields tracked in every weekly snapshot.
   * Athena C3 resolved — metric names are explicit and machine-verifiable.
   */
  metricNames: Object.freeze([
    "cyclesBlocked",    // count of cycles blocked by the freeze gate this week
    "cyclesAllowed",    // count of cycles allowed through the freeze gate this week
    "overrides",        // count of critical incident overrides granted this week
    "throughputRatio"   // cyclesAllowed / (cyclesBlocked + cyclesAllowed), null if no data
  ]),

  required: Object.freeze([
    "schemaVersion", "weekKey", "recordedAt", "freezeActive",
    "cyclesBlocked", "cyclesAllowed", "overrides", "throughputRatio"
  ]),

  /** Format: "YYYY-WNN" (ISO week number, e.g. "2026-W52") */
  weekKeyFormat: "YYYY-WNN"
});

/**
 * Schema for the year-end report persisted to state/year_end_report.json.
 * Athena C4 resolved — output path, required fields, and enums are all explicit.
 */
export const YEAR_END_REPORT_SCHEMA = Object.freeze({
  schemaVersion:  1,
  outputPath:     "year_end_report.json",

  required: Object.freeze([
    "schemaVersion", "year", "generatedAt", "status",
    "roadmapObjectives", "roadmapOutcomes", "objectivesVsOutcomes",
    "unresolvedGaps", "freezeMetricsSummary"
  ]),

  statusEnum:          Object.freeze(["ok", "insufficient_data", "degraded"]),
  objectiveStatusEnum: Object.freeze(["met", "partial", "missed", "deferred"]),

  /** Required fields on each objectivesVsOutcomes entry. */
  objectiveEntryRequired: Object.freeze([
    "objectiveId", "objective", "outcome", "status"
  ])
});

/**
 * Schema for the next-year seed question persisted to state/next_year_seed.json.
 * Athena C5 resolved — 'systemic gap' is defined, output location is explicit.
 */
export const NEXT_YEAR_SEED_SCHEMA = Object.freeze({
  schemaVersion: 1,
  outputPath:    "next_year_seed.json",

  required: Object.freeze([
    "schemaVersion", "year", "generatedAt",
    "seedQuestion", "unresolvedGapsCount", "topGap"
  ]),

  /** Required fields on the seedQuestion sub-object. */
  seedQuestionRequired: Object.freeze(["question", "rationale", "dataPoints"]),

  /** Required fields on each systemic gap entry (topGap and unresolvedGaps items). */
  systemicGapRequired: Object.freeze(["gap", "severity", "detectedAt"]),

  /** Minimum character length for a valid seed question string. */
  seedQuestionMinLength: 20
});

// ── Core Functions ────────────────────────────────────────────────────────────

/**
 * Determine whether the governance freeze is currently active.
 *
 * Activation conditions (Athena missing item 5 resolved — concrete condition):
 *   1. governanceFreeze.manualOverrideActive === true  (explicit admin enable, highest priority)
 *   2. governanceFreeze.enabled === true AND
 *      UTC month number === governanceFreeze.monthTrigger (default 12 for December)
 *
 * Returns:
 *   { active: boolean, reason: string, month: number|null, monthTrigger: number|null }
 *
 * @param {object} config
 * @returns {{ active: boolean, reason: string, month: number|null, monthTrigger: number|null }}
 */
export function isFreezeActive(config) {
  const fc = config?.governanceFreeze;
  if (!fc || typeof fc !== "object") {
    return { active: false, reason: "FREEZE_CONFIG_ABSENT", month: null, monthTrigger: null };
  }

  const currentMonth  = new Date().getUTCMonth() + 1;   // 1–12
  const monthTrigger  = typeof fc.monthTrigger === "number" ? fc.monthTrigger : 12;

  // Admin manual override takes priority over calendar check
  if (fc.manualOverrideActive === true) {
    return {
      active:       true,
      reason:       "MANUAL_OVERRIDE_ACTIVE",
      month:        currentMonth,
      monthTrigger
    };
  }

  if (fc.enabled !== true) {
    return {
      active:       false,
      reason:       "FREEZE_DISABLED",
      month:        currentMonth,
      monthTrigger
    };
  }

  if (currentMonth === monthTrigger) {
    return {
      active:       true,
      reason:       `MONTH_TRIGGER:month=${currentMonth}:trigger=${monthTrigger}`,
      month:        currentMonth,
      monthTrigger
    };
  }

  return {
    active:       false,
    reason:       `MONTH_MISMATCH:month=${currentMonth}:trigger=${monthTrigger}`,
    month:        currentMonth,
    monthTrigger
  };
}

/**
 * Map a numeric riskScore to a FREEZE_RISK_LEVEL enum value.
 * Athena C1 resolved — numeric thresholds make the classification deterministic and testable.
 *
 * @param {number} riskScore
 * @returns {string} FREEZE_RISK_LEVEL value
 */
export function classifyRiskLevel(riskScore) {
  const score = typeof riskScore === "number" ? riskScore : 0;
  if (score >= RISK_SCORE_THRESHOLDS.CRITICAL) return FREEZE_RISK_LEVEL.CRITICAL;
  if (score >= RISK_SCORE_THRESHOLDS.HIGH)     return FREEZE_RISK_LEVEL.HIGH;
  if (score >= RISK_SCORE_THRESHOLDS.MEDIUM)   return FREEZE_RISK_LEVEL.MEDIUM;
  return FREEZE_RISK_LEVEL.LOW;
}

/**
 * Validate a critical incident override object.
 * Athena C2 resolved — override requires explicit incidentId AND rationale (>= 20 chars).
 *
 * @param {unknown} override
 * @returns {{ ok: boolean, reason: string }}
 */
export function validateCriticalOverride(override) {
  if (!override || typeof override !== "object") {
    return { ok: false, reason: "MISSING_OVERRIDE:override_object_required" };
  }

  const incidentId = String(override.incidentId || "").trim();
  const rationale  = String(override.rationale  || "").trim();

  if (!incidentId) {
    return { ok: false, reason: "MISSING_INCIDENT_ID:incidentId_required" };
  }
  if (!rationale) {
    return { ok: false, reason: "MISSING_RATIONALE:rationale_required" };
  }
  if (rationale.length < 20) {
    return { ok: false, reason: "INVALID_RATIONALE:minimum_20_characters_required" };
  }

  return { ok: true, reason: "OVERRIDE_VALID" };
}

/**
 * Evaluate whether a task/intervention is allowed during a governance freeze.
 *
 * Decision logic:
 *   freeze not active      → allowed=true,  result="not_active"
 *   missing task input     → allowed=false, result="blocked", reason=MISSING_TASK_INPUT
 *   non-critical risk      → allowed=true,  result="allowed"
 *   high-risk + no override  → allowed=false, result="blocked"
 *   high-risk + valid override → allowed=true, result="allowed"
 *
 * Athena C1 resolved — "high-risk" and "non-critical" are now enum-defined.
 * Athena C2 resolved — critical override path requires explicit incidentId and rationale.
 *
 * @param {object} config
 * @param {object} task — { riskLevel?: string, riskScore?: number, criticalOverride?: object }
 * @returns {{ allowed: boolean, result: string, reason: string, riskLevel: string|null, overrideApproved?: object }}
 */
export function evaluateFreezeGate(config, task) {
  const freeze = isFreezeActive(config);

  if (!freeze.active) {
    return {
      allowed:   true,
      result:    FREEZE_GATE_RESULT.NOT_ACTIVE,
      reason:    `FREEZE_NOT_ACTIVE:${freeze.reason}`,
      riskLevel: null
    };
  }

  // Distinguish missing input from invalid input (AC9)
  if (task === null || task === undefined) {
    return {
      allowed:   false,
      result:    FREEZE_GATE_RESULT.BLOCKED,
      reason:    "MISSING_TASK_INPUT:task_is_null_or_undefined",
      riskLevel: null
    };
  }
  if (typeof task !== "object") {
    return {
      allowed:   false,
      result:    FREEZE_GATE_RESULT.BLOCKED,
      reason:    "INVALID_TASK_INPUT:task_must_be_object",
      riskLevel: null
    };
  }

  // Classify risk — prefer explicit riskLevel, fall back to numeric riskScore
  const riskLevel = task.riskLevel && typeof task.riskLevel === "string"
    ? task.riskLevel.toLowerCase()
    : classifyRiskLevel(typeof task.riskScore === "number" ? task.riskScore : 0);

  // Non-critical risk is always allowed during freeze
  if (FREEZE_NON_CRITICAL_LEVELS.includes(riskLevel)) {
    return {
      allowed:   true,
      result:    FREEZE_GATE_RESULT.ALLOWED,
      reason:    `NON_CRITICAL_TASK_ALLOWED:riskLevel=${riskLevel}`,
      riskLevel
    };
  }

  // High-risk task — check for critical incident override
  if (!FREEZE_HIGH_RISK_LEVELS.includes(riskLevel)) {
    // Unknown risk level — treat as high-risk (fail-closed, no silent fallback)
    return {
      allowed:   false,
      result:    FREEZE_GATE_RESULT.BLOCKED,
      reason:    `UNKNOWN_RISK_LEVEL_BLOCKED:riskLevel=${riskLevel}:treating_as_high_risk`,
      riskLevel
    };
  }

  const overrideValidation = validateCriticalOverride(task.criticalOverride);
  if (!overrideValidation.ok) {
    return {
      allowed:      false,
      result:       FREEZE_GATE_RESULT.BLOCKED,
      reason:       `HIGH_RISK_BLOCKED:riskLevel=${riskLevel}:${overrideValidation.reason}`,
      riskLevel,
      overrideError: overrideValidation.reason
    };
  }

  return {
    allowed:   true,
    result:    FREEZE_GATE_RESULT.ALLOWED,
    reason:    `CRITICAL_OVERRIDE_GRANTED:incidentId=${task.criticalOverride.incidentId}:riskLevel=${riskLevel}`,
    riskLevel,
    overrideApproved: {
      incidentId: task.criticalOverride.incidentId,
      rationale:  task.criticalOverride.rationale
    }
  };
}

// ── Weekly Metrics Tracking ───────────────────────────────────────────────────

/**
 * Compute ISO week key string ("YYYY-WNN") for a given Date.
 * @param {Date} date
 * @returns {string}
 */
export function computeWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;                        // 1=Mon … 7=Sun
  d.setUTCDate(d.getUTCDate() + 4 - day);               // Thursday of ISO week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum   = Math.ceil(((Number(d) - Number(yearStart)) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/**
 * Record a weekly freeze metrics snapshot.
 *
 * Appends a snapshot to state/freeze_weekly_metrics.json (array under "weeks").
 * Athena C3 resolved — metric names, schema, and persistence path are all defined.
 *
 * Input metrics object:
 *   { cyclesBlocked: number, cyclesAllowed: number, overrides: number }
 *   throughputRatio is computed here.
 *
 * @param {object} config
 * @param {object} metrics — { cyclesBlocked, cyclesAllowed, overrides }
 * @param {Date}   [asOf]  — defaults to now; used for weekKey
 * @returns {Promise<{ ok: boolean, weekKey: string, snapshot: object, reason?: string }>}
 */
export async function recordFreezeWeeklyMetrics(config, metrics, asOf) {
  const stateDir    = config?.paths?.stateDir || "state";
  const outputPath  = path.join(stateDir, FREEZE_WEEKLY_METRICS_SCHEMA.outputPath);
  const freeze      = isFreezeActive(config);
  const now         = asOf instanceof Date ? asOf : new Date();
  const weekKey     = computeWeekKey(now);

  // Validate input — distinguish missing from invalid
  if (!metrics || typeof metrics !== "object") {
    return { ok: false, weekKey, reason: "MISSING_METRICS_INPUT:metrics_object_required" };
  }

  const cyclesBlocked = Number.isFinite(metrics.cyclesBlocked) ? metrics.cyclesBlocked : 0;
  const cyclesAllowed = Number.isFinite(metrics.cyclesAllowed) ? metrics.cyclesAllowed : 0;
  const overrides     = Number.isFinite(metrics.overrides)     ? metrics.overrides     : 0;
  const total         = cyclesBlocked + cyclesAllowed;
  const throughputRatio = total > 0 ? Math.round((cyclesAllowed / total) * 10000) / 10000 : null;

  const snapshot = {
    schemaVersion: FREEZE_WEEKLY_METRICS_SCHEMA.schemaVersion,
    weekKey,
    recordedAt:   now.toISOString(),
    freezeActive: freeze.active,
    cyclesBlocked,
    cyclesAllowed,
    overrides,
    throughputRatio
  };

  const existing = await readJson(outputPath, { schemaVersion: 1, weeks: [] });
  if (!Array.isArray(existing.weeks)) existing.weeks = [];
  existing.weeks.push(snapshot);
  // Retain up to 104 weeks (2 years)
  if (existing.weeks.length > 104) existing.weeks = existing.weeks.slice(-104);

  await writeJson(outputPath, existing);
  return { ok: true, weekKey, snapshot };
}

// ── Year-End Report ───────────────────────────────────────────────────────────

/**
 * Generate the year-end report comparing roadmap objectives to actual outcomes.
 *
 * Reads:
 *   state/improvement_reports.json  — cycle lessons and analysis data
 *   state/freeze_weekly_metrics.json — freeze metrics for the year
 *   state/knowledge_memory.json      — capability gaps (systemic gaps source)
 *
 * Output: state/year_end_report.json
 * Athena C4 resolved — output path, schema, and required fields are explicit.
 *
 * Status values:
 *   "ok"              — sufficient data, full report generated
 *   "insufficient_data" — no improvement reports found for the year
 *   "degraded"          — generated with partial data; degradedSources lists affected fields
 *
 * @param {object} config
 * @param {number} [year]  — year to report on; defaults to current UTC year
 * @returns {Promise<{ ok: boolean, status: string, reportPath: string, report: object|null }>}
 */
export async function generateYearEndReport(config, year) {
  const stateDir    = config?.paths?.stateDir || "state";
  const reportYear  = typeof year === "number" ? year : new Date().getUTCFullYear();
  const outputPath  = path.join(stateDir, YEAR_END_REPORT_SCHEMA.outputPath);

  const [reportsRaw, weeklyRaw, memoryRaw] = await Promise.all([
    readJsonSafe(path.join(stateDir, "improvement_reports.json")),
    readJsonSafe(path.join(stateDir, FREEZE_WEEKLY_METRICS_SCHEMA.outputPath)),
    readJsonSafe(path.join(stateDir, "knowledge_memory.json"))
  ]);

  const degradedSources = [];

  // ── Improvement reports ────────────────────────────────────────────────────
  let yearlyReports = [];
  if (!reportsRaw.ok) {
    if (reportsRaw.reason === READ_JSON_REASON.MISSING) {
      // File absent — treat as no data (not degraded)
      yearlyReports = [];
    } else {
      // File found but invalid (corrupt JSON) — degraded
      degradedSources.push("IMPROVEMENT_REPORTS_INVALID");
    }
  } else {
    const all = Array.isArray(reportsRaw.data?.reports) ? reportsRaw.data.reports : [];
    yearlyReports = all.filter(r => {
      if (!r?.cycleAt) return false;
      return new Date(r.cycleAt).getUTCFullYear() === reportYear;
    });
  }

  if (yearlyReports.length === 0 && degradedSources.length === 0) {
    const stub = {
      schemaVersion:         YEAR_END_REPORT_SCHEMA.schemaVersion,
      year:                  reportYear,
      generatedAt:           new Date().toISOString(),
      status:                "insufficient_data",
      insufficiencyReason:   `NO_CYCLES_RECORDED:year=${reportYear}`,
      roadmapObjectives:     [],
      roadmapOutcomes:       [],
      objectivesVsOutcomes:  [],
      unresolvedGaps:        [],
      freezeMetricsSummary:  null
    };
    await writeJson(outputPath, stub);
    return { ok: true, status: "insufficient_data", reportPath: outputPath, report: stub };
  }

  // ── Weekly freeze metrics summary ──────────────────────────────────────────
  let freezeMetricsSummary = null;
  if (!weeklyRaw.ok) {
    if (weeklyRaw.reason !== READ_JSON_REASON.MISSING) {
      degradedSources.push("FREEZE_WEEKLY_METRICS_INVALID");
    }
  } else {
    const allWeeks = Array.isArray(weeklyRaw.data?.weeks) ? weeklyRaw.data.weeks : [];
    const yearWeeks = allWeeks.filter(w => String(w?.weekKey || "").startsWith(String(reportYear)));
    const totalBlocked = yearWeeks.reduce((s, w) => s + (w.cyclesBlocked || 0), 0);
    const totalAllowed = yearWeeks.reduce((s, w) => s + (w.cyclesAllowed || 0), 0);
    const totalOverrides = yearWeeks.reduce((s, w) => s + (w.overrides || 0), 0);
    const totalCycles = totalBlocked + totalAllowed;
    freezeMetricsSummary = {
      weeksTracked:    yearWeeks.length,
      totalBlocked,
      totalAllowed,
      totalOverrides,
      throughputRatio: totalCycles > 0 ? Math.round((totalAllowed / totalCycles) * 10000) / 10000 : null
    };
  }

  // ── Unresolved systemic gaps ────────────────────────────────────────────────
  // Athena C5 resolved — 'systemic gap' is from knowledge_memory.capabilityGaps
  let unresolvedGaps = [];
  if (!memoryRaw.ok) {
    if (memoryRaw.reason !== READ_JSON_REASON.MISSING) {
      degradedSources.push("KNOWLEDGE_MEMORY_INVALID");
    }
  } else {
    const gaps = Array.isArray(memoryRaw.data?.capabilityGaps) ? memoryRaw.data.capabilityGaps : [];
    // Gaps without a resolvedAt field are considered unresolved
    unresolvedGaps = gaps
      .filter(g => !g.resolvedAt)
      .map(g => ({
        gap:       String(g.gap || ""),
        severity:  String(g.severity || SYSTEMIC_GAP_SEVERITY.LOW),
        detectedAt: String(g.detectedAt || "")
      }));
  }

  // ── Roadmap objectives vs outcomes ─────────────────────────────────────────
  // Derive from yearly cycle priorities and capability gaps
  const allPriorities = [];
  for (const report of yearlyReports) {
    const priorities = Array.isArray(report?.analysis?.nextCyclePriorities)
      ? report.analysis.nextCyclePriorities
      : [];
    for (const p of priorities) {
      if (!allPriorities.includes(p)) allPriorities.push(p);
    }
  }

  const objectivesVsOutcomes = allPriorities.slice(0, 20).map((objective, i) => {
    // Determine if objective was addressed by checking lessons in yearly reports
    const addressed = yearlyReports.some(r =>
      Array.isArray(r?.analysis?.capabilityGaps)
        ? r.analysis.capabilityGaps.some(g => String(g.gap || "").toLowerCase().includes(objective.toLowerCase().slice(0, 30)))
        : false
    );
    return {
      objectiveId: `OBJ-${reportYear}-${String(i + 1).padStart(3, "0")}`,
      objective:   String(objective).slice(0, 200),
      outcome:     addressed ? "Partially addressed via capability gap resolution" : "No explicit resolution recorded",
      status:      addressed ? "partial" : "deferred"
    };
  });

  const status = degradedSources.length > 0 ? "degraded" : "ok";

  const report = {
    schemaVersion:        YEAR_END_REPORT_SCHEMA.schemaVersion,
    year:                 reportYear,
    generatedAt:          new Date().toISOString(),
    status,
    ...(degradedSources.length > 0 ? { degradedSources } : {}),
    roadmapObjectives:    allPriorities.slice(0, 20),
    roadmapOutcomes:      yearlyReports.map(r => ({
      cycleAt:        r.cycleAt,
      systemHealth:   r.analysis?.systemHealthScore ?? null,
      lessonsCount:   r.analysis?.lessonsCount ?? 0,
      gapsCount:      r.analysis?.capabilityGapsCount ?? 0
    })),
    objectivesVsOutcomes,
    unresolvedGaps,
    freezeMetricsSummary
  };

  await writeJson(outputPath, report);
  return { ok: true, status, reportPath: outputPath, report };
}

// ── Next-Year Seed Question ───────────────────────────────────────────────────

/**
 * Generate the next-year seed question from unresolved systemic gaps.
 *
 * Reads:
 *   state/knowledge_memory.json     — capability gaps (systemic gaps)
 *   state/year_end_report.json       — for context
 *
 * Output: state/next_year_seed.json
 * Athena C5 resolved — 'systemic gap' is defined, output location is state/next_year_seed.json,
 * generation is performed by this function.
 *
 * @param {object} config
 * @param {number} [year]  — year context; defaults to current year + 1
 * @returns {Promise<{ ok: boolean, seedPath: string, seed: object|null, reason?: string }>}
 */
export async function generateNextYearSeedQuestion(config, year) {
  const stateDir   = config?.paths?.stateDir || "state";
  const nextYear   = typeof year === "number" ? year : new Date().getUTCFullYear() + 1;
  const seedPath   = path.join(stateDir, NEXT_YEAR_SEED_SCHEMA.outputPath);
  const minLen     = NEXT_YEAR_SEED_SCHEMA.seedQuestionMinLength;

  const [memoryRaw, reportRaw] = await Promise.all([
    readJsonSafe(path.join(stateDir, "knowledge_memory.json")),
    readJsonSafe(path.join(stateDir, YEAR_END_REPORT_SCHEMA.outputPath))
  ]);

  // Collect unresolved systemic gaps
  // Athena C5: 'systemic gap' = knowledge_memory.capabilityGaps entry without resolvedAt
  let unresolvedGaps = [];
  if (memoryRaw.ok) {
    const gaps = Array.isArray(memoryRaw.data?.capabilityGaps) ? memoryRaw.data.capabilityGaps : [];
    unresolvedGaps = gaps
      .filter(g => !g.resolvedAt && g.gap)
      .map(g => ({
        gap:       String(g.gap || ""),
        severity:  String(g.severity || SYSTEMIC_GAP_SEVERITY.LOW),
        detectedAt: String(g.detectedAt || "")
      }));
  }

  // Also pull from year-end report's unresolvedGaps if knowledge_memory is absent
  if (unresolvedGaps.length === 0 && reportRaw.ok) {
    const reportGaps = Array.isArray(reportRaw.data?.unresolvedGaps)
      ? reportRaw.data.unresolvedGaps
      : [];
    unresolvedGaps = reportGaps.filter(g => g.gap);
  }

  // Sort by severity: critical > high > medium > low
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  unresolvedGaps.sort((a, b) =>
    (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99)
  );

  const topGap         = unresolvedGaps[0] ?? null;
  const gapCount       = unresolvedGaps.length;

  // Generate seed question deterministically from top gap
  let question;
  let rationale;
  const dataPoints = [];

  if (topGap) {
    const gapSnip = topGap.gap.slice(0, 80);
    question  = `What concrete action in ${nextYear} would close the "${gapSnip}" systemic gap?`;
    rationale = `Top unresolved systemic gap (severity=${topGap.severity}, detectedAt=${topGap.detectedAt}) identified from ${gapCount} unresolved gap(s); closing it is the highest-priority investment for ${nextYear}.`;
    dataPoints.push(
      `topGap.gap=${topGap.gap.slice(0, 60)}`,
      `topGap.severity=${topGap.severity}`,
      `unresolvedGapsCount=${gapCount}`
    );
  } else {
    // No gaps recorded — default to throughput/quality question
    question  = `What capability investment in ${nextYear} would most improve autonomous delivery quality?`;
    rationale = `No unresolved systemic gaps recorded; default quality improvement question generated for ${nextYear}.`;
    dataPoints.push(`unresolvedGapsCount=0`, `year=${nextYear}`);
  }

  // Enforce format rules (mirrors monthly postmortem pattern)
  if (!question.endsWith("?")) question = `${question}?`;
  if (question.length < minLen) question = `${question} (${nextYear})?`;

  const seedQuestion = { question, rationale, dataPoints };

  const seed = {
    schemaVersion:      NEXT_YEAR_SEED_SCHEMA.schemaVersion,
    year:               nextYear,
    generatedAt:        new Date().toISOString(),
    seedQuestion,
    unresolvedGapsCount: gapCount,
    topGap
  };

  await writeJson(seedPath, seed);
  return { ok: true, seedPath, seed };
}

// ── Rollback Guard ────────────────────────────────────────────────────────────

/**
 * Check if the freeze should be auto-disabled due to throughput collapse.
 *
 * Rollback criteria (Athena missing item 7 resolved):
 *   If the 4-week rolling throughputRatio drops below
 *   governanceFreeze.rollbackThroughputCollapseThreshold (default 0.5),
 *   the freeze should be lifted to prevent delivery collapse.
 *
 * This function does NOT mutate config — it returns a recommendation.
 * Callers must apply the recommendation (e.g., set manualOverrideActive=false and enabled=false).
 *
 * @param {object} config
 * @returns {Promise<{ recommend: "lift"|"keep"|"insufficient_data", throughputRatio: number|null, reason: string }>}
 */
export async function checkFreezeRollbackCriteria(config) {
  const stateDir   = config?.paths?.stateDir || "state";
  const threshold  = typeof config?.governanceFreeze?.rollbackThroughputCollapseThreshold === "number"
    ? config.governanceFreeze.rollbackThroughputCollapseThreshold
    : 0.5;

  const weeklyRaw = await readJsonSafe(path.join(stateDir, FREEZE_WEEKLY_METRICS_SCHEMA.outputPath));
  if (!weeklyRaw.ok) {
    return { recommend: "insufficient_data", throughputRatio: null, reason: "WEEKLY_METRICS_ABSENT" };
  }

  const weeks = Array.isArray(weeklyRaw.data?.weeks) ? weeklyRaw.data.weeks : [];
  if (weeks.length === 0) {
    return { recommend: "insufficient_data", throughputRatio: null, reason: "NO_WEEKS_RECORDED" };
  }

  // Use last 4 weeks
  const recent = weeks.slice(-4);
  const totalBlocked = recent.reduce((s, w) => s + (w.cyclesBlocked || 0), 0);
  const totalAllowed = recent.reduce((s, w) => s + (w.cyclesAllowed || 0), 0);
  const total        = totalBlocked + totalAllowed;

  if (total === 0) {
    return { recommend: "insufficient_data", throughputRatio: null, reason: "NO_CYCLE_DATA_IN_RECENT_WEEKS" };
  }

  const ratio = Math.round((totalAllowed / total) * 10000) / 10000;

  if (ratio < threshold) {
    return {
      recommend:       "lift",
      throughputRatio: ratio,
      reason:          `THROUGHPUT_COLLAPSE:ratio=${ratio}:threshold=${threshold}:lift_freeze_recommended`
    };
  }

  return {
    recommend:       "keep",
    throughputRatio: ratio,
    reason:          `THROUGHPUT_HEALTHY:ratio=${ratio}:threshold=${threshold}`
  };
}
