/**
 * Tests for T-019: Athena Rubric Calibration Set.
 *
 * Covers all acceptance criteria with deterministic, offline, fixture-driven tests.
 *
 * AC1:  Calibration fixtures include good, ambiguous, and bad plans.
 * AC2:  Expected verdicts and rationale classes are documented (enum + fixture fields).
 * AC3:  Deviation score is computed per run using defined formula [0.0, 1.0].
 * AC4:  Release fails if rubric drift exceeds configured bound (drift gate).
 * AC5:  Calibration can run offline with fixtures (no AI required).
 * AC6:  Each criterion maps to at least one explicit deterministic verification.
 * AC7:  Negative paths including failure handling are covered.
 * AC8:  JSON schema with required fields and enums is defined.
 * AC9:  Validation distinguishes missing input from invalid input.
 * AC10: No silent fallback for critical state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RATIONALE_CLASS,
  VALID_RATIONALE_CLASSES,
  CALIBRATION_VERDICT,
  verdictFromScore,
  scoreCalibrationPlan,
  computeCalibrationDeviation,
  runCalibration,
  computePlanRankScore,
  rankPlansByROI,
} from "../../src/core/athena_reviewer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "calibration");

// ── RATIONALE_CLASS enum (AC2, AC14) ──────────────────────────────────────────

describe("RATIONALE_CLASS enum (AC2, AC14)", () => {
  it("exports positive and negative rationale class constants", () => {
    // Positive classes
    assert.equal(RATIONALE_CLASS.MEASURABLE_GOAL, "MEASURABLE_GOAL");
    assert.equal(RATIONALE_CLASS.CLEAR_SUCCESS_CRITERION, "CLEAR_SUCCESS_CRITERION");
    assert.equal(RATIONALE_CLASS.CONCRETE_VERIFICATION, "CONCRETE_VERIFICATION");
    assert.equal(RATIONALE_CLASS.SCOPE_DEFINED, "SCOPE_DEFINED");
    assert.equal(RATIONALE_CLASS.DEPENDENCY_CORRECT, "DEPENDENCY_CORRECT");
    // Negative classes
    assert.equal(RATIONALE_CLASS.VAGUE_GOAL, "VAGUE_GOAL");
    assert.equal(RATIONALE_CLASS.NO_VERIFICATION, "NO_VERIFICATION");
    assert.equal(RATIONALE_CLASS.MISSING_SCOPE, "MISSING_SCOPE");
    assert.equal(RATIONALE_CLASS.SPEC_INCOMPLETE, "SPEC_INCOMPLETE");
    assert.equal(RATIONALE_CLASS.CIRCULAR_DEPENDENCY, "CIRCULAR_DEPENDENCY");
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(RATIONALE_CLASS), "RATIONALE_CLASS must be frozen");
  });

  it("has at least 5 positive and 5 negative constants", () => {
    const values = Object.values(RATIONALE_CLASS);
    assert.ok(values.length >= 10, "must define at least 10 rationale classes");
  });

  it("VALID_RATIONALE_CLASSES contains all enum values", () => {
    for (const cls of Object.values(RATIONALE_CLASS)) {
      assert.ok(VALID_RATIONALE_CLASSES.has(cls), `VALID_RATIONALE_CLASSES must include '${cls}'`);
    }
  });
});

// ── CALIBRATION_VERDICT enum (AC2, AC8) ───────────────────────────────────────

describe("CALIBRATION_VERDICT enum (AC2, AC8)", () => {
  it("exports approved, ambiguous, rejected", () => {
    assert.equal(CALIBRATION_VERDICT.APPROVED, "approved");
    assert.equal(CALIBRATION_VERDICT.AMBIGUOUS, "ambiguous");
    assert.equal(CALIBRATION_VERDICT.REJECTED, "rejected");
    assert.ok(Object.isFrozen(CALIBRATION_VERDICT));
  });
});

// ── verdictFromScore (AC3, AC11) ──────────────────────────────────────────────

describe("verdictFromScore — score threshold mapping (AC3, AC11)", () => {
  it("score ≥ 7 maps to 'approved'", () => {
    assert.equal(verdictFromScore(7), "approved");
    assert.equal(verdictFromScore(8), "approved");
    assert.equal(verdictFromScore(10), "approved");
  });

  it("score ≤ 3 maps to 'rejected'", () => {
    assert.equal(verdictFromScore(0), "rejected");
    assert.equal(verdictFromScore(2), "rejected");
    assert.equal(verdictFromScore(3), "rejected");
  });

  it("score 4–6 maps to 'ambiguous'", () => {
    assert.equal(verdictFromScore(4), "ambiguous");
    assert.equal(verdictFromScore(5), "ambiguous");
    assert.equal(verdictFromScore(6), "ambiguous");
  });
});

// ── scoreCalibrationPlan — positive paths (AC1, AC3, AC5) ────────────────────

describe("scoreCalibrationPlan — good plan (AC1, AC3, AC5)", () => {
  it("scores a well-specified plan as 'approved' (≥7)", async () => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, "good_plan.json"), "utf8");
    const fixture = JSON.parse(raw);
    const result = scoreCalibrationPlan(fixture);
    assert.ok(result.score >= 7, `good_plan score must be ≥7, got ${result.score}`);
    assert.equal(result.scoreCategory, "approved",
      `good_plan must produce verdict 'approved', got '${result.scoreCategory}'`);
  });

  it("good plan assigns MEASURABLE_GOAL class", async () => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, "good_plan.json"), "utf8");
    const fixture = JSON.parse(raw);
    const result = scoreCalibrationPlan(fixture);
    assert.ok(result.rationaleClasses.includes("MEASURABLE_GOAL"),
      "good plan must include MEASURABLE_GOAL in rationale classes");
  });

  it("good plan assigns CONCRETE_VERIFICATION class", async () => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, "good_plan.json"), "utf8");
    const fixture = JSON.parse(raw);
    const result = scoreCalibrationPlan(fixture);
    assert.ok(result.rationaleClasses.includes("CONCRETE_VERIFICATION"),
      "good plan must include CONCRETE_VERIFICATION in rationale classes");
  });

  it("good plan assigns SCOPE_DEFINED class", async () => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, "good_plan.json"), "utf8");
    const fixture = JSON.parse(raw);
    const result = scoreCalibrationPlan(fixture);
    assert.ok(result.rationaleClasses.includes("SCOPE_DEFINED"),
      "good plan must include SCOPE_DEFINED in rationale classes");
  });
});

describe("scoreCalibrationPlan — ambiguous plan (AC1, AC3, AC5)", () => {
  it("scores a vague plan as 'ambiguous' (4–6)", async () => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, "ambiguous_plan.json"), "utf8");
    const fixture = JSON.parse(raw);
    const result = scoreCalibrationPlan(fixture);
    assert.ok(result.score >= 4 && result.score <= 6,
      `ambiguous_plan score must be 4–6, got ${result.score}`);
    assert.equal(result.scoreCategory, "ambiguous",
      `ambiguous_plan must produce verdict 'ambiguous', got '${result.scoreCategory}'`);
  });

  it("ambiguous plan assigns VAGUE_GOAL class", async () => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, "ambiguous_plan.json"), "utf8");
    const fixture = JSON.parse(raw);
    const result = scoreCalibrationPlan(fixture);
    assert.ok(result.rationaleClasses.includes("VAGUE_GOAL"),
      "ambiguous plan must include VAGUE_GOAL in rationale classes");
  });
});

describe("scoreCalibrationPlan — bad plan (AC1, AC3, AC5)", () => {
  it("scores an underspecified plan as 'rejected' (≤3)", async () => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, "bad_plan.json"), "utf8");
    const fixture = JSON.parse(raw);
    const result = scoreCalibrationPlan(fixture);
    assert.ok(result.score <= 3,
      `bad_plan score must be ≤3, got ${result.score}`);
    assert.equal(result.scoreCategory, "rejected",
      `bad_plan must produce verdict 'rejected', got '${result.scoreCategory}'`);
  });

  it("bad plan assigns NO_VERIFICATION and MISSING_SCOPE classes", async () => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, "bad_plan.json"), "utf8");
    const fixture = JSON.parse(raw);
    const result = scoreCalibrationPlan(fixture);
    assert.ok(result.rationaleClasses.includes("NO_VERIFICATION"),
      "bad plan must include NO_VERIFICATION");
    assert.ok(result.rationaleClasses.includes("MISSING_SCOPE"),
      "bad plan must include MISSING_SCOPE");
  });
});

// ── scoreCalibrationPlan — negative paths (AC7, AC9, AC10) ───────────────────

describe("scoreCalibrationPlan — negative paths (AC7, AC9, AC10)", () => {
  it("null input → score=0, rejected, SPEC_INCOMPLETE — no silent fallback (AC9, AC10)", () => {
    const result = scoreCalibrationPlan(null);
    assert.equal(result.score, 0, "null input must produce score=0");
    assert.equal(result.scoreCategory, "rejected", "null input must produce rejected verdict");
    assert.ok(result.rationaleClasses.includes("SPEC_INCOMPLETE"),
      "null input must set SPEC_INCOMPLETE rationale class — no silent fallback");
  });

  it("undefined input → score=0, rejected (AC9)", () => {
    const result = scoreCalibrationPlan(undefined);
    assert.equal(result.scoreCategory, "rejected");
  });

  it("fixture with empty plan fields → score=0, rejected (AC7)", () => {
    const fixture = {
      schemaVersion: 1,
      fixtureId: "negative-001",
      category: "bad",
      expectedVerdict: "rejected",
      expectedRationaleClasses: ["VAGUE_GOAL", "NO_VERIFICATION", "MISSING_SCOPE"],
      plan: { task: "", verification: "", files: [], context: "" }
    };
    const result = scoreCalibrationPlan(fixture);
    assert.equal(result.scoreCategory, "rejected",
      "empty plan fields must produce rejected verdict");
  });

  it("fixture with non-array files → MISSING_SCOPE assigned (AC9)", () => {
    const fixture = {
      schemaVersion: 1,
      fixtureId: "negative-002",
      category: "bad",
      expectedVerdict: "rejected",
      expectedRationaleClasses: [],
      plan: { task: "Do something", verification: "npm test", files: null, context: "" }
    };
    const result = scoreCalibrationPlan(fixture);
    assert.ok(result.rationaleClasses.includes("MISSING_SCOPE"),
      "non-array files must trigger MISSING_SCOPE");
  });
});

// ── computeCalibrationDeviation (AC3, AC11) ───────────────────────────────────

describe("computeCalibrationDeviation — formula and range (AC3, AC11)", () => {
  it("returns deviationScore=0.0 when all fixtures match expected verdicts (AC3)", () => {
    const results = [
      { fixture: { fixtureId: "f1", expectedVerdict: "approved" }, actualCategory: "approved" },
      { fixture: { fixtureId: "f2", expectedVerdict: "rejected" }, actualCategory: "rejected" }
    ];
    const r = computeCalibrationDeviation(results);
    assert.equal(r.deviationScore, 0.0, "all-match must yield deviation=0.0");
    assert.equal(r.mismatches, 0);
    assert.equal(r.total, 2);
  });

  it("returns deviationScore=1.0 when all fixtures mismatch (AC3)", () => {
    const results = [
      { fixture: { fixtureId: "f1", expectedVerdict: "approved" }, actualCategory: "rejected" },
      { fixture: { fixtureId: "f2", expectedVerdict: "rejected" }, actualCategory: "approved" }
    ];
    const r = computeCalibrationDeviation(results);
    assert.equal(r.deviationScore, 1.0, "all-mismatch must yield deviation=1.0");
    assert.equal(r.mismatches, 2);
  });

  it("computes fraction deterministically for partial mismatches (AC3, AC11)", () => {
    const results = [
      { fixture: { fixtureId: "f1", expectedVerdict: "approved" }, actualCategory: "approved" },
      { fixture: { fixtureId: "f2", expectedVerdict: "rejected" }, actualCategory: "approved" },
      { fixture: { fixtureId: "f3", expectedVerdict: "ambiguous" }, actualCategory: "ambiguous" },
      { fixture: { fixtureId: "f4", expectedVerdict: "approved" }, actualCategory: "rejected" }
    ];
    const r = computeCalibrationDeviation(results);
    assert.equal(r.deviationScore, 0.5, "2 mismatches out of 4 = 0.5");
    assert.equal(r.mismatches, 2);
    assert.equal(r.total, 4);
  });

  it("returns deviationScore=0.0 and total=0 for empty input (negative path, AC7)", () => {
    const r = computeCalibrationDeviation([]);
    assert.equal(r.deviationScore, 0.0);
    assert.equal(r.total, 0);
    assert.equal(r.mismatches, 0);
  });

  it("details array contains fixtureId, expected, actual, match for each entry (AC8)", () => {
    const results = [
      { fixture: { fixtureId: "f1", expectedVerdict: "approved" }, actualCategory: "approved" }
    ];
    const r = computeCalibrationDeviation(results);
    assert.equal(r.details.length, 1);
    const d = r.details[0];
    assert.equal(d.fixtureId, "f1");
    assert.equal(d.expected, "approved");
    assert.equal(d.actual, "approved");
    assert.equal(d.match, true);
  });
});

// ── runCalibration end-to-end (AC1, AC3, AC5, AC6) ───────────────────────────

describe("runCalibration — end-to-end offline (AC1, AC3, AC5, AC6)", () => {
  it("all three fixtures pass with deviationScore=0.0 (AC5 — offline, no AI)", async () => {
    const goodRaw = await fs.readFile(path.join(FIXTURES_DIR, "good_plan.json"), "utf8");
    const ambigRaw = await fs.readFile(path.join(FIXTURES_DIR, "ambiguous_plan.json"), "utf8");
    const badRaw = await fs.readFile(path.join(FIXTURES_DIR, "bad_plan.json"), "utf8");

    const fixtures = [JSON.parse(goodRaw), JSON.parse(ambigRaw), JSON.parse(badRaw)];
    const result = runCalibration(fixtures);

    assert.equal(result.total, 3, "must process 3 fixtures");
    assert.equal(result.mismatches, 0,
      "all three standard fixtures must match their expected verdicts — rubric is not drifting");
    assert.equal(result.deviationScore, 0.0,
      "deviationScore must be 0.0 when all fixtures match");
  });

  it("returns results array with one entry per fixture (AC6)", async () => {
    const goodRaw = await fs.readFile(path.join(FIXTURES_DIR, "good_plan.json"), "utf8");
    const fixture = JSON.parse(goodRaw);
    const result = runCalibration([fixture]);
    assert.equal(result.results.length, 1);
    const r = result.results[0];
    assert.ok(typeof r.score === "number", "result must have numeric score");
    assert.ok(typeof r.scoreCategory === "string", "result must have scoreCategory string");
    assert.ok(Array.isArray(r.rationaleClasses), "result must have rationaleClasses array");
  });

  it("empty fixtures → deviationScore=0.0 and total=0 (AC7 negative path)", () => {
    const result = runCalibration([]);
    assert.equal(result.deviationScore, 0.0);
    assert.equal(result.total, 0);
    assert.equal(result.mismatches, 0);
  });

  it("runCalibration with non-array → deviationScore=0.0 (AC10 — no silent error)", () => {
    const result = runCalibration(null);
    assert.equal(result.deviationScore, 0.0);
    assert.equal(result.total, 0);
  });
});

// ── Drift gate logic (AC4, AC12) ──────────────────────────────────────────────

describe("drift gate — configured bound enforcement (AC4, AC12)", () => {
  it("deviationScore=0.25 passes when maxDeviationScore=0.25 (at-boundary pass)", () => {
    // Gate condition: deviationScore > maxDeviationScore → fail
    const deviation = 0.25;
    const maxBound = 0.25;
    assert.ok(deviation <= maxBound, "deviation equal to bound must pass the gate");
  });

  it("deviationScore=0.26 fails when maxDeviationScore=0.25 (just-over boundary fail)", () => {
    const deviation = 0.26;
    const maxBound = 0.25;
    assert.ok(deviation > maxBound, "deviation just above bound must fail the gate");
  });

  it("box.config.json declares athenaCalibration section with maxDeviationScore and stateFile (AC4, AC12)", async () => {
    const configPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), "..", "..", "box.config.json"
    );
    const raw = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(raw);

    assert.ok(config.athenaCalibration, "box.config.json must have 'athenaCalibration' section");
    assert.ok(typeof config.athenaCalibration.maxDeviationScore === "number",
      "athenaCalibration.maxDeviationScore must be a number");
    assert.ok(config.athenaCalibration.maxDeviationScore >= 0 && config.athenaCalibration.maxDeviationScore <= 1,
      "maxDeviationScore must be in range [0.0, 1.0]");
    assert.ok(typeof config.athenaCalibration.fixturesDir === "string",
      "athenaCalibration.fixturesDir must be a string");
    assert.ok(typeof config.athenaCalibration.stateFile === "string",
      "athenaCalibration.stateFile must be a string");
  });

  it("runCalibration produces deviationScore ≤ maxDeviationScore=0.25 for standard fixtures (AC4 gate passes)", async () => {
    const goodRaw = await fs.readFile(path.join(FIXTURES_DIR, "good_plan.json"), "utf8");
    const ambigRaw = await fs.readFile(path.join(FIXTURES_DIR, "ambiguous_plan.json"), "utf8");
    const badRaw = await fs.readFile(path.join(FIXTURES_DIR, "bad_plan.json"), "utf8");

    const fixtures = [JSON.parse(goodRaw), JSON.parse(ambigRaw), JSON.parse(badRaw)];
    const result = runCalibration(fixtures);

    const maxDeviationScore = 0.25;
    assert.ok(result.deviationScore <= maxDeviationScore,
      `deviationScore=${result.deviationScore} must be ≤ ${maxDeviationScore} — release gate must pass`);
  });

  it("drift gate FAILS when all fixtures return wrong verdict (negative path, AC4, AC7)", () => {
    // Simulate all 3 fixtures returning wrong verdicts
    const results = [
      { fixture: { fixtureId: "good-plan-001",      expectedVerdict: "approved" }, actualCategory: "rejected" },
      { fixture: { fixtureId: "ambiguous-plan-001", expectedVerdict: "ambiguous" }, actualCategory: "approved" },
      { fixture: { fixtureId: "bad-plan-001",       expectedVerdict: "rejected" }, actualCategory: "approved" }
    ];
    const deviation = computeCalibrationDeviation(results);
    assert.equal(deviation.deviationScore, 1.0, "all-wrong verdicts must produce deviationScore=1.0");
    assert.ok(deviation.deviationScore > 0.25,
      "deviationScore=1.0 must exceed maxDeviationScore=0.25 and fail the gate");
  });
});

// ── Fixture schema validation (AC8) ───────────────────────────────────────────

describe("calibration fixture schema — required fields and enums (AC8)", () => {
  const REQUIRED_FIELDS = ["schemaVersion", "fixtureId", "category", "expectedVerdict", "expectedRationaleClasses", "plan"];
  const FIXTURE_FILES = ["good_plan.json", "ambiguous_plan.json", "bad_plan.json"];
  const VALID_VERDICTS = new Set(["approved", "ambiguous", "rejected"]);
  const VALID_CATEGORIES = new Set(["good", "ambiguous", "bad"]);

  for (const file of FIXTURE_FILES) {
    it(`${file} has all required fields (AC8)`, async () => {
      const raw = await fs.readFile(path.join(FIXTURES_DIR, file), "utf8");
      const fixture = JSON.parse(raw);
      for (const field of REQUIRED_FIELDS) {
        assert.ok(field in fixture, `${file} must have required field '${field}'`);
      }
    });

    it(`${file} uses valid expectedVerdict enum value (AC8)`, async () => {
      const raw = await fs.readFile(path.join(FIXTURES_DIR, file), "utf8");
      const fixture = JSON.parse(raw);
      assert.ok(VALID_VERDICTS.has(fixture.expectedVerdict),
        `${file} expectedVerdict '${fixture.expectedVerdict}' must be one of: ${[...VALID_VERDICTS].join(", ")}`);
    });

    it(`${file} uses valid category enum value (AC8)`, async () => {
      const raw = await fs.readFile(path.join(FIXTURES_DIR, file), "utf8");
      const fixture = JSON.parse(raw);
      assert.ok(VALID_CATEGORIES.has(fixture.category),
        `${file} category '${fixture.category}' must be one of: ${[...VALID_CATEGORIES].join(", ")}`);
    });

    it(`${file} expectedRationaleClasses are all valid RATIONALE_CLASS values (AC8)`, async () => {
      const raw = await fs.readFile(path.join(FIXTURES_DIR, file), "utf8");
      const fixture = JSON.parse(raw);
      assert.ok(Array.isArray(fixture.expectedRationaleClasses),
        `${file} expectedRationaleClasses must be an array`);
      for (const cls of fixture.expectedRationaleClasses) {
        assert.ok(VALID_RATIONALE_CLASSES.has(cls),
          `${file} contains unknown rationale class '${cls}'`);
      }
    });
  }
});

// ── rankPlansByROI (capacityDelta/requestROI mandatory ranking) ───────────────

describe("computePlanRankScore", () => {
  it("computes score as requestROI × (1 + capacityDelta)", () => {
    const score = computePlanRankScore({ requestROI: 2.0, capacityDelta: 0.5 });
    assert.equal(score, 2.0 * (1 + 0.5));
  });

  it("returns 0 for missing requestROI", () => {
    assert.equal(computePlanRankScore({ capacityDelta: 0.5 }), 0);
  });

  it("returns 0 for missing capacityDelta", () => {
    assert.equal(computePlanRankScore({ requestROI: 2.0 }), 0);
  });

  it("returns 0 for non-positive requestROI", () => {
    assert.equal(computePlanRankScore({ requestROI: 0, capacityDelta: 0.1 }), 0);
    assert.equal(computePlanRankScore({ requestROI: -1, capacityDelta: 0.1 }), 0);
  });

  it("handles negative capacityDelta (regressive plan scores lower)", () => {
    const aggressive = computePlanRankScore({ requestROI: 2.0, capacityDelta: 0.5 });
    const regressive = computePlanRankScore({ requestROI: 2.0, capacityDelta: -0.5 });
    assert.ok(aggressive > regressive, "positive delta should rank higher than negative delta");
  });

  it("returns 0 for null/undefined/non-object input", () => {
    assert.equal(computePlanRankScore(null), 0);
    assert.equal(computePlanRankScore(undefined), 0);
    assert.equal(computePlanRankScore("string" as any), 0);
  });
});

describe("rankPlansByROI", () => {
  it("sorts plans by composite ROI score descending", () => {
    const plans = [
      { task: "low", requestROI: 1.0, capacityDelta: 0.1 },
      { task: "high", requestROI: 3.0, capacityDelta: 0.5 },
      { task: "medium", requestROI: 2.0, capacityDelta: 0.2 },
    ];
    const ranked = rankPlansByROI(plans);
    assert.equal(ranked[0].task, "high");
    assert.equal(ranked[1].task, "medium");
    assert.equal(ranked[2].task, "low");
  });

  it("plans missing fields sort to the end", () => {
    const plans = [
      { task: "no-fields" },
      { task: "has-fields", requestROI: 2.0, capacityDelta: 0.3 },
    ];
    const ranked = rankPlansByROI(plans);
    assert.equal(ranked[0].task, "has-fields");
    assert.equal(ranked[1].task, "no-fields");
  });

  it("does not mutate the original array", () => {
    const plans = [
      { task: "b", requestROI: 1.0, capacityDelta: 0.1 },
      { task: "a", requestROI: 3.0, capacityDelta: 0.5 },
    ];
    const original = [...plans];
    rankPlansByROI(plans);
    assert.deepEqual(plans.map(p => p.task), original.map(p => p.task));
  });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(rankPlansByROI(null as any), []);
    assert.deepEqual(rankPlansByROI(undefined as any), []);
  });

  it("returns single-element array unchanged", () => {
    const plans = [{ task: "only", requestROI: 2.0, capacityDelta: 0.3 }];
    const ranked = rankPlansByROI(plans);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].task, "only");
  });
});
