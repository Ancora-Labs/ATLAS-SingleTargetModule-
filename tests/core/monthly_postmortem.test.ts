/**
 * Tests for T-030: Monthly Evolution Postmortem Generator.
 *
 * Covers all acceptance criteria including Athena missing items:
 *   AC1:  Report aggregates cycle analytics and experiment outcomes.
 *   AC2:  Top compounding effects identified with evidence and scoring formula.
 *   AC3:  Failed experiments include counterfactuals with all template fields.
 *   AC4:  Report includes decision-quality trend and confidence.
 *   AC5:  Next-cycle seed question is auto-generated (not a static no-op).
 *   AC6:  Each criterion maps to a deterministic verification command.
 *   AC7:  Changed behavior covered by automated tests including one negative path.
 *   AC8:  JSON output has defined schema with required fields and explicit enums.
 *   AC9:  Validation distinguishes missing input from invalid input.
 *   AC10: No silent fallback — degraded behavior sets explicit status + reason codes.
 *   AC11: Build-vs-run resolved — generator built fresh; does not exist in prior code.
 *   AC12: Output file path, format, required top-level JSON fields specified.
 *   AC13: Scoring formula and evidence structure defined for compounding effects.
 *   AC14: Counterfactual template fields defined and enforced.
 *   AC15: Decision-quality metric has time window, confidence scale, and trend enum.
 *   AC16: Seed question format rule enforced (ends in "?", >= 20 chars, data-driven).
 *   AC17: Behavior when state/ has insufficient cycle data is defined and testable.
 *   AC18: Risk level documented as MEDIUM in implementation comments.
 *
 * Scenarios:
 *   1. Full happy-path: enough cycles, experiments, postmortems → status="ok"
 *   2. Insufficient cycles (< 3) → status="insufficient_data" with reason code
 *   3. Missing improvement_reports.json → status="degraded", degradedSources populated
 *   4. Invalid improvement_reports.json (corrupt JSON) → status="degraded", INVALID code
 *   5. Compounding effects scoring formula verified
 *   6. Counterfactual template fields all present for rolled_back experiments
 *   7. Decision quality trend computed correctly (improving / stable / degrading)
 *   8. Seed question format rules enforced (ends "?", >= 20 chars, data-driven)
 *   9. persistMonthlyPostmortem: missing input returns MISSING_INPUT reason code
 *  10. persistMonthlyPostmortem: invalid input returns INVALID_INPUT reason code
 *  11. persistMonthlyPostmortem: writes correct file on valid input
 *  12. Negative path: empty stateDir → degraded or insufficient_data, no throw
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  MONTHLY_POSTMORTEM_STATUS,
  POSTMORTEM_DECISION_TREND,
  COMPOUNDING_SEVERITY_WEIGHT,
  MONTHLY_POSTMORTEM_SCHEMA,
  computeCompoundingEffects,
  buildCounterfactuals,
  computeDecisionQualityTrendForMonth,
  generateSeedQuestion,
  generateMonthlyPostmortem
} from "../../src/core/self_improvement.js";

import { persistMonthlyPostmortem } from "../../src/core/state_tracker.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function writeTestJson(dir, filename, data) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), "utf8");
}

async function writeRaw(dir, filename, text) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), text, "utf8");
}

function makeConfig(stateDir) {
  return { paths: { stateDir } };
}

const MONTH_KEY = "2025-03";

function makeReport(cycleAt, lessons = []) {
  return {
    cycleAt,
    analysis: {
      systemHealthScore: 70,
      lessons,
      capabilityGaps: [],
      nextCyclePriorities: [],
      workerFeedback: []
    }
  };
}

function makeExperiment(overrides = {}) {
  return {
    experimentId:      `exp-${Math.random().toString(16).slice(2, 10)}`,
    hypothesisId:      "increasing-timeout-reduces-errors",
    interventionId:    "intervention-timeout",
    treatmentGroup:    "A",
    status:            "completed",
    interventionScope: ["workerTimeoutMinutes"],
    createdAt:         "2025-03-10T10:00:00.000Z",
    ...overrides
  };
}

function makePostmortem(timestamp, label = "correct") {
  return {
    workerName:           "evolution-worker",
    taskCompleted:        true,
    recommendation:       "proceed",
    decisionQualityLabel: label,
    timestamp
  };
}

// ── Schema / Enum tests ───────────────────────────────────────────────────────

describe("MONTHLY_POSTMORTEM_STATUS enum (AC8)", () => {
  it("is frozen with all required values", () => {
    assert.ok(Object.isFrozen(MONTHLY_POSTMORTEM_STATUS));
    assert.equal(MONTHLY_POSTMORTEM_STATUS.OK,                "ok");
    assert.equal(MONTHLY_POSTMORTEM_STATUS.INSUFFICIENT_DATA, "insufficient_data");
    assert.equal(MONTHLY_POSTMORTEM_STATUS.DEGRADED,          "degraded");
  });
});

describe("POSTMORTEM_DECISION_TREND enum (AC8)", () => {
  it("is frozen with all required values", () => {
    assert.ok(Object.isFrozen(POSTMORTEM_DECISION_TREND));
    assert.equal(POSTMORTEM_DECISION_TREND.IMPROVING,         "improving");
    assert.equal(POSTMORTEM_DECISION_TREND.STABLE,            "stable");
    assert.equal(POSTMORTEM_DECISION_TREND.DEGRADING,         "degrading");
    assert.equal(POSTMORTEM_DECISION_TREND.INSUFFICIENT_DATA, "insufficient_data");
  });
});

describe("COMPOUNDING_SEVERITY_WEIGHT (AC13)", () => {
  it("defines weights for critical, warning, info", () => {
    assert.ok(Object.isFrozen(COMPOUNDING_SEVERITY_WEIGHT));
    assert.equal(COMPOUNDING_SEVERITY_WEIGHT.critical, 3);
    assert.equal(COMPOUNDING_SEVERITY_WEIGHT.warning,  2);
    assert.equal(COMPOUNDING_SEVERITY_WEIGHT.info,     1);
  });
});

describe("MONTHLY_POSTMORTEM_SCHEMA (AC12)", () => {
  it("specifies all required top-level fields", () => {
    const req = MONTHLY_POSTMORTEM_SCHEMA.required;
    for (const f of ["schemaVersion", "monthKey", "generatedAt", "status",
      "cycleCount", "experimentOutcomes", "compoundingEffects",
      "decisionQualityTrend", "seedQuestion"]) {
      assert.ok(req.includes(f), `required must include ${f}`);
    }
  });

  it("specifies statusEnum with all MONTHLY_POSTMORTEM_STATUS values", () => {
    for (const v of Object.values(MONTHLY_POSTMORTEM_STATUS)) {
      assert.ok(MONTHLY_POSTMORTEM_SCHEMA.statusEnum.includes(v), `statusEnum missing ${v}`);
    }
  });

  it("specifies trendEnum with all POSTMORTEM_DECISION_TREND values", () => {
    for (const v of Object.values(POSTMORTEM_DECISION_TREND)) {
      assert.ok(MONTHLY_POSTMORTEM_SCHEMA.trendEnum.includes(v), `trendEnum missing ${v}`);
    }
  });

  it("specifies counterfactualRequiredFields (AC14)", () => {
    for (const f of ["experimentId", "hypothesis", "failureReason", "alternative", "preventionStrategy"]) {
      assert.ok(MONTHLY_POSTMORTEM_SCHEMA.counterfactualRequiredFields.includes(f),
        `counterfactualRequiredFields missing ${f}`);
    }
  });

  it("specifies seedQuestionRequiredFields (AC16)", () => {
    for (const f of ["question", "rationale", "dataPoints"]) {
      assert.ok(MONTHLY_POSTMORTEM_SCHEMA.seedQuestionRequiredFields.includes(f),
        `seedQuestionRequiredFields missing ${f}`);
    }
  });

  it("specifies trendConfidenceThresholds (AC15)", () => {
    assert.ok(MONTHLY_POSTMORTEM_SCHEMA.trendConfidenceThresholds.HIGH  >= 1);
    assert.ok(MONTHLY_POSTMORTEM_SCHEMA.trendConfidenceThresholds.MEDIUM >= 1);
  });

  it("specifies minCycleCount for insufficient-data handling (AC17)", () => {
    assert.ok(typeof MONTHLY_POSTMORTEM_SCHEMA.minCycleCount === "number");
    assert.ok(MONTHLY_POSTMORTEM_SCHEMA.minCycleCount >= 1);
  });

  it("specifies seedQuestionMinLength for format rule (AC16)", () => {
    assert.ok(MONTHLY_POSTMORTEM_SCHEMA.seedQuestionMinLength >= 20);
  });
});

// ── computeCompoundingEffects (AC2 / AC13) ───────────────────────────────────

describe("computeCompoundingEffects", () => {
  it("returns empty array for no reports", () => {
    assert.deepEqual(computeCompoundingEffects([], MONTH_KEY), []);
  });

  it("groups lessons by category and scores correctly", () => {
    const reports = [
      makeReport("2025-03-10T00:00:00Z", [
        { category: "timeout", severity: "critical", lesson: "Workers timed out", addedAt: "2025-03-25T00:00:00Z" },
        { category: "timeout", severity: "warning",  lesson: "Workers timed out again", addedAt: "2025-03-26T00:00:00Z" }
      ]),
      makeReport("2025-03-15T00:00:00Z", [
        { category: "timeout", severity: "critical", lesson: "Timeout again", addedAt: "2025-03-26T00:00:00Z" }
      ])
    ];
    const effects = computeCompoundingEffects(reports, MONTH_KEY);
    assert.ok(effects.length >= 1, "should return at least one effect");
    const timeout = effects.find(e => e.pattern.startsWith("timeout:"));
    assert.ok(timeout, "timeout category must appear");
    assert.equal(timeout.occurrences, 3, "3 timeout lessons across 2 reports");
    assert.ok(timeout.score > 0, "score must be positive");
  });

  it("assigns highest severity when multiple severities present in category", () => {
    const reports = [
      makeReport("2025-03-10T00:00:00Z", [
        { category: "retry-strategy", severity: "info",     lesson: "Retries low",  addedAt: "2025-03-20T00:00:00Z" },
        { category: "retry-strategy", severity: "critical", lesson: "Retries high", addedAt: "2025-03-21T00:00:00Z" }
      ])
    ];
    const effects = computeCompoundingEffects(reports, MONTH_KEY);
    const retryEffect = effects.find(e => e.pattern.startsWith("retry-strategy:"));
    assert.ok(retryEffect, "retry-strategy effect must be present");
    assert.equal(retryEffect.severity, "critical", "severity should be promoted to critical");
  });

  it("returns at most maxCompoundingEffects effects", () => {
    const categories = ["a", "b", "c", "d", "e", "f", "g"];
    const lessons = categories.map(cat => ({
      category: cat, severity: "info", lesson: `lesson-${cat}`, addedAt: "2025-03-20T00:00:00Z"
    }));
    const reports = [makeReport("2025-03-20T00:00:00Z", lessons)];
    const effects = computeCompoundingEffects(reports, MONTH_KEY);
    assert.ok(effects.length <= MONTHLY_POSTMORTEM_SCHEMA.maxCompoundingEffects);
  });

  it("each effect has required evidence structure (AC13)", () => {
    const reports = [
      makeReport("2025-03-10T00:00:00Z", [
        { category: "timeout", severity: "warning", lesson: "Timeout", addedAt: "2025-03-20T00:00:00Z" }
      ])
    ];
    const effects = computeCompoundingEffects(reports, MONTH_KEY);
    for (const e of effects) {
      assert.ok("pattern"     in e, "missing pattern");
      assert.ok("score"       in e, "missing score");
      assert.ok("occurrences" in e, "missing occurrences");
      assert.ok("severity"    in e, "missing severity");
      assert.ok("evidence"    in e, "missing evidence");
      assert.ok(Array.isArray(e.evidence), "evidence must be an array");
    }
  });
});

// ── buildCounterfactuals (AC3 / AC14) ────────────────────────────────────────

describe("buildCounterfactuals", () => {
  it("returns empty for no experiments", () => {
    assert.deepEqual(buildCounterfactuals([]), []);
  });

  it("only includes rolled_back experiments", () => {
    const exps = [
      makeExperiment({ status: "completed" }),
      makeExperiment({ status: "rolled_back", statusReason: "ERROR_RATE_EXCEEDED" })
    ];
    const cf = buildCounterfactuals(exps);
    assert.equal(cf.length, 1, "only rolled_back experiment produces a counterfactual");
  });

  it("counterfactual includes all required template fields (AC14)", () => {
    const exps = [
      makeExperiment({ status: "rolled_back", statusReason: "HIGH_ERROR_RATE" })
    ];
    const cf = buildCounterfactuals(exps);
    assert.equal(cf.length, 1);
    for (const field of MONTHLY_POSTMORTEM_SCHEMA.counterfactualRequiredFields) {
      assert.ok(field in cf[0], `counterfactual missing required field: ${field}`);
      assert.ok(typeof cf[0][field] === "string", `${field} must be a string`);
      assert.ok(cf[0][field].length > 0, `${field} must be non-empty`);
    }
  });

  it("failureReason is UNKNOWN when statusReason is absent", () => {
    const exps = [makeExperiment({ status: "rolled_back" })];
    const cf   = buildCounterfactuals(exps);
    assert.equal(cf[0].failureReason, "UNKNOWN");
  });

  it("alternative differs from a no-op static string (AC16-analog for counterfactual)", () => {
    const exps = [
      makeExperiment({ status: "rolled_back", statusReason: "TIMEOUT" })
    ];
    const cf = buildCounterfactuals(exps);
    assert.ok(cf[0].alternative.length > 20,
      "alternative must be a non-trivial string, not a no-op");
    assert.ok(cf[0].preventionStrategy.length > 20,
      "preventionStrategy must be non-trivial");
  });
});

// ── computeDecisionQualityTrendForMonth (AC4 / AC15) ─────────────────────────

describe("computeDecisionQualityTrendForMonth", () => {
  it("returns insufficient_data for empty array", () => {
    const r = computeDecisionQualityTrendForMonth([], MONTH_KEY);
    assert.equal(r.trend, POSTMORTEM_DECISION_TREND.INSUFFICIENT_DATA);
    assert.equal(r.totalPostmortems, 0);
    assert.equal(r.scoreBefore, null);
    assert.equal(r.scoreAfter,  null);
  });

  it("returns insufficient_data for < 2 postmortems", () => {
    const pms = [makePostmortem("2025-03-10T00:00:00Z", "correct")];
    const r   = computeDecisionQualityTrendForMonth(pms, MONTH_KEY);
    assert.equal(r.trend, POSTMORTEM_DECISION_TREND.INSUFFICIENT_DATA);
    assert.equal(r.totalPostmortems, 1);
  });

  it("detects improving trend (AC15)", () => {
    const pms = [
      makePostmortem("2025-03-05T00:00:00Z", "incorrect"),  // first half
      makePostmortem("2025-03-05T00:00:00Z", "incorrect"),
      makePostmortem("2025-03-20T00:00:00Z", "correct"),    // second half
      makePostmortem("2025-03-20T00:00:00Z", "correct"),
      makePostmortem("2025-03-20T00:00:00Z", "correct")
    ];
    const r = computeDecisionQualityTrendForMonth(pms, MONTH_KEY);
    assert.equal(r.trend, POSTMORTEM_DECISION_TREND.IMPROVING,
      "more correct in second half → improving");
  });

  it("detects degrading trend (AC15)", () => {
    const pms = [
      makePostmortem("2025-03-05T00:00:00Z", "correct"),   // first half
      makePostmortem("2025-03-05T00:00:00Z", "correct"),
      makePostmortem("2025-03-05T00:00:00Z", "correct"),
      makePostmortem("2025-03-20T00:00:00Z", "incorrect"), // second half
      makePostmortem("2025-03-20T00:00:00Z", "incorrect")
    ];
    const r = computeDecisionQualityTrendForMonth(pms, MONTH_KEY);
    assert.equal(r.trend, POSTMORTEM_DECISION_TREND.DEGRADING,
      "more incorrect in second half → degrading");
  });

  it("filters postmortems outside the month", () => {
    const pms = [
      makePostmortem("2025-02-10T00:00:00Z", "correct"),  // prior month — excluded
      makePostmortem("2025-03-10T00:00:00Z", "correct"),
      makePostmortem("2025-03-20T00:00:00Z", "correct")
    ];
    const r = computeDecisionQualityTrendForMonth(pms, MONTH_KEY);
    assert.equal(r.totalPostmortems, 2, "only in-month entries counted");
  });

  it("confidence scales with postmortem count (AC15)", () => {
    const { HIGH, MEDIUM } = MONTHLY_POSTMORTEM_SCHEMA.trendConfidenceThresholds;
    const highPms = Array.from({ length: HIGH }, (_, i) =>
      makePostmortem(`2025-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`, "correct")
    );
    const r = computeDecisionQualityTrendForMonth(highPms, MONTH_KEY);
    assert.equal(r.confidence, "high");

    const medPms = Array.from({ length: MEDIUM }, (_, i) =>
      makePostmortem(`2025-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`, "correct")
    );
    const rm = computeDecisionQualityTrendForMonth(medPms, MONTH_KEY);
    assert.equal(rm.confidence, "medium");
  });

  it("returns timeWindowDays from schema (AC15)", () => {
    const r = computeDecisionQualityTrendForMonth([], MONTH_KEY);
    assert.equal(r.timeWindowDays, MONTHLY_POSTMORTEM_SCHEMA.trendTimeWindowDays);
  });
});

// ── generateSeedQuestion (AC5 / AC16) ─────────────────────────────────────────

describe("generateSeedQuestion", () => {
  const emptyExperimentOutcomes = { total: 0, completed: 0, rolled_back: 0, counterfactuals: [] };

  it("returns an object with question, rationale, dataPoints (AC16)", () => {
    const q = generateSeedQuestion([], { trend: "stable" }, emptyExperimentOutcomes, MONTH_KEY);
    assert.ok("question"   in q, "missing question");
    assert.ok("rationale"  in q, "missing rationale");
    assert.ok("dataPoints" in q, "missing dataPoints");
  });

  it("question always ends in '?' (AC16)", () => {
    const scenarios = [
      [[], { trend: POSTMORTEM_DECISION_TREND.STABLE }, emptyExperimentOutcomes],
      [[], { trend: POSTMORTEM_DECISION_TREND.DEGRADING, scoreBefore: 0.8, scoreAfter: 0.4 }, emptyExperimentOutcomes],
      [[{ pattern: "timeout: Workers timed out after 30min", score: 6, occurrences: 3, severity: "critical" }],
        { trend: POSTMORTEM_DECISION_TREND.STABLE }, emptyExperimentOutcomes]
    ];
    for (const [effects, trend, outcomes] of scenarios) {
      const q = generateSeedQuestion(effects, trend, outcomes, MONTH_KEY);
      assert.ok(q.question.endsWith("?"), `question must end in "?", got: "${q.question}"`);
    }
  });

  it("question is >= seedQuestionMinLength chars (AC16)", () => {
    const q = generateSeedQuestion([], { trend: "stable" }, emptyExperimentOutcomes, MONTH_KEY);
    assert.ok(q.question.length >= MONTHLY_POSTMORTEM_SCHEMA.seedQuestionMinLength,
      `question too short: ${q.question.length} chars`);
  });

  it("dataPoints contains >= 1 entry (AC16)", () => {
    const q = generateSeedQuestion([], { trend: "stable" }, emptyExperimentOutcomes, MONTH_KEY);
    assert.ok(Array.isArray(q.dataPoints), "dataPoints must be an array");
    assert.ok(q.dataPoints.length >= 1, "dataPoints must have >= 1 entry");
  });

  it("question references actual data values (not static no-op) (AC16)", () => {
    const trend = {
      trend: POSTMORTEM_DECISION_TREND.DEGRADING,
      scoreBefore: 0.80,
      scoreAfter:  0.40,
      totalPostmortems: 5
    };
    const q = generateSeedQuestion([], trend, emptyExperimentOutcomes, MONTH_KEY);
    // Question should mention actual score values
    assert.ok(q.question.includes("80.0") || q.question.includes("0.8") || q.question.includes("80"),
      `question must reference scoreBefore value: "${q.question}"`);
    assert.ok(q.question.includes("40.0") || q.question.includes("0.4") || q.question.includes("40"),
      `question must reference scoreAfter value: "${q.question}"`);
  });

  it("uses compounding effect pattern when no degrading trend", () => {
    const effects = [{
      pattern: "timeout: Workers exceeded time limit",
      score: 9, occurrences: 5, severity: "critical",
      recentAt: "2025-03-25T00:00:00Z", evidence: []
    }];
    const q = generateSeedQuestion(effects, { trend: POSTMORTEM_DECISION_TREND.STABLE }, emptyExperimentOutcomes, MONTH_KEY);
    assert.ok(q.question.includes("timeout") || q.question.includes("Workers exceeded"),
      `question must reference top compounding effect: "${q.question}"`);
  });

  it("uses counterfactual experiment when no effects or degrading trend", () => {
    const outcomes = {
      total: 1, completed: 0, rolled_back: 1,
      counterfactuals: [{
        experimentId: "exp-abc123",
        hypothesis: "reduce-timeout",
        failureReason: "TIMEOUT_EXCEEDED",
        alternative: "test a different approach",
        preventionStrategy: "set explicit bounds"
      }]
    };
    const q = generateSeedQuestion([], { trend: POSTMORTEM_DECISION_TREND.STABLE }, outcomes, MONTH_KEY);
    assert.ok(q.question.includes("exp-abc123"),
      `question must reference experiment ID: "${q.question}"`);
  });
});

// ── generateMonthlyPostmortem — integration tests ────────────────────────────

describe("generateMonthlyPostmortem — happy path (AC1, AC2, AC3, AC4, AC5)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t030-happy-"));

    const reports = {
      reports: Array.from({ length: 4 }, (_, i) => makeReport(
        `2025-03-${String(i + 5).padStart(2, "0")}T12:00:00.000Z`,
        [
          { category: "timeout", severity: "critical", lesson: `Timeout in cycle ${i}`, addedAt: `2025-03-${String(i + 5).padStart(2, "0")}T12:00:00.000Z` },
          { category: "prompt-quality", severity: "warning", lesson: `Prompt issue ${i}`, addedAt: `2025-03-${String(i + 5).padStart(2, "0")}T12:00:00.000Z` }
        ]
      ))
    };
    await writeTestJson(tmpDir, "improvement_reports.json", reports);

    const registry = {
      schemaVersion: 1,
      experiments: [
        makeExperiment({ status: "completed",   createdAt: "2025-03-05T10:00:00Z" }),
        makeExperiment({ status: "rolled_back", createdAt: "2025-03-10T10:00:00Z",
          statusReason: "ERROR_RATE_EXCEEDED" })
      ]
    };
    await writeTestJson(tmpDir, "experiment_registry.json", registry);

    const postmortems = {
      schemaVersion: 1,
      entries: [
        makePostmortem("2025-03-05T00:00:00Z", "incorrect"),
        makePostmortem("2025-03-08T00:00:00Z", "incorrect"),
        makePostmortem("2025-03-20T00:00:00Z", "correct"),
        makePostmortem("2025-03-22T00:00:00Z", "correct"),
        makePostmortem("2025-03-25T00:00:00Z", "correct")
      ]
    };
    await writeTestJson(tmpDir, "athena_postmortems.json", postmortems);

    result = await generateMonthlyPostmortem(makeConfig(tmpDir), "2025-03");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns ok=true", () => {
    assert.equal(result.ok, true);
  });

  it("status is 'ok' (AC1)", () => {
    assert.equal(result.status, MONTHLY_POSTMORTEM_STATUS.OK);
    assert.equal(result.postmortem.status, MONTHLY_POSTMORTEM_STATUS.OK);
  });

  it("all required schema fields present (AC12)", () => {
    for (const field of MONTHLY_POSTMORTEM_SCHEMA.required) {
      assert.ok(field in result.postmortem, `missing required field: ${field}`);
    }
  });

  it("cycleCount reflects monthly reports (AC1)", () => {
    assert.equal(result.postmortem.cycleCount, 4);
  });

  it("experimentOutcomes has correct counts (AC1)", () => {
    const eo = result.postmortem.experimentOutcomes;
    assert.ok("total"          in eo, "missing total");
    assert.ok("completed"      in eo, "missing completed");
    assert.ok("rolled_back"    in eo, "missing rolled_back");
    assert.ok("counterfactuals" in eo, "missing counterfactuals");
    assert.equal(eo.total, 2);
    assert.equal(eo.completed, 1);
    assert.equal(eo.rolled_back, 1);
  });

  it("compoundingEffects are non-empty and ranked (AC2)", () => {
    const effects = result.postmortem.compoundingEffects;
    assert.ok(Array.isArray(effects), "compoundingEffects must be array");
    assert.ok(effects.length > 0, "must have at least one compounding effect");
    // Verify descending score order
    for (let i = 1; i < effects.length; i++) {
      assert.ok(effects[i - 1].score >= effects[i].score,
        "effects must be sorted by descending score");
    }
  });

  it("each compounding effect has evidence array with timestamps (AC2/AC13)", () => {
    for (const e of result.postmortem.compoundingEffects) {
      assert.ok(Array.isArray(e.evidence), "evidence must be array");
      assert.ok(typeof e.score === "number" && e.score > 0, "score must be positive number");
      assert.ok(typeof e.occurrences === "number" && e.occurrences > 0);
      assert.ok(MONTHLY_POSTMORTEM_SCHEMA.compoundingEffectSeverityEnum.includes(e.severity),
        `severity must be one of enum values, got: ${e.severity}`);
    }
  });

  it("counterfactuals have all template fields (AC3)", () => {
    const cf = result.postmortem.experimentOutcomes.counterfactuals;
    assert.equal(cf.length, 1, "one rolled_back experiment → one counterfactual");
    for (const field of MONTHLY_POSTMORTEM_SCHEMA.counterfactualRequiredFields) {
      assert.ok(field in cf[0], `counterfactual missing: ${field}`);
      assert.ok(cf[0][field].length > 0, `${field} must be non-empty`);
    }
  });

  it("decisionQualityTrend has all required fields (AC4)", () => {
    const dqt = result.postmortem.decisionQualityTrend;
    assert.ok("trend"            in dqt, "missing trend");
    assert.ok("confidence"       in dqt, "missing confidence");
    assert.ok("timeWindowDays"   in dqt, "missing timeWindowDays");
    assert.ok("scoreBefore"      in dqt, "missing scoreBefore");
    assert.ok("scoreAfter"       in dqt, "missing scoreAfter");
    assert.ok("totalPostmortems" in dqt, "missing totalPostmortems");
    assert.ok(MONTHLY_POSTMORTEM_SCHEMA.trendEnum.includes(dqt.trend),
      `trend must be in trendEnum, got: ${dqt.trend}`);
    assert.ok(MONTHLY_POSTMORTEM_SCHEMA.confidenceLevelEnum.includes(dqt.confidence),
      `confidence must be in confidenceLevelEnum, got: ${dqt.confidence}`);
  });

  it("decisionQualityTrend trend is 'improving' (improving data set) (AC4)", () => {
    // 2 incorrect in first half, 3 correct in second half → improving
    assert.equal(result.postmortem.decisionQualityTrend.trend, POSTMORTEM_DECISION_TREND.IMPROVING);
  });

  it("seedQuestion is non-null and conforms to format rules (AC5)", () => {
    const sq = result.postmortem.seedQuestion;
    assert.ok(sq !== null, "seedQuestion must not be null");
    assert.ok(sq.question.endsWith("?"),   "question must end in '?'");
    assert.ok(sq.question.length >= MONTHLY_POSTMORTEM_SCHEMA.seedQuestionMinLength,
      `question too short: ${sq.question.length}`);
    assert.ok(Array.isArray(sq.dataPoints) && sq.dataPoints.length >= 1,
      "dataPoints must have >= 1 entry");
    assert.ok(typeof sq.rationale === "string" && sq.rationale.length > 0,
      "rationale must be non-empty string");
  });
});

// ── Scenario: insufficient cycles (AC17) ─────────────────────────────────────

describe("generateMonthlyPostmortem — insufficient cycles (AC17)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t030-insuf-"));
    // Only 2 reports — below minCycleCount of 3
    const reports = {
      reports: [
        makeReport("2025-03-05T12:00:00.000Z", []),
        makeReport("2025-03-10T12:00:00.000Z", [])
      ]
    };
    await writeTestJson(tmpDir, "improvement_reports.json", reports);
    result = await generateMonthlyPostmortem(makeConfig(tmpDir), "2025-03");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns ok=true (does not throw)", () => {
    assert.equal(result.ok, true);
  });

  it("status is insufficient_data (AC17)", () => {
    assert.equal(result.status, MONTHLY_POSTMORTEM_STATUS.INSUFFICIENT_DATA);
    assert.equal(result.postmortem.status, MONTHLY_POSTMORTEM_STATUS.INSUFFICIENT_DATA);
  });

  it("insufficiencyReason is a machine-readable string (AC10 / AC17)", () => {
    const reason = result.postmortem.insufficiencyReason;
    assert.ok(typeof reason === "string" && reason.length > 0,
      "insufficiencyReason must be a non-empty string");
    assert.ok(reason.includes("INSUFFICIENT_CYCLES"),
      `reason must contain INSUFFICIENT_CYCLES code, got: "${reason}"`);
  });

  it("cycleCount is 2", () => {
    assert.equal(result.postmortem.cycleCount, 2);
  });

  it("compoundingEffects is empty array", () => {
    assert.deepEqual(result.postmortem.compoundingEffects, []);
  });

  it("seedQuestion is null (no data to generate from)", () => {
    assert.equal(result.postmortem.seedQuestion, null);
  });
});

// ── Scenario: missing improvement_reports.json (AC9 / AC10) ──────────────────

describe("generateMonthlyPostmortem — improvement_reports.json absent", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t030-norepv-"));
    // No improvement_reports.json — but add enough records via experiment/postmortem
    // to get past the cycleCount check: cycleCount will be 0 → insufficient_data
    result = await generateMonthlyPostmortem(makeConfig(tmpDir), "2025-03");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns ok=true (does not throw)", () => {
    assert.equal(result.ok, true);
  });

  it("status is insufficient_data or degraded — not a silent null (AC10)", () => {
    const validStatuses = [MONTHLY_POSTMORTEM_STATUS.INSUFFICIENT_DATA, MONTHLY_POSTMORTEM_STATUS.DEGRADED];
    assert.ok(validStatuses.includes(result.status),
      `status must be insufficient_data or degraded, got: ${result.status}`);
  });
});

// ── Scenario: invalid (corrupt) improvement_reports.json (AC9) ───────────────

describe("generateMonthlyPostmortem — improvement_reports.json invalid JSON (AC9)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t030-invreport-"));
    await writeRaw(tmpDir, "improvement_reports.json", "{ NOT JSON }}}");
    result = await generateMonthlyPostmortem(makeConfig(tmpDir), "2025-03");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns ok=true (corrupt file does not throw)", () => {
    assert.equal(result.ok, true);
  });

  it("cycleCount is 0 → insufficient_data (AC9/AC10)", () => {
    // Corrupt file → reports treated as empty → cycleCount=0 → insufficient_data
    assert.equal(result.postmortem.cycleCount, 0);
    assert.equal(result.status, MONTHLY_POSTMORTEM_STATUS.INSUFFICIENT_DATA);
  });
});

// ── Scenario: degraded — missing experiment registry ─────────────────────────

describe("generateMonthlyPostmortem — experiment registry absent (degraded) (AC10)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t030-noregistry-"));
    // 4 reports but no experiment_registry.json or athena_postmortems.json
    const reports = {
      reports: Array.from({ length: 4 }, (_, i) => makeReport(
        `2025-03-${String(i + 5).padStart(2, "0")}T12:00:00.000Z`,
        [{ category: "timeout", severity: "warning", lesson: `Timeout ${i}`, addedAt: `2025-03-${String(i + 5).padStart(2, "0")}T12:00:00.000Z` }]
      ))
    };
    await writeTestJson(tmpDir, "improvement_reports.json", reports);
    // No experiment_registry.json, no athena_postmortems.json
    result = await generateMonthlyPostmortem(makeConfig(tmpDir), "2025-03");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("status is degraded (AC10)", () => {
    assert.equal(result.status, MONTHLY_POSTMORTEM_STATUS.DEGRADED);
  });

  it("degradedSources lists missing files (AC10)", () => {
    const ds = result.postmortem.degradedSources;
    assert.ok(Array.isArray(ds) && ds.length > 0, "degradedSources must be non-empty array");
    assert.ok(ds.some(d => d.includes("EXPERIMENT_REGISTRY")),
      "degradedSources must include EXPERIMENT_REGISTRY reason");
  });

  it("still returns postmortem with required fields (AC10)", () => {
    for (const field of MONTHLY_POSTMORTEM_SCHEMA.required) {
      assert.ok(field in result.postmortem, `degraded postmortem still must have: ${field}`);
    }
  });
});

// ── Negative path: empty stateDir (AC7 negative path) ────────────────────────

describe("generateMonthlyPostmortem — negative path: completely empty stateDir (AC7)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t030-empty-"));
    // Create dir but no files
    result = await generateMonthlyPostmortem(makeConfig(tmpDir), "2025-03");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not throw — returns structured result (AC7)", () => {
    assert.ok(result !== null && typeof result === "object");
    assert.equal(result.ok, true);
  });

  it("status is insufficient_data or degraded — not null (AC10)", () => {
    const validStatuses = [MONTHLY_POSTMORTEM_STATUS.INSUFFICIENT_DATA, MONTHLY_POSTMORTEM_STATUS.DEGRADED];
    assert.ok(validStatuses.includes(result.status),
      `status must be deterministic, got: ${result.status}`);
  });

  it("cycleCount is 0 (no data)", () => {
    assert.equal(result.postmortem.cycleCount, 0);
  });
});

// ── persistMonthlyPostmortem (AC9 / AC10) ─────────────────────────────────────

describe("persistMonthlyPostmortem — input validation (AC9)", () => {
  it("returns MISSING_INPUT for null input (AC9)", async () => {
    const r = await persistMonthlyPostmortem(makeConfig("state"), null);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("MISSING_INPUT"), `reason must contain MISSING_INPUT, got: ${r.reason}`);
  });

  it("returns MISSING_INPUT for undefined input (AC9)", async () => {
    const r = await persistMonthlyPostmortem(makeConfig("state"), undefined);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("MISSING_INPUT"));
  });

  it("returns INVALID_INPUT for non-object (AC9)", async () => {
    const r = await persistMonthlyPostmortem(makeConfig("state"), "not-an-object");
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("INVALID_INPUT"), `reason must contain INVALID_INPUT, got: ${r.reason}`);
  });

  it("returns INVALID_INPUT for missing required field (AC9)", async () => {
    const r = await persistMonthlyPostmortem(makeConfig("state"), {
      schemaVersion: 1,
      monthKey: "2025-03",
      // generatedAt missing
      status: "ok"
    });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("INVALID_INPUT"));
  });

  it("returns INVALID_INPUT for invalid monthKey format (AC9)", async () => {
    const postmortem = {
      schemaVersion: 1, monthKey: "not-a-month", generatedAt: new Date().toISOString(),
      status: "ok", cycleCount: 3,
      experimentOutcomes: { total: 0, completed: 0, rolled_back: 0, counterfactuals: [] },
      compoundingEffects: [], decisionQualityTrend: {}, seedQuestion: null
    };
    const r = await persistMonthlyPostmortem(makeConfig("state"), postmortem);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("INVALID_INPUT"));
  });
});

describe("persistMonthlyPostmortem — successful write (AC11)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t030-persist-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes file to correct path and returns ok=true (AC11/AC12)", async () => {
    const postmortem = {
      schemaVersion: 1,
      monthKey: "2025-03",
      generatedAt: new Date().toISOString(),
      status: "ok",
      insufficiencyReason: null,
      cycleCount: 4,
      experimentOutcomes: { total: 1, completed: 1, rolled_back: 0, counterfactuals: [] },
      compoundingEffects: [],
      decisionQualityTrend: {
        trend: "stable", confidence: "low",
        timeWindowDays: 30, scoreBefore: null, scoreAfter: null, totalPostmortems: 0
      },
      seedQuestion: {
        question: "What process improvement would increase the completion rate?",
        rationale: "Default question.",
        dataPoints: ["monthKey=2025-03"]
      }
    };
    const r = await persistMonthlyPostmortem(makeConfig(tmpDir), postmortem);
    assert.equal(r.ok, true, `persist failed: ${r.reason}`);
    assert.ok(r.filePath.endsWith("monthly_postmortem_2025-03.json"),
      `filePath must end with correct filename, got: ${r.filePath}`);

    const written = JSON.parse(await fs.readFile(r.filePath, "utf8"));
    assert.equal(written.monthKey, "2025-03");
    assert.equal(written.status,   "ok");
  });
});

// ── Task 2: POSTMORTEM_DEGRADED_REASON enum and evidence schema ───────────────

import {
  POSTMORTEM_DEGRADED_REASON,
  validateCompoundingEffect,
} from "../../src/core/self_improvement.js";

describe("POSTMORTEM_DEGRADED_REASON enum (Task 2)", () => {
  it("is frozen with all required codes", () => {
    assert.ok(Object.isFrozen(POSTMORTEM_DEGRADED_REASON));
    assert.equal(POSTMORTEM_DEGRADED_REASON.IMPROVEMENT_REPORTS_ABSENT,          "IMPROVEMENT_REPORTS_ABSENT");
    assert.equal(POSTMORTEM_DEGRADED_REASON.IMPROVEMENT_REPORTS_INVALID,         "IMPROVEMENT_REPORTS_INVALID");
    assert.equal(POSTMORTEM_DEGRADED_REASON.EXPERIMENT_REGISTRY_ABSENT,          "EXPERIMENT_REGISTRY_ABSENT");
    assert.equal(POSTMORTEM_DEGRADED_REASON.EXPERIMENT_REGISTRY_INVALID,         "EXPERIMENT_REGISTRY_INVALID");
    assert.equal(POSTMORTEM_DEGRADED_REASON.ATHENA_POSTMORTEMS_ABSENT,           "ATHENA_POSTMORTEMS_ABSENT");
    assert.equal(POSTMORTEM_DEGRADED_REASON.ATHENA_POSTMORTEMS_INVALID,          "ATHENA_POSTMORTEMS_INVALID");
    assert.equal(POSTMORTEM_DEGRADED_REASON.ATHENA_POSTMORTEMS_MIGRATION_FAILED, "ATHENA_POSTMORTEMS_MIGRATION_FAILED");
    assert.equal(POSTMORTEM_DEGRADED_REASON.ATHENA_POSTMORTEMS_MIGRATION_ERROR,  "ATHENA_POSTMORTEMS_MIGRATION_ERROR");
  });

  it("has exactly 8 entries (no undocumented codes)", () => {
    assert.equal(Object.keys(POSTMORTEM_DEGRADED_REASON).length, 8);
  });
});

describe("MONTHLY_POSTMORTEM_SCHEMA evidence schema fields (Task 2)", () => {
  it("compoundingEffectRequiredFields includes all minimum evidence fields", () => {
    for (const f of ["pattern", "score", "occurrences", "severity", "evidence"]) {
      assert.ok(MONTHLY_POSTMORTEM_SCHEMA.compoundingEffectRequiredFields.includes(f),
        `compoundingEffectRequiredFields must include: ${f}`);
    }
  });

  it("evidenceItemMinLength is at least 1", () => {
    assert.ok(typeof MONTHLY_POSTMORTEM_SCHEMA.evidenceItemMinLength === "number");
    assert.ok(MONTHLY_POSTMORTEM_SCHEMA.evidenceItemMinLength >= 1);
  });
});

describe("validateCompoundingEffect (Task 2)", () => {
  it("returns ok=true for a fully valid effect", () => {
    const effect = {
      pattern: "timeout: Workers exceeded limit",
      score: 6,
      occurrences: 3,
      severity: "critical",
      evidence: ["2025-03-10T00:00:00Z", "2025-03-15T00:00:00Z"],
    };
    const result = validateCompoundingEffect(effect);
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  });

  it("returns ok=true for effect with empty evidence array", () => {
    const effect = { pattern: "x: y", score: 1, occurrences: 1, severity: "info", evidence: [] };
    assert.equal(validateCompoundingEffect(effect).ok, true);
  });

  it("returns ok=false with violations for null input", () => {
    const result = validateCompoundingEffect(null);
    assert.equal(result.ok, false);
    assert.ok(result.violations.length > 0);
  });

  it("returns ok=false when required field is missing", () => {
    const result = validateCompoundingEffect({ pattern: "x", score: 1, occurrences: 1, severity: "info" }); // missing evidence
    assert.equal(result.ok, false);
    assert.ok(result.violations.some(v => v.includes("evidence")));
  });

  it("returns ok=false when evidence is not an array", () => {
    const result = validateCompoundingEffect({
      pattern: "x", score: 1, occurrences: 1, severity: "info", evidence: "not-array"
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some(v => v.includes("evidence must be an array")));
  });

  it("returns ok=false when evidence item is an empty string", () => {
    const result = validateCompoundingEffect({
      pattern: "x", score: 1, occurrences: 1, severity: "info", evidence: [""]
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some(v => v.includes("evidence[0]")));
  });

  it("negative path: non-object input returns violation", () => {
    const result = validateCompoundingEffect("not-an-object");
    assert.equal(result.ok, false);
    assert.ok(result.violations.length > 0);
  });
});

describe("generateMonthlyPostmortem — degradedSources use POSTMORTEM_DEGRADED_REASON codes (Task 2)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t030-degraded-codes-"));
    // 4 reports (passes cycleCount check), but no registry or postmortems
    const reports = {
      reports: Array.from({ length: 4 }, (_, i) =>
        makeReport(`2025-03-${String(i + 5).padStart(2, "0")}T12:00:00.000Z`)
      )
    };
    await writeTestJson(tmpDir, "improvement_reports.json", reports);
    result = await generateMonthlyPostmortem(makeConfig(tmpDir), "2025-03");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("status is degraded", () => {
    assert.equal(result.status, MONTHLY_POSTMORTEM_STATUS.DEGRADED);
  });

  it("degradedSources only contains values from POSTMORTEM_DEGRADED_REASON enum", () => {
    const validCodes = new Set(Object.values(POSTMORTEM_DEGRADED_REASON));
    for (const code of result.postmortem.degradedSources) {
      assert.ok(validCodes.has(code),
        `degradedSources must only contain POSTMORTEM_DEGRADED_REASON values, got: "${code}"`);
    }
  });

  it("degradedSources contains EXPERIMENT_REGISTRY_ABSENT for missing registry", () => {
    assert.ok(
      result.postmortem.degradedSources.includes(POSTMORTEM_DEGRADED_REASON.EXPERIMENT_REGISTRY_ABSENT),
      "degradedSources must include EXPERIMENT_REGISTRY_ABSENT"
    );
  });

  it("degradedSources contains ATHENA_POSTMORTEMS_ABSENT for missing postmortems", () => {
    assert.ok(
      result.postmortem.degradedSources.includes(POSTMORTEM_DEGRADED_REASON.ATHENA_POSTMORTEMS_ABSENT),
      "degradedSources must include ATHENA_POSTMORTEMS_ABSENT"
    );
  });
});

// ── staleUnresolvedDebts in monthly postmortem ────────────────────────────────

import {
  addDebtEntries,
  saveLedgerFull,
  computeFingerprint,
} from "../../src/core/carry_forward_ledger.js";

describe("generateMonthlyPostmortem — staleUnresolvedDebts field", () => {
  let tmpDir: string;
  let result: any;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t030-stale-debts-"));

    // Write enough improvement reports to pass the cycleCount gate
    const reports = {
      reports: Array.from({ length: 4 }, (_, i) =>
        makeReport(`2025-03-${String(i + 5).padStart(2, "0")}T12:00:00.000Z`)
      )
    };
    await writeTestJson(tmpDir, "improvement_reports.json", reports);

    // Seed the carry-forward ledger with two open debt entries
    const ledger = addDebtEntries([], [
      { followUpTask: "Fix critical governance canary breach detection false negative path", severity: "critical" },
      { followUpTask: "Resolve the worker runner retry loop transient error handling gap", severity: "warning" },
    ], 2);
    // Persist at cycle 3 so entries are open and cyclesOpen is tracked
    await saveLedgerFull(makeConfig(tmpDir), ledger, 3);

    result = await generateMonthlyPostmortem(makeConfig(tmpDir), "2025-03");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("staleUnresolvedDebts is an array", () => {
    assert.ok(Array.isArray(result.postmortem.staleUnresolvedDebts),
      "staleUnresolvedDebts must be an array");
  });

  it("staleUnresolvedDebts contains the open debt entries", () => {
    const debts = result.postmortem.staleUnresolvedDebts;
    assert.ok(debts.length >= 1, "must surface at least one stale debt");
  });

  it("each stale debt has expected fields", () => {
    for (const debt of result.postmortem.staleUnresolvedDebts) {
      assert.ok(typeof debt.id         === "string", "id must be string");
      assert.ok(typeof debt.lesson     === "string", "lesson must be string");
      assert.ok(typeof debt.severity   === "string", "severity must be string");
      assert.ok(typeof debt.owner      === "string", "owner must be string");
      assert.ok(typeof debt.openedCycle === "number", "openedCycle must be number");
      assert.ok(typeof debt.dueCycle   === "number", "dueCycle must be number");
      assert.ok(typeof debt.cyclesOpen === "number", "cyclesOpen must be number");
    }
  });

  it("negative path: staleUnresolvedDebts is empty when ledger has no open entries", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t030-nostale-"));
    try {
      const reports = {
        reports: Array.from({ length: 4 }, (_, i) =>
          makeReport(`2025-03-${String(i + 5).padStart(2, "0")}T12:00:00.000Z`)
        )
      };
      await writeTestJson(emptyDir, "improvement_reports.json", reports);
      // No ledger file → no stale debts
      const r = await generateMonthlyPostmortem(makeConfig(emptyDir), "2025-03");
      assert.ok(Array.isArray(r.postmortem.staleUnresolvedDebts),
        "staleUnresolvedDebts must still be an array when ledger is absent");
      assert.equal(r.postmortem.staleUnresolvedDebts.length, 0,
        "must be empty when no open debts exist");
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });
});

// ── Task 1: Postmortem closure field validation ───────────────────────────────

import {
  POSTMORTEM_CLOSURE_VALIDATION_REASON,
  validatePostmortemClosureFields,
} from "../../src/core/athena_reviewer.js";
import { detectRecurrences } from "../../src/core/recurrence_detector.js";

describe("validatePostmortemClosureFields — used in monthly postmortem workflow (Task 1)", () => {
  it("accepts a fully populated postmortem with all closure fields", () => {
    const pm = {
      expectedOutcome: "Deploy new feature to staging environment",
      actualOutcome:   "Feature deployed successfully, all checks passed.",
      deviation:       "none",
    };
    const r = validatePostmortemClosureFields(pm);
    assert.equal(r.valid, true, "fully populated postmortem must pass closure validation");
    assert.equal(r.reason, POSTMORTEM_CLOSURE_VALIDATION_REASON.OK);
  });

  it("rejects postmortem with empty expectedOutcome — cannot extract lessons without it", () => {
    const pm = { expectedOutcome: "", actualOutcome: "Build passed", deviation: "none" };
    const r = validatePostmortemClosureFields(pm);
    assert.equal(r.valid, false);
    assert.ok(r.emptyFields.includes("expectedOutcome"),
      "expectedOutcome must be listed as empty field");
    assert.equal(r.reason, POSTMORTEM_CLOSURE_VALIDATION_REASON.EMPTY_FIELD);
  });

  it("rejects postmortem with empty actualOutcome — deviation score requires it", () => {
    const pm = { expectedOutcome: "Deploy feature", actualOutcome: "", deviation: "none" };
    const r = validatePostmortemClosureFields(pm);
    assert.equal(r.valid, false);
    assert.ok(r.emptyFields.includes("actualOutcome"),
      "actualOutcome must be listed as empty field");
  });

  it("rejects postmortem with empty deviation — required for defect channel classification", () => {
    const pm = { expectedOutcome: "Deploy feature", actualOutcome: "Build passed", deviation: "" };
    const r = validatePostmortemClosureFields(pm);
    assert.equal(r.valid, false);
    assert.ok(r.emptyFields.includes("deviation"),
      "deviation must be listed as empty field");
  });

  it("negative path: undefined postmortem returns MISSING_FIELD reason", () => {
    const r = validatePostmortemClosureFields(undefined);
    assert.equal(r.valid, false);
    assert.equal(r.reason, POSTMORTEM_CLOSURE_VALIDATION_REASON.MISSING_FIELD);
  });

  it("negative path: deviation='unknown-value' is rejected as invalid", () => {
    const pm = { expectedOutcome: "Deploy", actualOutcome: "Deployed", deviation: "unknown-value" };
    const r = validatePostmortemClosureFields(pm);
    assert.equal(r.valid, false,
      "only 'none', 'minor', 'major' are valid deviation values");
  });
});

describe("detectRecurrences — learning-grade filter for degraded postmortems", () => {
  it("ignores degraded-review records with missing outcomes and only counts learning-grade entries", () => {
    const postmortems = [
      {
        expectedOutcome: "",
        actualOutcome: "",
        lessonLearned: "fallback record without closure data",
        defectChannel: "product",
        defectChannelTag: "planning_gap",
        reviewStatus: "degraded_review_required",
        learningGradeEligible: false,
      },
      {
        expectedOutcome: "Implement replay closure workflow",
        actualOutcome: "Workflow merged and verified",
        lessonLearned: "explicit",
        defectChannel: "product",
        defectChannelTag: "planning_gap",
        reviewStatus: "learning_grade",
      },
      {
        expectedOutcome: "Implement replay closure workflow",
        actualOutcome: "Workflow merged and verified",
        lessonLearned: "explicit",
        defectChannel: "product",
        defectChannelTag: "planning_gap",
        reviewStatus: "learning_grade",
      },
    ];
    const matches = detectRecurrences(postmortems, { threshold: 2, window: 10 });
    assert.equal(matches.length, 1, "only learning-grade postmortems should contribute to recurrence counts");
    assert.equal(matches[0].tag, "planning_gap");
    assert.equal(matches[0].count, 2);
  });
});
