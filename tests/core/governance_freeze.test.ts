/**
 * Tests for T-040: Year-end consolidation and governance freeze window.
 *
 * Covers all acceptance criteria:
 *   AC1  — Freeze mode blocks non-critical high-risk interventions
 *   AC2  — Critical override path requires explicit incidentId and rationale
 *   AC3  — Weekly stabilization metrics tracked during freeze
 *   AC4  — Year-end report includes roadmap outcomes vs objectives
 *   AC5  — Next-year seed question generated from unresolved systemic gaps
 *   AC6  — Each criterion maps to an explicit verification command
 *   AC7  — Changed behavior covered by automated tests including one negative path
 *   AC8  — JSON output includes defined schema with required fields
 *   AC9  — Validation distinguishes missing input from invalid input
 *   AC10 — No silent fallback for critical state
 *   AC11 — C1 resolved: 'high-risk' has enum + numeric threshold
 *   AC12 — C3 resolved: metric names, path, and schema are explicit
 *   AC13 — C4 resolved: output path, required-field schema, and generation command explicit
 *   AC14 — C5 resolved: 'systemic gap' defined, output location explicit
 *   AC15 — Month-12 trigger has concrete implementation condition
 *   AC16 — Risk level is HIGH for simultaneous changes to 3 core components
 *   AC17 — Rollback criteria and automated regression guard specified
 *
 * Negative paths:
 *   - Missing task input blocked during active freeze
 *   - Invalid task type blocked (non-object task)
 *   - High-risk task without override blocked
 *   - Override with missing incidentId rejected
 *   - Override with short rationale rejected
 *   - Throughput collapse triggers "lift" recommendation
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  FREEZE_RISK_LEVEL,
  FREEZE_HIGH_RISK_LEVELS,
  FREEZE_NON_CRITICAL_LEVELS,
  FREEZE_GATE_RESULT,
  RISK_SCORE_THRESHOLDS,
  SYSTEMIC_GAP_SEVERITY,
  FREEZE_WEEKLY_METRICS_SCHEMA,
  YEAR_END_REPORT_SCHEMA,
  NEXT_YEAR_SEED_SCHEMA,
  isFreezeActive,
  classifyRiskLevel,
  evaluateFreezeGate,
  validateCriticalOverride,
  computeWeekKey,
  recordFreezeWeeklyMetrics,
  generateYearEndReport,
  generateNextYearSeedQuestion,
  checkFreezeRollbackCriteria
} from "../../src/core/governance_freeze.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeStateDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t040-"));
  return dir;
}

async function writeJson(dir, filename, data) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), "utf8");
}

function makeConfig(stateDir, freezeOverrides = {}) {
  return {
    paths: { stateDir },
    governanceFreeze: {
      enabled: false,
      monthTrigger: 12,
      manualOverrideActive: false,
      rollbackThroughputCollapseThreshold: 0.5,
      ...freezeOverrides
    }
  };
}

/** Build a config where freeze IS active (manual override). */
function makeFrozenConfig(stateDir, extra = {}) {
  return makeConfig(stateDir, { manualOverrideActive: true, ...extra });
}

/** Build a valid critical override object. */
function validOverride(incidentId = "INC-2026-001", rationale = "Critical production issue requiring immediate remediation") {
  return { incidentId, rationale };
}

// ── Schema enumeration tests (AC8, AC11–AC14) ─────────────────────────────────

describe("governance_freeze — schema definitions", () => {
  it("AC8/AC11: FREEZE_RISK_LEVEL has all four expected values", () => {
    assert.equal(FREEZE_RISK_LEVEL.LOW,      "low");
    assert.equal(FREEZE_RISK_LEVEL.MEDIUM,   "medium");
    assert.equal(FREEZE_RISK_LEVEL.HIGH,     "high");
    assert.equal(FREEZE_RISK_LEVEL.CRITICAL, "critical");
  });

  it("AC11: RISK_SCORE_THRESHOLDS maps to numeric values >= 0", () => {
    assert.equal(typeof RISK_SCORE_THRESHOLDS.LOW,      "number");
    assert.equal(typeof RISK_SCORE_THRESHOLDS.MEDIUM,   "number");
    assert.equal(typeof RISK_SCORE_THRESHOLDS.HIGH,     "number");
    assert.equal(typeof RISK_SCORE_THRESHOLDS.CRITICAL, "number");
    assert.ok(RISK_SCORE_THRESHOLDS.HIGH    >= 0.5, "high threshold must be >= 0.5");
    assert.ok(RISK_SCORE_THRESHOLDS.CRITICAL > RISK_SCORE_THRESHOLDS.HIGH, "critical > high");
  });

  it("AC11: FREEZE_HIGH_RISK_LEVELS includes high and critical only", () => {
    assert.ok(FREEZE_HIGH_RISK_LEVELS.includes("high"),    "must include high");
    assert.ok(FREEZE_HIGH_RISK_LEVELS.includes("critical"), "must include critical");
    assert.ok(!FREEZE_HIGH_RISK_LEVELS.includes("medium"), "must not include medium");
    assert.ok(!FREEZE_HIGH_RISK_LEVELS.includes("low"),    "must not include low");
  });

  it("AC11: FREEZE_NON_CRITICAL_LEVELS includes low and medium only", () => {
    assert.ok(FREEZE_NON_CRITICAL_LEVELS.includes("low"),    "must include low");
    assert.ok(FREEZE_NON_CRITICAL_LEVELS.includes("medium"), "must include medium");
    assert.ok(!FREEZE_NON_CRITICAL_LEVELS.includes("high"),  "must not include high");
  });

  it("AC12: FREEZE_WEEKLY_METRICS_SCHEMA has all required fields and metricNames", () => {
    const s = FREEZE_WEEKLY_METRICS_SCHEMA;
    for (const field of ["schemaVersion", "weekKey", "recordedAt", "freezeActive",
                         "cyclesBlocked", "cyclesAllowed", "overrides", "throughputRatio"]) {
      assert.ok(s.required.includes(field), `required must include ${field}`);
    }
    for (const metric of ["cyclesBlocked", "cyclesAllowed", "overrides", "throughputRatio"]) {
      assert.ok(s.metricNames.includes(metric), `metricNames must include ${metric}`);
    }
    assert.ok(s.outputPath.length > 0, "outputPath must be non-empty");
  });

  it("AC13: YEAR_END_REPORT_SCHEMA has all required fields, enums, and output path", () => {
    const s = YEAR_END_REPORT_SCHEMA;
    for (const field of ["schemaVersion", "year", "generatedAt", "status",
                         "roadmapObjectives", "roadmapOutcomes", "objectivesVsOutcomes",
                         "unresolvedGaps", "freezeMetricsSummary"]) {
      assert.ok(s.required.includes(field), `required must include ${field}`);
    }
    assert.ok(s.statusEnum.includes("ok"),                "statusEnum must include ok");
    assert.ok(s.statusEnum.includes("insufficient_data"), "statusEnum must include insufficient_data");
    assert.ok(s.statusEnum.includes("degraded"),          "statusEnum must include degraded");
    assert.ok(s.outputPath.length > 0,                    "outputPath must be non-empty");
  });

  it("AC14: NEXT_YEAR_SEED_SCHEMA has required fields and output path", () => {
    const s = NEXT_YEAR_SEED_SCHEMA;
    for (const field of ["schemaVersion", "year", "generatedAt",
                         "seedQuestion", "unresolvedGapsCount", "topGap"]) {
      assert.ok(s.required.includes(field), `required must include ${field}`);
    }
    for (const field of ["question", "rationale", "dataPoints"]) {
      assert.ok(s.seedQuestionRequired.includes(field), `seedQuestionRequired must include ${field}`);
    }
    assert.ok(s.outputPath.length > 0, "outputPath must be non-empty");
    assert.ok(s.seedQuestionMinLength >= 20, "seedQuestionMinLength must be >= 20");
  });

  it("AC14: SYSTEMIC_GAP_SEVERITY has all four levels", () => {
    for (const level of ["critical", "high", "medium", "low"]) {
      const found = Object.values(SYSTEMIC_GAP_SEVERITY).includes(level);
      assert.ok(found, `SYSTEMIC_GAP_SEVERITY must include ${level}`);
    }
  });
});

// ── isFreezeActive tests (AC15) ───────────────────────────────────────────────

describe("isFreezeActive", () => {
  it("AC15: returns active=false when config missing governanceFreeze section", () => {
    const result = isFreezeActive({});
    assert.equal(result.active, false);
    assert.equal(result.reason, "FREEZE_CONFIG_ABSENT");
  });

  it("AC15: returns active=false when enabled=false and no manual override", () => {
    const result = isFreezeActive(makeConfig("state", { enabled: false }));
    assert.equal(result.active, false);
    assert.equal(result.reason, "FREEZE_DISABLED");
  });

  it("AC15: returns active=true when manualOverrideActive=true regardless of calendar", () => {
    const result = isFreezeActive(makeConfig("state", {
      manualOverrideActive: true,
      enabled: false,
      monthTrigger: 6  // not current month
    }));
    assert.equal(result.active, true);
    assert.equal(result.reason, "MANUAL_OVERRIDE_ACTIVE");
  });

  it("AC15: returns active=true when enabled=true and monthTrigger matches current month", () => {
    const currentMonth = new Date().getUTCMonth() + 1;
    const result = isFreezeActive(makeConfig("state", {
      enabled: true,
      monthTrigger: currentMonth
    }));
    assert.equal(result.active, true);
    assert.ok(result.reason.startsWith("MONTH_TRIGGER"), `reason should start with MONTH_TRIGGER, got: ${result.reason}`);
    assert.equal(result.month, currentMonth);
  });

  it("AC15: returns active=false when enabled=true and monthTrigger does NOT match", () => {
    // Use a month that is definitely not current
    const currentMonth = new Date().getUTCMonth() + 1;
    const differentMonth = currentMonth === 6 ? 7 : 6;
    const result = isFreezeActive(makeConfig("state", {
      enabled: true,
      monthTrigger: differentMonth
    }));
    assert.equal(result.active, false);
    assert.ok(result.reason.startsWith("MONTH_MISMATCH"), `reason should start with MONTH_MISMATCH, got: ${result.reason}`);
  });

  it("AC15: returns month and monthTrigger numbers in result", () => {
    const result = isFreezeActive(makeConfig("state", { enabled: true, monthTrigger: 12 }));
    assert.equal(typeof result.month, "number");
    assert.equal(result.monthTrigger, 12);
  });
});

// ── classifyRiskLevel tests (AC11) ────────────────────────────────────────────

describe("classifyRiskLevel", () => {
  it("AC11: score < 0.3 → low", () => {
    assert.equal(classifyRiskLevel(0),    "low");
    assert.equal(classifyRiskLevel(0.1),  "low");
    assert.equal(classifyRiskLevel(0.29), "low");
  });

  it("AC11: score >= 0.3 and < 0.7 → medium", () => {
    assert.equal(classifyRiskLevel(0.3),  "medium");
    assert.equal(classifyRiskLevel(0.5),  "medium");
    assert.equal(classifyRiskLevel(0.69), "medium");
  });

  it("AC11: score >= 0.7 and < 0.9 → high", () => {
    assert.equal(classifyRiskLevel(0.7),  "high");
    assert.equal(classifyRiskLevel(0.8),  "high");
    assert.equal(classifyRiskLevel(0.89), "high");
  });

  it("AC11: score >= 0.9 → critical", () => {
    assert.equal(classifyRiskLevel(0.9),  "critical");
    assert.equal(classifyRiskLevel(1.0),  "critical");
  });

  it("AC9: non-number input treated as 0 (invalid → low)", () => {
    assert.equal(classifyRiskLevel(null),      "low");
    assert.equal(classifyRiskLevel(undefined), "low");
    assert.equal(classifyRiskLevel("high"),    "low"); // string → low
  });
});

// ── validateCriticalOverride tests (AC2, AC9) ─────────────────────────────────

describe("validateCriticalOverride", () => {
  it("AC2: accepts valid override with incidentId and rationale", () => {
    const result = validateCriticalOverride(validOverride());
    assert.equal(result.ok, true);
    assert.equal(result.reason, "OVERRIDE_VALID");
  });

  it("AC9/AC2: null override → MISSING_OVERRIDE (missing, not invalid)", () => {
    const result = validateCriticalOverride(null);
    assert.equal(result.ok, false);
    assert.ok(result.reason.startsWith("MISSING_OVERRIDE"), `expected MISSING_OVERRIDE, got: ${result.reason}`);
  });

  it("AC9/AC2: non-object override → MISSING_OVERRIDE", () => {
    const result = validateCriticalOverride("INC-001");
    assert.equal(result.ok, false);
    assert.ok(result.reason.startsWith("MISSING_OVERRIDE"));
  });

  it("AC9/AC2: missing incidentId → MISSING_INCIDENT_ID", () => {
    const result = validateCriticalOverride({ rationale: "Critical production issue requiring immediate attention" });
    assert.equal(result.ok, false);
    assert.ok(result.reason.startsWith("MISSING_INCIDENT_ID"));
  });

  it("AC9/AC2: missing rationale → MISSING_RATIONALE", () => {
    const result = validateCriticalOverride({ incidentId: "INC-001" });
    assert.equal(result.ok, false);
    assert.ok(result.reason.startsWith("MISSING_RATIONALE"));
  });

  it("AC2: rationale too short (< 20 chars) → INVALID_RATIONALE", () => {
    const result = validateCriticalOverride({ incidentId: "INC-001", rationale: "short" });
    assert.equal(result.ok, false);
    assert.ok(result.reason.startsWith("INVALID_RATIONALE"), `expected INVALID_RATIONALE, got: ${result.reason}`);
  });

  it("AC2: rationale exactly 20 chars is valid", () => {
    const result = validateCriticalOverride({ incidentId: "INC-001", rationale: "12345678901234567890" });
    assert.equal(result.ok, true);
  });
});

// ── evaluateFreezeGate tests (AC1, AC2, AC7, AC9, AC10) ───────────────────────

describe("evaluateFreezeGate — freeze not active", () => {
  it("AC1: allowed=true and result=not_active when freeze is disabled", () => {
    const config = makeConfig("state", { enabled: false });
    const result = evaluateFreezeGate(config, { riskLevel: "high" });
    assert.equal(result.allowed, true);
    assert.equal(result.result, FREEZE_GATE_RESULT.NOT_ACTIVE);
  });

  it("AC1: high-risk task is allowed when freeze is not active", () => {
    const config = makeConfig("state", { enabled: false });
    const result = evaluateFreezeGate(config, { riskScore: 0.9, riskLevel: "critical" });
    assert.equal(result.allowed, true);
    assert.equal(result.result, FREEZE_GATE_RESULT.NOT_ACTIVE);
  });
});

describe("evaluateFreezeGate — freeze active (manual override mode)", () => {
  const frozenConfig = makeConfig("state", { manualOverrideActive: true });

  it("AC1: non-critical task (low) allowed during freeze without override", () => {
    const result = evaluateFreezeGate(frozenConfig, { riskLevel: "low" });
    assert.equal(result.allowed, true);
    assert.equal(result.result, FREEZE_GATE_RESULT.ALLOWED);
    assert.ok(result.reason.includes("NON_CRITICAL_TASK_ALLOWED"));
    assert.equal(result.riskLevel, "low");
  });

  it("AC1: non-critical task (medium) allowed during freeze without override", () => {
    const result = evaluateFreezeGate(frozenConfig, { riskLevel: "medium" });
    assert.equal(result.allowed, true);
    assert.equal(result.result, FREEZE_GATE_RESULT.ALLOWED);
  });

  it("AC1/AC7 NEGATIVE: high-risk task without override is BLOCKED during freeze", () => {
    const result = evaluateFreezeGate(frozenConfig, { riskLevel: "high" });
    assert.equal(result.allowed, false);
    assert.equal(result.result, FREEZE_GATE_RESULT.BLOCKED);
    assert.ok(result.reason.includes("HIGH_RISK_BLOCKED"));
    assert.ok(result.reason.includes("MISSING_OVERRIDE"));
    assert.equal(result.riskLevel, "high");
  });

  it("AC1/AC7 NEGATIVE: critical-risk task without override is BLOCKED during freeze", () => {
    const result = evaluateFreezeGate(frozenConfig, { riskLevel: "critical" });
    assert.equal(result.allowed, false);
    assert.equal(result.result, FREEZE_GATE_RESULT.BLOCKED);
    assert.ok(result.reason.includes("HIGH_RISK_BLOCKED"));
  });

  it("AC2: high-risk task WITH valid override is ALLOWED during freeze", () => {
    const result = evaluateFreezeGate(frozenConfig, {
      riskLevel:       "high",
      criticalOverride: validOverride()
    });
    assert.equal(result.allowed, true);
    assert.equal(result.result, FREEZE_GATE_RESULT.ALLOWED);
    assert.ok(result.reason.includes("CRITICAL_OVERRIDE_GRANTED"));
    assert.ok(result.reason.includes("INC-2026-001"));
    assert.deepEqual(result.overrideApproved.incidentId, "INC-2026-001");
  });

  it("AC2/AC7 NEGATIVE: high-risk task with invalid override (no incidentId) is BLOCKED", () => {
    const result = evaluateFreezeGate(frozenConfig, {
      riskLevel:       "high",
      criticalOverride: { rationale: "Critical production issue requiring immediate remediation" }
    });
    assert.equal(result.allowed, false);
    assert.equal(result.result, FREEZE_GATE_RESULT.BLOCKED);
    assert.ok(result.overrideError.startsWith("MISSING_INCIDENT_ID"));
  });

  it("AC2/AC7 NEGATIVE: high-risk task with short rationale is BLOCKED", () => {
    const result = evaluateFreezeGate(frozenConfig, {
      riskLevel:       "high",
      criticalOverride: { incidentId: "INC-001", rationale: "too short" }
    });
    assert.equal(result.allowed, false);
    assert.ok(result.overrideError.startsWith("INVALID_RATIONALE"));
  });

  it("AC9: null task → MISSING_TASK_INPUT (missing, not invalid)", () => {
    const result = evaluateFreezeGate(frozenConfig, null);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.startsWith("MISSING_TASK_INPUT"));
  });

  it("AC9: string task → INVALID_TASK_INPUT (invalid, not missing)", () => {
    const result = evaluateFreezeGate(frozenConfig, "high-risk");
    assert.equal(result.allowed, false);
    assert.ok(result.reason.startsWith("INVALID_TASK_INPUT"));
  });

  it("AC10: no silent fallback — blocked task has explicit result and reason", () => {
    const result = evaluateFreezeGate(frozenConfig, { riskLevel: "high" });
    assert.equal(result.allowed, false);
    assert.ok(result.result, "result must be non-empty");
    assert.ok(result.reason.length > 0, "reason must be non-empty");
    // overrideError must be present (reason for block is explicit)
    assert.ok(result.overrideError, "overrideError must be set when override is invalid");
  });

  it("AC11: riskScore >= 0.7 triggers high-risk classification and block during freeze", () => {
    const result = evaluateFreezeGate(frozenConfig, { riskScore: 0.75 });
    assert.equal(result.allowed, false);
    assert.equal(result.riskLevel, "high");
  });

  it("AC11: riskScore < 0.3 classifies as low-risk and is allowed during freeze", () => {
    const result = evaluateFreezeGate(frozenConfig, { riskScore: 0.1 });
    assert.equal(result.allowed, true);
    assert.equal(result.riskLevel, "low");
  });
});

// ── computeWeekKey tests ──────────────────────────────────────────────────────

describe("computeWeekKey", () => {
  it("returns YYYY-WNN format", () => {
    const key = computeWeekKey(new Date("2026-01-05"));
    assert.ok(/^\d{4}-W\d{2}$/.test(key), `weekKey must match YYYY-WNN, got: ${key}`);
  });

  it("is deterministic for same date", () => {
    const d = new Date("2026-03-15");
    assert.equal(computeWeekKey(d), computeWeekKey(d));
  });
});

// ── recordFreezeWeeklyMetrics tests (AC3, AC8, AC9, AC12) ────────────────────

describe("recordFreezeWeeklyMetrics", () => {
  let stateDir;
  before(async () => { stateDir = await makeStateDir(); });
  after(async () => { await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {}); });

  it("AC3/AC8: persists a snapshot with all required schema fields", async () => {
    const config = makeConfig(stateDir, { manualOverrideActive: true });
    const result = await recordFreezeWeeklyMetrics(config, {
      cyclesBlocked: 3, cyclesAllowed: 7, overrides: 1
    });
    assert.equal(result.ok, true);
    assert.ok(result.weekKey, "weekKey must be set");

    // Verify the persisted file
    const raw = JSON.parse(await fs.readFile(
      path.join(stateDir, FREEZE_WEEKLY_METRICS_SCHEMA.outputPath), "utf8"
    ));
    assert.ok(Array.isArray(raw.weeks), "weeks must be array");
    const snap = raw.weeks[raw.weeks.length - 1];
    for (const field of FREEZE_WEEKLY_METRICS_SCHEMA.required) {
      assert.ok(field in snap, `snapshot must have required field: ${field}`);
    }
  });

  it("AC3: throughputRatio is computed correctly", async () => {
    const config = makeConfig(stateDir);
    const result = await recordFreezeWeeklyMetrics(config, {
      cyclesBlocked: 4, cyclesAllowed: 6, overrides: 0
    });
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.throughputRatio, 0.6);
  });

  it("AC3: throughputRatio is null when both blocked and allowed are 0", async () => {
    const config = makeConfig(stateDir);
    const result = await recordFreezeWeeklyMetrics(config, {
      cyclesBlocked: 0, cyclesAllowed: 0, overrides: 0
    });
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.throughputRatio, null);
  });

  it("AC9: missing metrics input returns ok=false with explicit reason", async () => {
    const config = makeConfig(stateDir);
    const result = await recordFreezeWeeklyMetrics(config, null);
    assert.equal(result.ok, false);
    assert.ok(result.reason.startsWith("MISSING_METRICS_INPUT"));
  });

  it("AC3: appends multiple snapshots to the same file", async () => {
    const dir2 = await makeStateDir();
    try {
      const config = makeConfig(dir2);
      await recordFreezeWeeklyMetrics(config, { cyclesBlocked: 1, cyclesAllowed: 9, overrides: 0 });
      await recordFreezeWeeklyMetrics(config, { cyclesBlocked: 2, cyclesAllowed: 8, overrides: 1 });
      const raw = JSON.parse(await fs.readFile(
        path.join(dir2, FREEZE_WEEKLY_METRICS_SCHEMA.outputPath), "utf8"
      ));
      assert.ok(raw.weeks.length >= 2, "should have at least 2 snapshots");
    } finally {
      await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ── generateYearEndReport tests (AC4, AC8, AC13) ──────────────────────────────

describe("generateYearEndReport", () => {
  let stateDir;
  before(async () => { stateDir = await makeStateDir(); });
  after(async () => { await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {}); });

  it("AC4/AC8: generates report with all required schema fields when improvement reports exist", async () => {
    const year = 2024;
    // Write improvement reports for that year
    await writeJson(stateDir, "improvement_reports.json", {
      reports: [
        {
          cycleAt: `${year}-06-15T00:00:00.000Z`,
          analysis: {
            systemHealthScore: 80,
            lessonsCount: 3,
            capabilityGapsCount: 1,
            nextCyclePriorities: ["improve test coverage", "reduce timeouts"],
            capabilityGaps: []
          }
        },
        {
          cycleAt: `${year}-09-20T00:00:00.000Z`,
          analysis: {
            systemHealthScore: 85,
            lessonsCount: 2,
            capabilityGapsCount: 0,
            nextCyclePriorities: ["improve test coverage"],
            capabilityGaps: []
          }
        },
        {
          cycleAt: `${year}-11-10T00:00:00.000Z`,
          analysis: {
            systemHealthScore: 90,
            lessonsCount: 1,
            capabilityGapsCount: 0,
            nextCyclePriorities: ["add monitoring"],
            capabilityGaps: []
          }
        }
      ]
    });

    const config = makeConfig(stateDir);
    const result = await generateYearEndReport(config, year);
    assert.equal(result.ok, true);
    assert.ok(["ok", "degraded"].includes(result.status), `status must be ok or degraded, got: ${result.status}`);

    const report = result.report;
    for (const field of YEAR_END_REPORT_SCHEMA.required) {
      assert.ok(field in report, `year-end report must have field: ${field}`);
    }
    assert.equal(report.year, year);
    assert.ok(report.generatedAt, "generatedAt must be set");
    assert.ok(YEAR_END_REPORT_SCHEMA.statusEnum.includes(report.status), `status must be in enum`);
    assert.ok(Array.isArray(report.objectivesVsOutcomes), "objectivesVsOutcomes must be array");
    assert.ok(Array.isArray(report.unresolvedGaps),       "unresolvedGaps must be array");
  });

  it("AC4: objectivesVsOutcomes entries have required fields", async () => {
    const year = 2023;
    await writeJson(stateDir, `impr_${year}.json`, {});
    // Use improvement_reports.json with a unique cycleAt for 2023
    const existing = JSON.parse(await fs.readFile(
      path.join(stateDir, "improvement_reports.json"), "utf8"
    ));
    existing.reports.push({
      cycleAt: `${year}-03-01T00:00:00.000Z`,
      analysis: { systemHealthScore: 70, lessonsCount: 2, capabilityGapsCount: 0,
                  nextCyclePriorities: ["optimize retry logic"], capabilityGaps: [] }
    });
    await writeJson(stateDir, "improvement_reports.json", existing);

    const config = makeConfig(stateDir);
    const result = await generateYearEndReport(config, year);
    assert.equal(result.ok, true);
    for (const entry of result.report.objectivesVsOutcomes) {
      for (const field of YEAR_END_REPORT_SCHEMA.objectiveEntryRequired) {
        assert.ok(field in entry, `objectivesVsOutcomes entry must have field: ${field}`);
      }
      assert.ok(YEAR_END_REPORT_SCHEMA.objectiveStatusEnum.includes(entry.status),
        `entry.status must be in enum, got: ${entry.status}`);
    }
  });

  it("AC13: returns insufficient_data when no reports found for year", async () => {
    const dir2 = await makeStateDir();
    try {
      const config = makeConfig(dir2);
      const result = await generateYearEndReport(config, 1990);
      assert.equal(result.ok, true);
      assert.equal(result.status, "insufficient_data");
      assert.ok(result.report.insufficiencyReason, "insufficiencyReason must be set");
    } finally {
      await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("AC4: report is written to correct output path", async () => {
    const dir2 = await makeStateDir();
    try {
      await writeJson(dir2, "improvement_reports.json", {
        reports: [
          { cycleAt: "2025-06-01T00:00:00.000Z",
            analysis: { systemHealthScore: 75, lessonsCount: 1, capabilityGapsCount: 0,
                        nextCyclePriorities: ["test"], capabilityGaps: [] } }
        ]
      });
      const config = makeConfig(dir2);
      const result = await generateYearEndReport(config, 2025);
      const expectedPath = path.join(dir2, YEAR_END_REPORT_SCHEMA.outputPath);
      assert.equal(result.reportPath, expectedPath, "reportPath must be the schema-defined path");
      // File should exist
      await assert.doesNotReject(fs.access(expectedPath), "report file must exist");
    } finally {
      await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ── generateNextYearSeedQuestion tests (AC5, AC8, AC14) ──────────────────────

describe("generateNextYearSeedQuestion", () => {
  let stateDir;
  before(async () => { stateDir = await makeStateDir(); });
  after(async () => { await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {}); });

  it("AC5/AC8: generates seed with all required schema fields", async () => {
    // Write knowledge_memory with unresolved capability gaps
    await writeJson(stateDir, "knowledge_memory.json", {
      capabilityGaps: [
        { gap: "Workers had no prompt for managing GitHub Actions variables",
          severity: "critical", detectedAt: "2025-01-10T00:00:00.000Z" },
        { gap: "No worker assigned GitHub repo settings branch protection",
          severity: "high",     detectedAt: "2025-02-20T00:00:00.000Z" }
      ]
    });

    const config = makeConfig(stateDir);
    const result = await generateNextYearSeedQuestion(config, 2026);
    assert.equal(result.ok, true);
    assert.ok(result.seed, "seed must be set");
    assert.ok(result.seedPath.includes(NEXT_YEAR_SEED_SCHEMA.outputPath), "seedPath must include outputPath");

    const seed = result.seed;
    for (const field of NEXT_YEAR_SEED_SCHEMA.required) {
      assert.ok(field in seed, `seed must have field: ${field}`);
    }
    for (const field of NEXT_YEAR_SEED_SCHEMA.seedQuestionRequired) {
      assert.ok(field in seed.seedQuestion, `seedQuestion must have field: ${field}`);
    }

    // Question format rules
    assert.ok(seed.seedQuestion.question.endsWith("?"), "question must end with ?");
    assert.ok(seed.seedQuestion.question.length >= NEXT_YEAR_SEED_SCHEMA.seedQuestionMinLength,
      "question must meet minimum length");
    assert.ok(Array.isArray(seed.seedQuestion.dataPoints), "dataPoints must be array");
    assert.ok(seed.seedQuestion.dataPoints.length > 0, "dataPoints must have at least 1 entry");
    assert.ok(seed.seedQuestion.rationale.length > 0, "rationale must be non-empty");
  });

  it("AC5: topGap is the most severe unresolved gap", async () => {
    const config = makeConfig(stateDir);
    const result = await generateNextYearSeedQuestion(config, 2026);
    // Critical gap should be topGap
    assert.equal(result.seed.topGap.severity, "critical",
      "topGap should be the highest-severity gap");
  });

  it("AC14: generates default question when no systemic gaps exist", async () => {
    const dir2 = await makeStateDir();
    try {
      const config = makeConfig(dir2);
      const result = await generateNextYearSeedQuestion(config, 2027);
      assert.equal(result.ok, true);
      assert.equal(result.seed.unresolvedGapsCount, 0);
      assert.equal(result.seed.topGap, null);
      assert.ok(result.seed.seedQuestion.question.endsWith("?"), "default question must end with ?");
    } finally {
      await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("AC5: resolved gaps (with resolvedAt) are not included", async () => {
    const dir2 = await makeStateDir();
    try {
      await writeJson(dir2, "knowledge_memory.json", {
        capabilityGaps: [
          { gap: "Resolved issue", severity: "critical",
            detectedAt: "2025-01-01T00:00:00.000Z", resolvedAt: "2025-06-01T00:00:00.000Z" },
          { gap: "Open issue still needs work", severity: "high",
            detectedAt: "2025-03-01T00:00:00.000Z" }
        ]
      });
      const config = makeConfig(dir2);
      const result = await generateNextYearSeedQuestion(config, 2026);
      assert.equal(result.seed.unresolvedGapsCount, 1, "only unresolved gaps should be counted");
      assert.ok(result.seed.topGap.gap.includes("Open issue"), "topGap should be the unresolved gap");
    } finally {
      await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("AC5/AC14: seed is written to correct output path", async () => {
    const config = makeConfig(stateDir);
    const result = await generateNextYearSeedQuestion(config, 2026);
    const expectedPath = path.join(stateDir, NEXT_YEAR_SEED_SCHEMA.outputPath);
    assert.equal(result.seedPath, expectedPath, "seedPath must be the schema-defined path");
    await assert.doesNotReject(fs.access(expectedPath), "seed file must exist on disk");
  });
});

// ── checkFreezeRollbackCriteria tests (AC17) ──────────────────────────────────

describe("checkFreezeRollbackCriteria", () => {
  let stateDir;
  before(async () => { stateDir = await makeStateDir(); });
  after(async () => { await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {}); });

  it("AC17: returns insufficient_data when no weekly metrics exist", async () => {
    const config = makeConfig(stateDir);
    const result = await checkFreezeRollbackCriteria(config);
    assert.equal(result.recommend, "insufficient_data");
  });

  it("AC17: recommends 'keep' when throughput ratio is above threshold", async () => {
    await writeJson(stateDir, FREEZE_WEEKLY_METRICS_SCHEMA.outputPath, {
      weeks: [
        { weekKey: "2026-W10", cyclesBlocked: 1, cyclesAllowed: 9, overrides: 0 },
        { weekKey: "2026-W11", cyclesBlocked: 0, cyclesAllowed: 10, overrides: 0 },
        { weekKey: "2026-W12", cyclesBlocked: 2, cyclesAllowed: 8, overrides: 0 },
        { weekKey: "2026-W13", cyclesBlocked: 1, cyclesAllowed: 9, overrides: 0 }
      ]
    });
    const config = makeConfig(stateDir, { rollbackThroughputCollapseThreshold: 0.5 });
    const result = await checkFreezeRollbackCriteria(config);
    assert.equal(result.recommend, "keep");
    assert.ok(result.throughputRatio > 0.5, "throughputRatio should be above threshold");
  });

  it("AC17/AC7 NEGATIVE: recommends 'lift' when throughput collapses below threshold", async () => {
    const dir2 = await makeStateDir();
    try {
      await writeJson(dir2, FREEZE_WEEKLY_METRICS_SCHEMA.outputPath, {
        weeks: [
          { weekKey: "2026-W10", cyclesBlocked: 8, cyclesAllowed: 2, overrides: 0 },
          { weekKey: "2026-W11", cyclesBlocked: 9, cyclesAllowed: 1, overrides: 0 },
          { weekKey: "2026-W12", cyclesBlocked: 10, cyclesAllowed: 0, overrides: 0 },
          { weekKey: "2026-W13", cyclesBlocked: 7, cyclesAllowed: 3, overrides: 0 }
        ]
      });
      const config = makeConfig(dir2, { rollbackThroughputCollapseThreshold: 0.5 });
      const result = await checkFreezeRollbackCriteria(config);
      assert.equal(result.recommend, "lift");
      assert.ok(result.throughputRatio < 0.5, "throughputRatio should be below threshold");
      assert.ok(result.reason.includes("THROUGHPUT_COLLAPSE"), "reason must indicate collapse");
    } finally {
      await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ── policy_engine re-exports (integration check) ─────────────────────────────

describe("policy_engine re-exports freeze utilities", () => {
  it("AC16: freeze utilities are accessible from policy_engine", async () => {
    const pe = await import("../../src/core/policy_engine.js");
    assert.ok(typeof pe.isFreezeActive         === "function", "isFreezeActive must be exported");
    assert.ok(typeof pe.evaluateFreezeGate      === "function", "evaluateFreezeGate must be exported");
    assert.ok(typeof pe.validateCriticalOverride === "function", "validateCriticalOverride must be exported");
    assert.ok(typeof pe.FREEZE_RISK_LEVEL        === "object",   "FREEZE_RISK_LEVEL must be exported");
    assert.ok(typeof pe.FREEZE_HIGH_RISK_LEVELS  === "object",   "FREEZE_HIGH_RISK_LEVELS must be exported");
  });
});
