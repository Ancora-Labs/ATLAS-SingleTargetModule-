/**
 * resilience_drill.test.ts — T-037: Quarterly resilience drills.
 *
 * Coverage (all ACs):
 *   AC1  — Four built-in drill scenarios run in CI simulation mode (BOX_DRILL_MODE=ci)
 *   AC2  — Each drill asserts expected guardrail and rollback sequence via DrillExpectedSequence
 *   AC3  — Drill outcomes produce pass/fail status and latencyMs metrics
 *   AC4  — No destructive external calls in drill mode (dryRun=true enforced)
 *   AC5  — Drill report is persisted to state/drill_reports/drill_{ts}.json
 *   AC6  — Each criterion has at least one explicit verification assertion
 *   AC7  — Negative path: missing/invalid input → FAIL with explicit reason codes
 *   AC8  — DrillReport and DrillResult have defined schemas with required fields
 *   AC9  — validateDrillScenario distinguishes MISSING_INPUT from INVALID_INPUT
 *   AC10 — No silent fallback: degraded state sets explicit status + failureReason
 *   AC11 — isDrillMode() returns true when BOX_DRILL_MODE=ci (env var contract)
 *   AC12 — DrillExpectedSequence schema includes guardrails, rollbackTrigger, transitions
 *   AC13 — Drill report path is deterministic: state/drill_reports/drill_{ts}.json
 *   AC14 — Verification uses explicit file paths (Windows-compatible, no shell glob)
 *   AC15 — Risk level is 'medium' (three core runtime modules in scope — documented)
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  // Constants
  DRILL_RESULT_SCHEMA_VERSION,
  DRILL_REPORT_SCHEMA_VERSION,
  DRILL_SEQUENCE_SCHEMA_VERSION,
  DRILL_MODE,
  DRILL_STATUS,
  DRILL_TRANSITION_STATE,
  DRILL_EXPECTED_TRANSITIONS,
  DRILL_REASON_CODE,
  DRILL_REPORT_REQUIRED_FIELDS,
  DRILL_RESULT_REQUIRED_FIELDS,
  // Functions
  isDrillMode,
  validateDrillScenario,
  runDrill,
  runAllDrills,
  persistDrillReport,
  drillReportsDir,
  drillReportPath,
  // Data
  BUILT_IN_DRILLS,
} from "../../src/core/resilience_drill.js";

import {
  CATASTROPHE_SCENARIO,
  CATASTROPHE_DEFAULTS,
  GUARDRAIL_ACTION,
} from "../../src/core/catastrophe_detector.js";

import {
  ROLLBACK_TRIGGER,
  ROLLBACK_LEVEL,
} from "../../src/core/rollback_engine.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

let tmpDir;

function cfg() {
  return { paths: { stateDir: tmpDir } };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drill-test-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  // Restore env var after all tests
  delete process.env.BOX_DRILL_MODE;
});

beforeEach(() => {
  delete process.env.BOX_DRILL_MODE;
});

// ── AC11: isDrillMode() env var contract ──────────────────────────────────────

describe("isDrillMode()", () => {
  it("returns false when BOX_DRILL_MODE is not set", () => {
    delete process.env.BOX_DRILL_MODE;
    assert.equal(isDrillMode(), false);
  });

  it("returns true when BOX_DRILL_MODE=ci (AC11 — CI simulation mode activation)", () => {
    process.env.BOX_DRILL_MODE = "ci";
    assert.equal(isDrillMode(), true);
    delete process.env.BOX_DRILL_MODE;
  });

  it("returns false for non-ci values", () => {
    process.env.BOX_DRILL_MODE = "dev";
    assert.equal(isDrillMode(), false);
    delete process.env.BOX_DRILL_MODE;
  });
});

// ── Schema version constants ───────────────────────────────────────────────────

describe("schema version constants", () => {
  it("exports positive integer schema versions", () => {
    assert.equal(typeof DRILL_RESULT_SCHEMA_VERSION, "number");
    assert.ok(DRILL_RESULT_SCHEMA_VERSION >= 1);
    assert.equal(typeof DRILL_REPORT_SCHEMA_VERSION, "number");
    assert.ok(DRILL_REPORT_SCHEMA_VERSION >= 1);
    assert.equal(typeof DRILL_SEQUENCE_SCHEMA_VERSION, "number");
    assert.ok(DRILL_SEQUENCE_SCHEMA_VERSION >= 1);
  });
});

// ── DRILL_MODE enum ───────────────────────────────────────────────────────────

describe("DRILL_MODE enum", () => {
  it("exports CI and DEV as distinct string values", () => {
    assert.equal(DRILL_MODE.CI,  "ci");
    assert.equal(DRILL_MODE.DEV, "dev");
    assert.notEqual(DRILL_MODE.CI, DRILL_MODE.DEV);
  });
});

// ── DRILL_STATUS enum ─────────────────────────────────────────────────────────

describe("DRILL_STATUS enum", () => {
  it("exports PASS and FAIL as distinct string values", () => {
    assert.equal(DRILL_STATUS.PASS, "pass");
    assert.equal(DRILL_STATUS.FAIL, "fail");
  });
});

// ── DRILL_TRANSITION_STATE enum ───────────────────────────────────────────────

describe("DRILL_TRANSITION_STATE enum (AC12 — sequence contract)", () => {
  it("exports all five state values", () => {
    assert.equal(DRILL_TRANSITION_STATE.PENDING,             "PENDING");
    assert.equal(DRILL_TRANSITION_STATE.DETECTION_RUN,       "DETECTION_RUN");
    assert.equal(DRILL_TRANSITION_STATE.GUARDRAIL_TRIGGERED, "GUARDRAIL_TRIGGERED");
    assert.equal(DRILL_TRANSITION_STATE.ROLLBACK_EVALUATED,  "ROLLBACK_EVALUATED");
    assert.equal(DRILL_TRANSITION_STATE.RESOLVED,            "RESOLVED");
    assert.equal(DRILL_TRANSITION_STATE.FAILED,              "FAILED");
  });

  it("DRILL_EXPECTED_TRANSITIONS contains 4 transitions in correct order", () => {
    assert.equal(DRILL_EXPECTED_TRANSITIONS.length, 4);
    assert.equal(DRILL_EXPECTED_TRANSITIONS[0].from, DRILL_TRANSITION_STATE.PENDING);
    assert.equal(DRILL_EXPECTED_TRANSITIONS[0].to,   DRILL_TRANSITION_STATE.DETECTION_RUN);
    assert.equal(DRILL_EXPECTED_TRANSITIONS[3].from, DRILL_TRANSITION_STATE.ROLLBACK_EVALUATED);
    assert.equal(DRILL_EXPECTED_TRANSITIONS[3].to,   DRILL_TRANSITION_STATE.RESOLVED);
  });
});

// ── DRILL_REASON_CODE enum ────────────────────────────────────────────────────

describe("DRILL_REASON_CODE enum (AC9, AC10)", () => {
  it("exports all required reason codes", () => {
    assert.equal(typeof DRILL_REASON_CODE.DETECTION_MISMATCH,         "string");
    assert.equal(typeof DRILL_REASON_CODE.SEQUENCE_MISMATCH,          "string");
    assert.equal(typeof DRILL_REASON_CODE.ROLLBACK_VALIDATION_FAILED,  "string");
    assert.equal(typeof DRILL_REASON_CODE.DETECTION_ERROR,            "string");
    assert.equal(typeof DRILL_REASON_CODE.GUARDRAIL_EXECUTION_ERROR,  "string");
    assert.equal(typeof DRILL_REASON_CODE.DESTRUCTIVE_CALL_ATTEMPTED, "string");
    assert.equal(typeof DRILL_REASON_CODE.MISSING_INPUT,              "string");
    assert.equal(typeof DRILL_REASON_CODE.INVALID_INPUT,              "string");
  });

  it("MISSING_INPUT and INVALID_INPUT are distinct (AC9)", () => {
    assert.notEqual(DRILL_REASON_CODE.MISSING_INPUT, DRILL_REASON_CODE.INVALID_INPUT);
  });
});

// ── DRILL_REPORT_REQUIRED_FIELDS and DRILL_RESULT_REQUIRED_FIELDS ─────────────

describe("DRILL_REPORT_REQUIRED_FIELDS (AC8 — schema contract)", () => {
  it("contains all mandatory report fields", () => {
    const EXPECTED = [
      "schemaVersion", "reportId", "generatedAt", "mode",
      "drillCount", "passCount", "failCount", "totalLatencyMs", "results",
    ];
    for (const f of EXPECTED) {
      assert.ok(DRILL_REPORT_REQUIRED_FIELDS.includes(f), `missing field: ${f}`);
    }
  });
});

describe("DRILL_RESULT_REQUIRED_FIELDS (AC8 — schema contract)", () => {
  it("contains all mandatory result fields", () => {
    const EXPECTED = [
      "schemaVersion", "drillId", "scenarioId", "description", "mode",
      "status", "guardrailsExpected", "guardrailsTriggered", "sequenceMatch",
      "rollbackTriggerExpected", "rollbackTriggerValidated",
      "transitions", "latencyMs", "destructiveCallsMade", "failureReason", "executedAt",
    ];
    for (const f of EXPECTED) {
      assert.ok(DRILL_RESULT_REQUIRED_FIELDS.includes(f), `missing field: ${f}`);
    }
  });
});

// ── BUILT_IN_DRILLS ───────────────────────────────────────────────────────────

describe("BUILT_IN_DRILLS (AC1 — four scenarios)", () => {
  it("contains exactly four drill scenarios", () => {
    assert.equal(BUILT_IN_DRILLS.length, 4);
  });

  it("each drill has all required fields", () => {
    for (const drill of BUILT_IN_DRILLS) {
      assert.ok(drill.scenarioId,        `missing scenarioId in ${JSON.stringify(drill)}`);
      assert.ok(drill.description,       `missing description in ${drill.scenarioId}`);
      assert.ok(drill.ctx,               `missing ctx in ${drill.scenarioId}`);
      assert.ok(drill.expectedSequence,  `missing expectedSequence in ${drill.scenarioId}`);
    }
  });

  it("covers the four primary catastrophe scenarios", () => {
    const ids = BUILT_IN_DRILLS.map((d) => d.scenarioId);
    assert.ok(ids.includes(CATASTROPHE_SCENARIO.RUNAWAY_RETRIES));
    assert.ok(ids.includes(CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS));
    assert.ok(ids.includes(CATASTROPHE_SCENARIO.STALE_CRITICAL_STATE));
    assert.ok(ids.includes(CATASTROPHE_SCENARIO.REPEATED_AI_PARSE_FAILURES));
  });

  it("each expectedSequence has schemaVersion, guardrails array, transitions array (AC12)", () => {
    for (const drill of BUILT_IN_DRILLS) {
      const seq = drill.expectedSequence;
      assert.equal(seq.schemaVersion, DRILL_SEQUENCE_SCHEMA_VERSION,
        `schemaVersion mismatch in ${drill.scenarioId}`);
      assert.ok(Array.isArray(seq.guardrails) && seq.guardrails.length > 0,
        `guardrails must be non-empty in ${drill.scenarioId}`);
      assert.ok(Array.isArray(seq.transitions) && seq.transitions.length > 0,
        `transitions must be non-empty in ${drill.scenarioId}`);
    }
  });
});

// ── validateDrillScenario (AC9 — MISSING vs INVALID) ─────────────────────────

describe("validateDrillScenario() (AC9)", () => {
  it("returns MISSING_INPUT for null", () => {
    const r = validateDrillScenario(null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, DRILL_REASON_CODE.MISSING_INPUT);
  });

  it("returns MISSING_INPUT for undefined", () => {
    const r = validateDrillScenario(undefined);
    assert.equal(r.ok, false);
    assert.equal(r.reason, DRILL_REASON_CODE.MISSING_INPUT);
  });

  it("returns INVALID_INPUT for a plain string (not an object)", () => {
    const r = validateDrillScenario("not-an-object");
    assert.equal(r.ok, false);
    assert.equal(r.reason, DRILL_REASON_CODE.INVALID_INPUT);
  });

  it("returns INVALID_INPUT for missing required field", () => {
    const r = validateDrillScenario({ scenarioId: CATASTROPHE_SCENARIO.RUNAWAY_RETRIES });
    assert.equal(r.ok, false);
    assert.equal(r.reason, DRILL_REASON_CODE.INVALID_INPUT);
    assert.ok(r.message.includes("description"), `expected 'description' in message, got: ${r.message}`);
  });

  it("returns INVALID_INPUT for unknown scenarioId", () => {
    const r = validateDrillScenario({
      scenarioId:       "NOT_REAL",
      description:      "test",
      ctx:              {},
      expectedSequence: { guardrails: ["X"], transitions: [{ from: "A", to: "B" }] },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, DRILL_REASON_CODE.INVALID_INPUT);
    assert.ok(r.message.includes("NOT_REAL"));
  });

  it("returns ok=true for a valid built-in drill scenario", () => {
    const r = validateDrillScenario(BUILT_IN_DRILLS[0]);
    assert.equal(r.ok, true);
  });
});

// ── runDrill — AC1: four scenarios in CI mode ─────────────────────────────────

describe("runDrill() — RUNAWAY_RETRIES in CI mode (AC1, AC2, AC3, AC4)", () => {
  it("passes with correct guardrail sequence, latency, and no destructive calls", async () => {
    const result = await runDrill(BUILT_IN_DRILLS[0], cfg(), { mode: DRILL_MODE.CI });

    // AC1: ran in CI mode
    assert.equal(result.mode, DRILL_MODE.CI);

    // AC2: expected guardrail sequence matches
    assert.equal(result.sequenceMatch, true);
    assert.deepEqual(result.guardrailsExpected,  [
      GUARDRAIL_ACTION.RESET_RETRY_COUNTER,
      GUARDRAIL_ACTION.INCREASE_DELAY,
      GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT,
    ]);
    assert.deepEqual(result.guardrailsTriggered, result.guardrailsExpected);

    // AC2: rollback trigger validated
    assert.equal(result.rollbackTriggerExpected, ROLLBACK_TRIGGER.CANARY_ROLLBACK);
    assert.equal(result.rollbackTriggerValidated, true);

    // AC3: pass/fail and latencyMs present
    assert.equal(result.status, DRILL_STATUS.PASS);
    assert.equal(typeof result.latencyMs, "number");
    assert.ok(result.latencyMs >= 0);

    // AC4: no destructive external calls
    assert.equal(result.destructiveCallsMade, 0);

    // AC8: schema version
    assert.equal(result.schemaVersion, DRILL_RESULT_SCHEMA_VERSION);
  });
});

describe("runDrill() — MASS_BLOCKED_TASKS in CI mode (AC1)", () => {
  it("passes with correct guardrail sequence", async () => {
    const result = await runDrill(BUILT_IN_DRILLS[1], cfg(), { mode: DRILL_MODE.CI });
    assert.equal(result.status, DRILL_STATUS.PASS);
    assert.equal(result.sequenceMatch, true);
    assert.deepEqual(result.guardrailsExpected, [
      GUARDRAIL_ACTION.PAUSE_WORKERS,
      GUARDRAIL_ACTION.NOTIFY_HUMAN,
      GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT,
    ]);
    assert.deepEqual(result.guardrailsTriggered, result.guardrailsExpected);
    assert.equal(result.destructiveCallsMade, 0);
  });
});

describe("runDrill() — STALE_CRITICAL_STATE in CI mode (AC1)", () => {
  it("passes with correct guardrail sequence", async () => {
    const result = await runDrill(BUILT_IN_DRILLS[2], cfg(), { mode: DRILL_MODE.CI });
    assert.equal(result.status, DRILL_STATUS.PASS);
    assert.equal(result.sequenceMatch, true);
    assert.deepEqual(result.guardrailsExpected, [
      GUARDRAIL_ACTION.SKIP_CYCLE,
      GUARDRAIL_ACTION.FORCE_CHECKPOINT_VALIDATION,
      GUARDRAIL_ACTION.NOTIFY_HUMAN,
    ]);
    assert.deepEqual(result.guardrailsTriggered, result.guardrailsExpected);
    assert.equal(result.destructiveCallsMade, 0);
  });
});

describe("runDrill() — REPEATED_AI_PARSE_FAILURES in CI mode (AC1)", () => {
  it("passes with correct guardrail sequence", async () => {
    const result = await runDrill(BUILT_IN_DRILLS[3], cfg(), { mode: DRILL_MODE.CI });
    assert.equal(result.status, DRILL_STATUS.PASS);
    assert.equal(result.sequenceMatch, true);
    assert.deepEqual(result.guardrailsExpected, [
      GUARDRAIL_ACTION.INCREASE_DELAY,
      GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT,
      GUARDRAIL_ACTION.ESCALATE,
    ]);
    assert.deepEqual(result.guardrailsTriggered, result.guardrailsExpected);
    assert.equal(result.destructiveCallsMade, 0);
  });
});

// ── State transition assertions (AC2 — sequence contract) ────────────────────

describe("runDrill() — state transitions (AC2)", () => {
  it("PASS drill traverses the full expected transition sequence", async () => {
    const result = await runDrill(BUILT_IN_DRILLS[0], cfg(), { mode: DRILL_MODE.CI });
    assert.equal(result.status, DRILL_STATUS.PASS);
    assert.ok(Array.isArray(result.transitions));
    assert.equal(result.transitions.length, 4);
    assert.equal(result.transitions[0].from, DRILL_TRANSITION_STATE.PENDING);
    assert.equal(result.transitions[0].to,   DRILL_TRANSITION_STATE.DETECTION_RUN);
    assert.equal(result.transitions[1].from, DRILL_TRANSITION_STATE.DETECTION_RUN);
    assert.equal(result.transitions[1].to,   DRILL_TRANSITION_STATE.GUARDRAIL_TRIGGERED);
    assert.equal(result.transitions[2].from, DRILL_TRANSITION_STATE.GUARDRAIL_TRIGGERED);
    assert.equal(result.transitions[2].to,   DRILL_TRANSITION_STATE.ROLLBACK_EVALUATED);
    assert.equal(result.transitions[3].from, DRILL_TRANSITION_STATE.ROLLBACK_EVALUATED);
    assert.equal(result.transitions[3].to,   DRILL_TRANSITION_STATE.RESOLVED);
  });

  it("FAIL drill ends in FAILED transition state (AC10 — no silent fallback)", async () => {
    const result = await runDrill(null, cfg(), { mode: DRILL_MODE.CI });
    assert.equal(result.status, DRILL_STATUS.FAIL);
    const lastTransition = result.transitions[result.transitions.length - 1];
    assert.equal(lastTransition.to, DRILL_TRANSITION_STATE.FAILED);
    // Explicit failure reason — no silent fallback
    assert.ok(result.failureReason, "failureReason must be set on FAIL");
    assert.ok(result.failureReason.includes(DRILL_REASON_CODE.MISSING_INPUT));
  });
});

// ── runDrill() negative paths (AC7) ───────────────────────────────────────────

describe("runDrill() negative paths (AC7 — failure handling)", () => {
  it("returns FAIL with MISSING_INPUT when scenario is null", async () => {
    const result = await runDrill(null, cfg(), { mode: DRILL_MODE.CI });
    assert.equal(result.status, DRILL_STATUS.FAIL);
    assert.ok(result.failureReason.includes(DRILL_REASON_CODE.MISSING_INPUT));
    assert.equal(result.destructiveCallsMade, 0);
  });

  it("returns FAIL with INVALID_INPUT when scenario has bad scenarioId", async () => {
    const bad = {
      scenarioId:       "FAKE_SCENARIO",
      description:      "bad",
      ctx:              {},
      expectedSequence: { guardrails: ["X"], transitions: [{ from: "A", to: "B" }] },
    };
    const result = await runDrill(bad, cfg(), { mode: DRILL_MODE.CI });
    assert.equal(result.status, DRILL_STATUS.FAIL);
    assert.ok(result.failureReason.includes(DRILL_REASON_CODE.INVALID_INPUT));
  });

  it("returns FAIL with DETECTION_MISMATCH when ctx does not trigger expected scenario", async () => {
    // Use RUNAWAY_RETRIES drill but ctx that will NOT trigger it (retryCount=0)
    const noTriggerDrill = {
      ...BUILT_IN_DRILLS[0],
      ctx: {
        retryCount:                0,  // below threshold
        totalTasks:                10,
        blockedTasks:              0,
        janusDirectiveAgeMs:       0,
        prometheusAnalysisAgeMs:   0,
        parseFailureCount:         0,
        consecutiveBudgetBreaches: 0,
        consecutiveSloBreaches:    0,
      },
    };
    const result = await runDrill(noTriggerDrill, cfg(), { mode: DRILL_MODE.CI });
    assert.equal(result.status, DRILL_STATUS.FAIL);
    assert.ok(result.failureReason.includes(DRILL_REASON_CODE.DETECTION_MISMATCH));
  });

  it("returns FAIL with SEQUENCE_MISMATCH when expected guardrails do not match", async () => {
    // Provide wrong expected sequence
    const wrongSeq = {
      ...BUILT_IN_DRILLS[0],
      expectedSequence: {
        ...BUILT_IN_DRILLS[0].expectedSequence,
        guardrails:  ["WRONG_ACTION_1", "WRONG_ACTION_2"],
      },
    };
    const result = await runDrill(wrongSeq, cfg(), { mode: DRILL_MODE.CI });
    assert.equal(result.status, DRILL_STATUS.FAIL);
    assert.ok(result.failureReason.includes(DRILL_REASON_CODE.SEQUENCE_MISMATCH));
  });

  it("returns FAIL with ROLLBACK_VALIDATION_FAILED when trigger/level are invalid", async () => {
    const badRollback = {
      ...BUILT_IN_DRILLS[0],
      expectedSequence: {
        ...BUILT_IN_DRILLS[0].expectedSequence,
        rollbackTrigger: "NOT_A_REAL_TRIGGER",
        rollbackLevel:   "NOT_A_REAL_LEVEL",
      },
    };
    const result = await runDrill(badRollback, cfg(), { mode: DRILL_MODE.CI });
    assert.equal(result.status, DRILL_STATUS.FAIL);
    assert.ok(result.failureReason.includes(DRILL_REASON_CODE.ROLLBACK_VALIDATION_FAILED));
  });
});

// ── runAllDrills (AC1, AC3) ────────────────────────────────────────────────────

describe("runAllDrills() (AC1, AC3 — four drills, latency metrics)", () => {
  it("runs all four built-in drills and returns a well-formed report", async () => {
    const report = await runAllDrills(cfg(), { mode: DRILL_MODE.CI });

    // AC1: four drills ran
    assert.equal(report.drillCount, 4);

    // AC3: latency metrics
    assert.equal(typeof report.totalLatencyMs, "number");
    assert.ok(report.totalLatencyMs >= 0);

    // All pass
    assert.equal(report.passCount, 4);
    assert.equal(report.failCount, 0);

    // AC8: schema version
    assert.equal(report.schemaVersion, DRILL_REPORT_SCHEMA_VERSION);

    // AC8: all required fields present
    for (const field of DRILL_REPORT_REQUIRED_FIELDS) {
      assert.ok(field in report, `missing report field: ${field}`);
    }

    // Each result has all required fields
    for (const r of report.results) {
      for (const field of DRILL_RESULT_REQUIRED_FIELDS) {
        assert.ok(field in r, `missing result field: ${field} in ${r.scenarioId}`);
      }
    }
  });

  it("mode defaults to ci when BOX_DRILL_MODE=ci env var is set (AC11)", async () => {
    process.env.BOX_DRILL_MODE = "ci";
    const report = await runAllDrills(cfg());
    assert.equal(report.mode, DRILL_MODE.CI);
    delete process.env.BOX_DRILL_MODE;
  });

  it("each result records destructiveCallsMade = 0 (AC4)", async () => {
    const report = await runAllDrills(cfg(), { mode: DRILL_MODE.CI });
    for (const r of report.results) {
      assert.equal(r.destructiveCallsMade, 0,
        `destructiveCallsMade must be 0 for ${r.scenarioId}`);
    }
  });
});

// ── persistDrillReport (AC5, AC13) ────────────────────────────────────────────

describe("persistDrillReport() (AC5 — governance persistence, AC13 — path schema)", () => {
  it("writes report to state/drill_reports/drill_{ts}.json", async () => {
    const report = await runAllDrills(cfg(), { mode: DRILL_MODE.CI });
    const result = await persistDrillReport(cfg(), report);

    assert.equal(result.ok, true, `persistDrillReport failed: ${result.reason}`);
    assert.ok(result.filePath, "filePath must be returned");
    assert.ok(result.filePath.includes("drill_reports"), "filePath must include drill_reports dir");
    assert.ok(result.filePath.endsWith(".json"), "filePath must end in .json");

    // Verify the file exists and is valid JSON with all required fields
    const raw  = await fs.readFile(result.filePath, "utf8");
    const parsed = JSON.parse(raw);
    for (const field of DRILL_REPORT_REQUIRED_FIELDS) {
      assert.ok(field in parsed, `persisted report missing field: ${field}`);
    }
    assert.equal(parsed.schemaVersion, DRILL_REPORT_SCHEMA_VERSION);
    assert.equal(parsed.drillCount, 4);
  });

  it("drillReportPath produces deterministic path from generatedAt", () => {
    const config = { paths: { stateDir: "/tmp/state" } };
    const p = drillReportPath(config, "2026-03-22T03:07:20.683Z");
    // Must contain drill_reports dir and sanitized timestamp
    assert.ok(p.includes("drill_reports"));
    assert.ok(p.includes("drill_2026-03-22T03-07-20-683Z"));
    assert.ok(p.endsWith(".json"));
  });

  it("drillReportsDir returns {stateDir}/drill_reports", () => {
    const config = { paths: { stateDir: "/tmp/state" } };
    const d = drillReportsDir(config);
    assert.ok(d.endsWith(path.join("drill_reports")));
  });
});

// ── persistDrillReport negative paths (AC7, AC9) ─────────────────────────────

describe("persistDrillReport() negative paths (AC7, AC9, AC10)", () => {
  it("returns MISSING_INPUT for null report", async () => {
    const r = await persistDrillReport(cfg(), null);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes(DRILL_REASON_CODE.MISSING_INPUT));
  });

  it("returns MISSING_INPUT for undefined report", async () => {
    const r = await persistDrillReport(cfg(), undefined);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes(DRILL_REASON_CODE.MISSING_INPUT));
  });

  it("returns INVALID_INPUT when required field is missing (AC10 — no silent fallback)", async () => {
    const r = await persistDrillReport(cfg(), { schemaVersion: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes(DRILL_REASON_CODE.INVALID_INPUT));
  });

  it("returns INVALID_INPUT when mode is not a valid DRILL_MODE value", async () => {
    const report = await runAllDrills(cfg(), { mode: DRILL_MODE.CI });
    const bad = { ...report, mode: "INVALID_MODE" };
    const r = await persistDrillReport(cfg(), bad);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes(DRILL_REASON_CODE.INVALID_INPUT));
    assert.ok(r.reason.includes("INVALID_MODE"));
  });
});

// ── Full end-to-end drill-to-report round-trip (AC1–AC5 combined) ─────────────

describe("end-to-end drill + report round-trip (AC1–AC5)", () => {
  it("runs 4 CI drills, persists report, verifies all schema fields", async () => {
    process.env.BOX_DRILL_MODE = "ci";

    // AC1: four drills in CI mode
    const report = await runAllDrills(cfg());
    assert.equal(report.drillCount, 4);
    assert.equal(report.mode, DRILL_MODE.CI);

    // AC2: each result has sequenceMatch=true and rollbackTriggerValidated=true
    for (const r of report.results) {
      assert.equal(r.sequenceMatch, true, `sequenceMatch failed for ${r.scenarioId}`);
      assert.equal(r.rollbackTriggerValidated, true, `rollbackTriggerValidated failed for ${r.scenarioId}`);
    }

    // AC3: latency metrics present for every result
    for (const r of report.results) {
      assert.equal(typeof r.latencyMs, "number");
      assert.ok(r.latencyMs >= 0);
    }

    // AC4: no destructive calls
    for (const r of report.results) {
      assert.equal(r.destructiveCallsMade, 0);
    }

    // AC5: persist and verify
    const save = await persistDrillReport(cfg(), report);
    assert.equal(save.ok, true);

    const raw    = await fs.readFile(save.filePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.passCount, 4);
    assert.equal(parsed.failCount, 0);

    delete process.env.BOX_DRILL_MODE;
  });
});

// ── Risk level documentation (AC15 — medium risk acknowledgement) ─────────────

describe("risk level documentation (AC15)", () => {
  it("resilience_drill.ts module header documents risk level as 'medium'", async () => {
    const src = await fs.readFile(
      new URL("../../src/core/resilience_drill.ts", import.meta.url),
      "utf8"
    );
    assert.ok(
      src.includes("Risk level: medium") || src.includes("risk level: medium"),
      "Module header must document risk level as 'medium'"
    );
  });
});

