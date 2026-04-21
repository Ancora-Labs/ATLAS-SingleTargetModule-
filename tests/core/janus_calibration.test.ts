/**
 * Tests for janus_calibration.ts — expected-vs-realized strategic calibration.
 *
 * Covers:
 *   - buildExpectedOutcome: correct forecast derivation for all decision types
 *   - scoreCalibration: deterministic scoring with defined weights
 *   - computeCalibrationRecord: full record construction + null guards
 *   - appendCalibrationHistory / getCalibrationSummary: persistence and aggregation
 *   - Negative paths: missing fields, empty history, corrupt state
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  JANUS_DECISION_TYPE,
  JANUS_FORECAST_CONFIDENCE,
  JANUS_HEALTH_STATE,
  buildExpectedOutcome,
  scoreCalibration,
  computeCalibrationRecord,
  appendCalibrationHistory,
  getCalibrationSummary,
  type JanusExpectedOutcome,
  type JanusRealizedOutcome,
} from "../../src/core/janus_calibration.js";

// ── Constant enums ────────────────────────────────────────────────────────────

describe("JANUS_DECISION_TYPE enum", () => {
  it("exports all four decision types as frozen constants", () => {
    assert.equal(JANUS_DECISION_TYPE.WAIT, "wait");
    assert.equal(JANUS_DECISION_TYPE.TACTICAL, "tactical");
    assert.equal(JANUS_DECISION_TYPE.STRATEGIC, "strategic");
    assert.equal(JANUS_DECISION_TYPE.EMERGENCY, "emergency");
    assert.ok(Object.isFrozen(JANUS_DECISION_TYPE));
  });
});

describe("JANUS_FORECAST_CONFIDENCE enum", () => {
  it("exports high, medium, low as frozen constants", () => {
    assert.equal(JANUS_FORECAST_CONFIDENCE.HIGH, "high");
    assert.equal(JANUS_FORECAST_CONFIDENCE.MEDIUM, "medium");
    assert.equal(JANUS_FORECAST_CONFIDENCE.LOW, "low");
    assert.ok(Object.isFrozen(JANUS_FORECAST_CONFIDENCE));
  });
});

// ── buildExpectedOutcome ──────────────────────────────────────────────────────

describe("buildExpectedOutcome — decision=emergency", () => {
  it("predicts degraded health after emergency action", () => {
    const outcome = buildExpectedOutcome({
      decision: "emergency",
      systemHealth: "critical",
      wakeAthena: true,
      callPrometheus: true,
      workItems: [{ task: "fix CI" }],
    });
    assert.equal(outcome.expectedSystemHealthAfter, JANUS_HEALTH_STATE.DEGRADED);
    assert.equal(outcome.expectedNextDecision, JANUS_DECISION_TYPE.TACTICAL);
    assert.equal(outcome.forecastConfidence, JANUS_FORECAST_CONFIDENCE.HIGH);
    assert.equal(outcome.expectedAthenaActivated, true);
    assert.equal(outcome.expectedPrometheusRan, true);
    assert.equal(outcome.expectedWorkItemCount, 1);
  });
});

describe("buildExpectedOutcome — decision=strategic", () => {
  it("predicts good health after strategic planning", () => {
    const outcome = buildExpectedOutcome({
      decision: "strategic",
      systemHealth: "degraded",
      wakeAthena: true,
      callPrometheus: true,
      workItems: [],
    });
    assert.equal(outcome.expectedSystemHealthAfter, JANUS_HEALTH_STATE.GOOD);
    assert.equal(outcome.expectedNextDecision, JANUS_DECISION_TYPE.TACTICAL);
  });
});

describe("buildExpectedOutcome — decision=tactical, health=critical", () => {
  it("predicts one level improvement: critical → degraded", () => {
    const outcome = buildExpectedOutcome({
      decision: "tactical",
      systemHealth: "critical",
      wakeAthena: true,
      callPrometheus: false,
      workItems: [{ task: "a" }, { task: "b" }],
    });
    assert.equal(outcome.expectedSystemHealthAfter, JANUS_HEALTH_STATE.DEGRADED);
    assert.equal(outcome.forecastConfidence, JANUS_FORECAST_CONFIDENCE.MEDIUM);
    assert.equal(outcome.expectedWorkItemCount, 2);
  });
});

describe("buildExpectedOutcome — decision=tactical, health=degraded", () => {
  it("predicts one level improvement: degraded → good", () => {
    const outcome = buildExpectedOutcome({
      decision: "tactical",
      systemHealth: "degraded",
      wakeAthena: false,
      callPrometheus: false,
      workItems: [],
    });
    assert.equal(outcome.expectedSystemHealthAfter, JANUS_HEALTH_STATE.GOOD);
    assert.equal(outcome.forecastConfidence, JANUS_FORECAST_CONFIDENCE.LOW);
  });
});

describe("buildExpectedOutcome — decision=wait", () => {
  it("predicts health unchanged when waiting", () => {
    const outcome = buildExpectedOutcome({
      decision: "wait",
      systemHealth: "good",
      wakeAthena: false,
      callPrometheus: false,
      workItems: [],
    });
    assert.equal(outcome.expectedSystemHealthAfter, "good");
    assert.equal(outcome.expectedNextDecision, JANUS_DECISION_TYPE.WAIT);
    assert.equal(outcome.forecastConfidence, JANUS_FORECAST_CONFIDENCE.LOW);
    assert.equal(outcome.expectedAthenaActivated, false);
  });
});

describe("buildExpectedOutcome — missing/undefined fields", () => {
  it("handles entirely empty directive without throwing", () => {
    const outcome = buildExpectedOutcome({});
    assert.ok(typeof outcome.expectedSystemHealthAfter === "string");
    assert.ok(typeof outcome.expectedNextDecision === "string");
    assert.ok(typeof outcome.forecastConfidence === "string");
    assert.equal(outcome.expectedWorkItemCount, 0);
  });
});

// ── scoreCalibration ──────────────────────────────────────────────────────────

describe("scoreCalibration — perfect match", () => {
  it("returns overall=100 when all expectations match reality", () => {
    const expected: JanusExpectedOutcome = {
      expectedSystemHealthAfter: "good",
      expectedNextDecision: "tactical",
      expectedAthenaActivated: true,
      expectedPrometheusRan: false,
      expectedWorkItemCount: 2,
      forecastConfidence: "medium",
    };
    const realized: JanusRealizedOutcome = {
      systemHealth: "good",
      decision: "tactical",
      athenaActivated: true,
      prometheusRan: false,
      workItemCount: 2,
    };
    const scores = scoreCalibration(expected, realized);
    assert.equal(scores.overall, 100);
    assert.equal(scores.healthMatch, true);
    assert.equal(scores.decisionMatch, true);
    assert.equal(scores.athenaMatch, true);
    assert.equal(scores.prometheusMatch, true);
  });
});

describe("scoreCalibration — no match", () => {
  it("returns overall=0 when no expectations match reality", () => {
    const expected: JanusExpectedOutcome = {
      expectedSystemHealthAfter: "good",
      expectedNextDecision: "wait",
      expectedAthenaActivated: true,
      expectedPrometheusRan: true,
      expectedWorkItemCount: 3,
      forecastConfidence: "high",
    };
    const realized: JanusRealizedOutcome = {
      systemHealth: "critical",
      decision: "emergency",
      athenaActivated: false,
      prometheusRan: false,
      workItemCount: 0,
    };
    const scores = scoreCalibration(expected, realized);
    assert.equal(scores.overall, 0);
    assert.equal(scores.healthMatch, false);
    assert.equal(scores.decisionMatch, false);
    assert.equal(scores.athenaMatch, false);
    assert.equal(scores.prometheusMatch, false);
  });
});

describe("scoreCalibration — partial match", () => {
  it("returns correct partial score: health+decision matched only = 70", () => {
    const expected: JanusExpectedOutcome = {
      expectedSystemHealthAfter: "degraded",
      expectedNextDecision: "tactical",
      expectedAthenaActivated: true,
      expectedPrometheusRan: true,
      expectedWorkItemCount: 1,
      forecastConfidence: "medium",
    };
    const realized: JanusRealizedOutcome = {
      systemHealth: "degraded",
      decision: "tactical",
      athenaActivated: false,
      prometheusRan: false,
      workItemCount: 1,
    };
    const scores = scoreCalibration(expected, realized);
    // health=35 + decision=35 + athena=0 + prometheus=0 = 70
    assert.equal(scores.overall, 70);
    assert.equal(scores.healthMatch, true);
    assert.equal(scores.decisionMatch, true);
    assert.equal(scores.athenaMatch, false);
    assert.equal(scores.prometheusMatch, false);
  });
});

// ── computeCalibrationRecord ──────────────────────────────────────────────────

describe("computeCalibrationRecord — positive path", () => {
  it("builds a full record with scores when previous directive has expectedOutcome", () => {
    const prevDirective = {
      decidedAt: "2026-03-27T10:00:00.000Z",
      expectedOutcome: {
        expectedSystemHealthAfter: "good",
        expectedNextDecision: "tactical",
        expectedAthenaActivated: true,
        expectedPrometheusRan: false,
        expectedWorkItemCount: 2,
        forecastConfidence: "medium",
      },
    };
    const realizedState = {
      systemHealth: "good",
      decision: "tactical",
      athenaActivated: true,
      prometheusRan: false,
      workItemCount: 3,
    };
    const record = computeCalibrationRecord(prevDirective, realizedState);
    assert.ok(record !== null);
    assert.equal(record!.directiveIssuedAt, "2026-03-27T10:00:00.000Z");
    assert.ok(typeof record!.evaluatedAt === "string");
    assert.equal(record!.scores.overall, 100);
    assert.equal(record!.scores.healthMatch, true);
    assert.equal(record!.scores.decisionMatch, true);
  });
});

describe("computeCalibrationRecord — negative path: missing expectedOutcome", () => {
  it("returns null when previous directive has no expectedOutcome field", () => {
    const prevDirective = { decidedAt: "2026-03-27T10:00:00.000Z" };
    const realizedState = { systemHealth: "good", decision: "tactical", athenaActivated: true, prometheusRan: false, workItemCount: 0 };
    const record = computeCalibrationRecord(prevDirective, realizedState);
    assert.equal(record, null);
  });
});

describe("computeCalibrationRecord — negative path: missing decidedAt", () => {
  it("returns null when previous directive has no decidedAt field", () => {
    const prevDirective = {
      expectedOutcome: {
        expectedSystemHealthAfter: "good",
        expectedNextDecision: "tactical",
        expectedAthenaActivated: true,
        expectedPrometheusRan: false,
        expectedWorkItemCount: 0,
        forecastConfidence: "low",
      },
    };
    const realizedState = { systemHealth: "good", decision: "tactical", athenaActivated: false, prometheusRan: false, workItemCount: 0 };
    const record = computeCalibrationRecord(prevDirective as any, realizedState);
    assert.equal(record, null);
  });
});

describe("computeCalibrationRecord — negative path: null directive", () => {
  it("returns null for null/undefined previous directive", () => {
    assert.equal(computeCalibrationRecord(null as any, { systemHealth: "good", decision: "tactical", athenaActivated: false, prometheusRan: false, workItemCount: 0 }), null);
    assert.equal(computeCalibrationRecord(undefined as any, { systemHealth: "good", decision: "tactical", athenaActivated: false, prometheusRan: false, workItemCount: 0 }), null);
  });
});

// ── appendCalibrationHistory / getCalibrationSummary ─────────────────────────

describe("appendCalibrationHistory + getCalibrationSummary", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-calib-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("persists a record and returns correct summary metrics", async () => {
    const record = computeCalibrationRecord(
      {
        decidedAt: "2026-03-27T10:00:00.000Z",
        expectedOutcome: {
          expectedSystemHealthAfter: "good",
          expectedNextDecision: "tactical",
          expectedAthenaActivated: true,
          expectedPrometheusRan: false,
          expectedWorkItemCount: 1,
          forecastConfidence: "medium",
        },
      },
      { systemHealth: "good", decision: "tactical", athenaActivated: true, prometheusRan: false, workItemCount: 1 }
    )!;

    await appendCalibrationHistory(stateDir, record);

    const summary = await getCalibrationSummary(stateDir);
    assert.equal(summary.totalRecords, 1);
    assert.equal(summary.averageOverallScore, 100);
    assert.equal(summary.healthMatchRate, 1);
    assert.equal(summary.decisionMatchRate, 1);
    assert.ok(typeof summary.lastEvaluatedAt === "string");
  });

  it("accumulates multiple records and computes correct averages", async () => {
    // Record 1: perfect (100)
    const r1 = computeCalibrationRecord(
      {
        decidedAt: "2026-03-27T09:00:00.000Z",
        expectedOutcome: { expectedSystemHealthAfter: "good", expectedNextDecision: "tactical", expectedAthenaActivated: true, expectedPrometheusRan: false, expectedWorkItemCount: 0, forecastConfidence: "medium" },
      },
      { systemHealth: "good", decision: "tactical", athenaActivated: true, prometheusRan: false, workItemCount: 0 }
    )!;

    // Record 2: all wrong (0)
    const r2 = computeCalibrationRecord(
      {
        decidedAt: "2026-03-27T10:00:00.000Z",
        expectedOutcome: { expectedSystemHealthAfter: "good", expectedNextDecision: "wait", expectedAthenaActivated: true, expectedPrometheusRan: true, expectedWorkItemCount: 0, forecastConfidence: "low" },
      },
      { systemHealth: "critical", decision: "emergency", athenaActivated: false, prometheusRan: false, workItemCount: 0 }
    )!;

    await appendCalibrationHistory(stateDir, r1);
    await appendCalibrationHistory(stateDir, r2);

    const summary = await getCalibrationSummary(stateDir);
    assert.equal(summary.totalRecords, 2);
    assert.equal(summary.averageOverallScore, 50); // (100 + 0) / 2
    assert.equal(summary.healthMatchRate, 0.5);
    assert.equal(summary.decisionMatchRate, 0.5);
    assert.equal(summary.athenaMatchRate, 0.5);
  });

  it("returns null metrics for empty history (negative path)", async () => {
    const summary = await getCalibrationSummary(stateDir);
    assert.equal(summary.totalRecords, 0);
    assert.equal(summary.averageOverallScore, null);
    assert.equal(summary.healthMatchRate, null);
    assert.equal(summary.lastEvaluatedAt, null);
  });

  it("handles missing history file gracefully (negative path)", async () => {
    const missing = path.join(stateDir, "no-such-subdir");
    // getCalibrationSummary on a non-existent stateDir should not throw
    const summary = await getCalibrationSummary(missing);
    assert.equal(summary.totalRecords, 0);
    assert.equal(summary.averageOverallScore, null);
  });
});

// ── computeCalibrationRecord — evidenceComplete field ────────────────────────

describe("computeCalibrationRecord — evidenceComplete field", () => {
  const prevDirective = {
    decidedAt: "2026-03-27T10:00:00.000Z",
    expectedOutcome: {
      expectedSystemHealthAfter: "good",
      expectedNextDecision: "tactical",
      expectedAthenaActivated: true,
      expectedPrometheusRan: false,
      expectedWorkItemCount: 2,
      forecastConfidence: "medium",
    },
  };
  const realizedState = {
    systemHealth: "good",
    decision: "tactical",
    athenaActivated: true,
    prometheusRan: false,
    workItemCount: 2,
  };

  it("sets evidenceComplete=true when third arg is true", () => {
    const record = computeCalibrationRecord(prevDirective, realizedState, true);
    assert.ok(record !== null);
    assert.equal(record!.evidenceComplete, true);
  });

  it("sets evidenceComplete=false when third arg is false", () => {
    const record = computeCalibrationRecord(prevDirective, realizedState, false);
    assert.ok(record !== null);
    assert.equal(record!.evidenceComplete, false);
  });

  it("sets evidenceComplete=null when third arg is omitted (backward compat)", () => {
    const record = computeCalibrationRecord(prevDirective, realizedState);
    assert.ok(record !== null);
    assert.equal(record!.evidenceComplete, null);
  });

  it("NEGATIVE PATH: still returns null when prevDirective is null regardless of evidenceComplete", () => {
    const result = computeCalibrationRecord(null as any, realizedState, true);
    assert.equal(result, null);
  });
});

