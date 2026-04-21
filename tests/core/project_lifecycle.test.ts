/**
 * Tests for T-004: lifecycle completion schema alignment with Athena outputs.
 *
 * Covers:
 *   - normalizePostmortemVerdict: new schema, legacy schema, mixed, missing, invalid
 *   - collectWorkSummary: accurate completedTasks count from state fixtures
 *   - Release notes: completedTasks reflected in summary object
 *   - Negative paths: missing fields, invalid recommendations, null input
 *
 * Fixture schemas:
 *   New schema  postmortem: { workerName, recommendation, taskCompleted, ... }
 *   Legacy schema postmortem: { workerName, verdict, ... }  (backward compat)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  normalizePostmortemVerdict,
  POSTMORTEM_RECOMMENDATION,
  POSTMORTEM_PARSE_REASON
} from "../../src/core/athena_reviewer.js";

import { collectWorkSummary } from "../../src/core/project_lifecycle.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** New-schema postmortem (Athena v2 format — recommendation field) */
function newSchemaPostmortem(workerName, recommendation = "proceed") {
  return {
    workerName,
    taskCompleted: recommendation === "proceed",
    expectedOutcome: "Task done",
    actualOutcome: "Task done",
    deviation: "none",
    successCriteriaMet: recommendation === "proceed",
    lessonLearned: "test lesson",
    qualityScore: 8,
    followUpNeeded: false,
    followUpTask: "",
    recommendation,
    reviewedAt: new Date().toISOString(),
    model: "Claude Sonnet 4.6"
  };
}

/** Legacy-schema postmortem (pre-v2 format — verdict field, no recommendation) */
function legacySchemaPostmortem(workerName, verdict = "pass") {
  return {
    workerName,
    verdict,
    qualityScore: 7,
    lessonLearned: "legacy lesson",
    reviewedAt: new Date().toISOString()
  };
}

// ── normalizePostmortemVerdict — new schema ──────────────────────────────────

describe("normalizePostmortemVerdict — new schema (recommendation field)", () => {
  it("returns pass=true, schema='new' for recommendation=proceed", () => {
    const result = normalizePostmortemVerdict(newSchemaPostmortem("worker-a", "proceed"));
    assert.equal(result.pass, true);
    assert.equal(result.schema, "new");
    assert.equal(result.reason, POSTMORTEM_PARSE_REASON.OK);
  });

  it("returns pass=false for recommendation=rework", () => {
    const result = normalizePostmortemVerdict(newSchemaPostmortem("worker-b", "rework"));
    assert.equal(result.pass, false);
    assert.equal(result.schema, "new");
    assert.equal(result.reason, POSTMORTEM_PARSE_REASON.OK);
  });

  it("returns pass=false for recommendation=escalate", () => {
    const result = normalizePostmortemVerdict(newSchemaPostmortem("worker-c", "escalate"));
    assert.equal(result.pass, false);
    assert.equal(result.schema, "new");
    assert.equal(result.reason, POSTMORTEM_PARSE_REASON.OK);
  });

  it("POSTMORTEM_RECOMMENDATION enum exports deterministic values", () => {
    assert.equal(POSTMORTEM_RECOMMENDATION.PROCEED, "proceed");
    assert.equal(POSTMORTEM_RECOMMENDATION.REWORK, "rework");
    assert.equal(POSTMORTEM_RECOMMENDATION.ESCALATE, "escalate");
  });
});

// ── normalizePostmortemVerdict — legacy schema ───────────────────────────────

describe("normalizePostmortemVerdict — legacy schema (verdict field)", () => {
  it("returns pass=true, schema='legacy' for verdict=pass (backward compat)", () => {
    const result = normalizePostmortemVerdict(legacySchemaPostmortem("legacy-worker", "pass"));
    assert.equal(result.pass, true);
    assert.equal(result.schema, "legacy");
    assert.equal(result.reason, POSTMORTEM_PARSE_REASON.OK);
  });

  it("returns pass=false for verdict=fail (backward compat)", () => {
    const result = normalizePostmortemVerdict(legacySchemaPostmortem("legacy-worker", "fail"));
    assert.equal(result.pass, false);
    assert.equal(result.schema, "legacy");
    assert.equal(result.reason, POSTMORTEM_PARSE_REASON.OK);
  });

  it("does not read legacy verdict when new recommendation field is present", () => {
    // If both fields present, new schema takes precedence (normalize on read)
    const mixed = { ...legacySchemaPostmortem("worker", "pass"), recommendation: "rework" };
    const result = normalizePostmortemVerdict(mixed);
    assert.equal(result.pass, false, "recommendation='rework' must win over legacy verdict='pass'");
    assert.equal(result.schema, "new");
  });
});

// ── normalizePostmortemVerdict — negative paths ──────────────────────────────

describe("normalizePostmortemVerdict — negative paths (failure handling)", () => {
  it("returns pass=false, reason=MISSING_VERDICT when neither field present", () => {
    const result = normalizePostmortemVerdict({ workerName: "orphan", qualityScore: 5 });
    assert.equal(result.pass, false);
    assert.equal(result.reason, POSTMORTEM_PARSE_REASON.MISSING_VERDICT);
    assert.equal(result.schema, "unknown");
  });

  it("returns pass=false, reason=MISSING_VERDICT for null input", () => {
    const result = normalizePostmortemVerdict(null);
    assert.equal(result.pass, false);
    assert.equal(result.reason, POSTMORTEM_PARSE_REASON.MISSING_VERDICT);
  });

  it("returns pass=false, reason=MISSING_VERDICT for undefined input", () => {
    const result = normalizePostmortemVerdict(undefined);
    assert.equal(result.pass, false);
    assert.equal(result.reason, POSTMORTEM_PARSE_REASON.MISSING_VERDICT);
  });

  it("returns pass=false, reason=INVALID_RECOMMENDATION for unknown recommendation value", () => {
    const result = normalizePostmortemVerdict({ workerName: "worker", recommendation: "unknown_value" });
    assert.equal(result.pass, false);
    assert.equal(result.reason, POSTMORTEM_PARSE_REASON.INVALID_RECOMMENDATION);
    assert.equal(result.schema, "new");
  });

  it("distinguishes MISSING_VERDICT (no field) from INVALID_RECOMMENDATION (bad value)", () => {
    const missing = normalizePostmortemVerdict({ workerName: "a" });
    const invalid = normalizePostmortemVerdict({ workerName: "b", recommendation: "garbage" });
    assert.equal(missing.reason, POSTMORTEM_PARSE_REASON.MISSING_VERDICT);
    assert.equal(invalid.reason, POSTMORTEM_PARSE_REASON.INVALID_RECOMMENDATION);
    assert.notEqual(missing.reason, invalid.reason);
  });
});

// ── POSTMORTEM_PARSE_REASON enum ─────────────────────────────────────────────

describe("POSTMORTEM_PARSE_REASON enum", () => {
  it("exports deterministic reason constants", () => {
    assert.equal(POSTMORTEM_PARSE_REASON.OK, "OK");
    assert.equal(POSTMORTEM_PARSE_REASON.MISSING_VERDICT, "MISSING_VERDICT");
    assert.equal(POSTMORTEM_PARSE_REASON.INVALID_RECOMMENDATION, "INVALID_RECOMMENDATION");
  });
});

// ── collectWorkSummary — fixture-based tests ─────────────────────────────────

describe("collectWorkSummary — completedTasks counting from state fixtures", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-lifecycle-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(stateDir) {
    return {
      paths: { stateDir },
      env: { githubToken: null, targetRepo: null } // no GitHub calls
    };
  }

  it("counts new-schema postmortems with recommendation=proceed as completed", async () => {
    const postmortems = [
      newSchemaPostmortem("worker-a", "proceed"),
      newSchemaPostmortem("worker-b", "proceed"),
      newSchemaPostmortem("worker-c", "rework")
    ];
    await fs.writeFile(
      path.join(tmpDir, "athena_postmortems.json"),
      JSON.stringify(postmortems), "utf8"
    );

    const summary = await collectWorkSummary(makeConfig(tmpDir));
    assert.equal(summary.completedTasks.length, 2);
    assert.ok(summary.completedTasks.includes("worker-a"));
    assert.ok(summary.completedTasks.includes("worker-b"));
    assert.ok(!summary.completedTasks.includes("worker-c"),
      "rework tasks must NOT appear in completedTasks");
  });

  it("counts legacy-schema postmortems with verdict=pass as completed (backward compat)", async () => {
    const postmortems = [
      legacySchemaPostmortem("legacy-pass-1", "pass"),
      legacySchemaPostmortem("legacy-pass-2", "pass"),
      legacySchemaPostmortem("legacy-fail-1", "fail")
    ];
    await fs.writeFile(
      path.join(tmpDir, "athena_postmortems.json"),
      JSON.stringify(postmortems), "utf8"
    );

    const summary = await collectWorkSummary(makeConfig(tmpDir));
    assert.equal(summary.completedTasks.length, 2);
    assert.ok(summary.completedTasks.includes("legacy-pass-1"));
    assert.ok(summary.completedTasks.includes("legacy-pass-2"));
    assert.ok(!summary.completedTasks.includes("legacy-fail-1"),
      "verdict=fail must NOT appear in completedTasks");
  });

  it("handles mixed new and legacy schema fixtures accurately", async () => {
    const postmortems = [
      newSchemaPostmortem("new-proceed", "proceed"),
      newSchemaPostmortem("new-rework", "rework"),
      legacySchemaPostmortem("legacy-pass", "pass"),
      legacySchemaPostmortem("legacy-fail", "fail")
    ];
    await fs.writeFile(
      path.join(tmpDir, "athena_postmortems.json"),
      JSON.stringify(postmortems), "utf8"
    );

    const summary = await collectWorkSummary(makeConfig(tmpDir));
    assert.equal(summary.completedTasks.length, 2,
      "Mixed fixtures: 1 new-proceed + 1 legacy-pass = 2 completed");
    assert.ok(summary.completedTasks.includes("new-proceed"));
    assert.ok(summary.completedTasks.includes("legacy-pass"));
  });

  it("returns empty completedTasks when postmortems file is absent", async () => {
    // No athena_postmortems.json written — readJson defaults to []
    const summary = await collectWorkSummary(makeConfig(tmpDir));
    assert.deepEqual(summary.completedTasks, []);
  });

  it("skips records with neither recommendation nor verdict (no silent fallback)", async () => {
    const postmortems = [
      newSchemaPostmortem("good-worker", "proceed"),
      { workerName: "orphan-worker", qualityScore: 5 }  // missing both fields
    ];
    await fs.writeFile(
      path.join(tmpDir, "athena_postmortems.json"),
      JSON.stringify(postmortems), "utf8"
    );

    const summary = await collectWorkSummary(makeConfig(tmpDir));
    assert.equal(summary.completedTasks.length, 1,
      "Orphan record (no verdict fields) must be excluded, not silently passed");
    assert.ok(summary.completedTasks.includes("good-worker"));
    assert.ok(!summary.completedTasks.includes("orphan-worker"));
  });

  it("summary object includes required completedTasks field", async () => {
    const summary = await collectWorkSummary(makeConfig(tmpDir));
    assert.ok("completedTasks" in summary, "summary must have completedTasks field");
    assert.ok(Array.isArray(summary.completedTasks), "completedTasks must be an array");
    assert.ok("projectType" in summary);
    assert.ok("projectHealth" in summary);
    assert.ok("totalMergedPrs" in summary);
    assert.ok("workerOutcomes" in summary);
    assert.ok("completedAt" in summary);
  });

  it("replay of existing real state fixtures produces accurate count", async () => {
    // Real postmortems from state/athena_postmortems.json — all three have recommendation=proceed
    const realFixtures = [
      {
        workerName: "evolution-worker",
        taskCompleted: true,
        recommendation: "proceed",
        reviewedAt: "2026-03-21T15:46:12.455Z"
      },
      {
        workerName: "evolution-worker",
        taskCompleted: true,
        recommendation: "proceed",
        reviewedAt: "2026-03-21T16:12:17.735Z"
      },
      {
        workerName: "evolution-worker",
        taskCompleted: true,
        recommendation: "proceed",
        reviewedAt: "2026-03-21T17:06:15.735Z"
      }
    ];
    await fs.writeFile(
      path.join(tmpDir, "athena_postmortems.json"),
      JSON.stringify(realFixtures), "utf8"
    );

    const summary = await collectWorkSummary(makeConfig(tmpDir));
    assert.equal(summary.completedTasks.length, 3,
      "All 3 real postmortems have recommendation=proceed — all 3 must be counted");
  });
});
