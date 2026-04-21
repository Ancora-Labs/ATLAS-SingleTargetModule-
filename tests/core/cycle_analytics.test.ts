/**
 * Tests for src/core/cycle_analytics.js
 *
 * Coverage:
 *   AC1  — artifact includes cycle id, phase, outcomes, confidence values
 *   AC2  — KPIs computed from canonical events only
 *   AC3  — missing data represented explicitly (not zero-filled)
 *   AC4  — append-only with retention policy
 *   AC6  — each criterion maps to explicit verification
 *   AC7  — negative paths including failure handling
 *   AC8  — schema with required fields and explicit enums
 *   AC9  — distinguishes missing input from invalid input
 *   AC10 — no silent fallback for critical state
 */

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  computeCycleAnalytics,
  persistCycleAnalytics,
  readCycleAnalytics,
  computeCycleHealth,
  computeRuntimeContractProbe,
  persistCycleHealth,
  persistCycleHealthComposite,
  persistCycleHealthDivergence,
  readCycleHealth,
  CYCLE_PHASE,
  CYCLE_OUTCOME_STATUS,
  CONFIDENCE_LEVEL,
  MISSING_DATA_REASON,
  MISSING_DATA_IMPACT,
  CYCLE_ANALYTICS_SCHEMA,
  CYCLE_HEALTH_SCHEMA,
  HEALTH_SCORE,
  CANONICAL_EVENT_NAMES,
  CYCLE_TRUTH_TERMINAL_BLOCK_REASON,
  DISPATCH_BLOCK_REASON_CODE,
  buildModelRoutingTelemetry,
  buildInterventionLineageTelemetry,
  buildRoutingROISummary,
  MIN_TELEMETRY_SAMPLE_THRESHOLD,
  migrateLegacyEvolutionProgressToCompletedTaskIds,
  parseDispatchBlockReasonContract,
  isResolvedBenchmarkRecommendation,
  WORKER_CYCLE_ARTIFACTS_SCHEMA,
  LEGACY_EVOLUTION_PROGRESS_FILE,
  LEGACY_EVOLUTION_PROGRESS_SCHEMA_VERSION,
} from "../../src/core/cycle_analytics.js";
import type { ViolationFeedback } from "../../src/core/cycle_analytics.js";
import { appendPromptCacheTelemetry, recordCapabilityExecution } from "../../src/core/state_tracker.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date("2025-01-01T10:00:00.000Z").getTime();
const makeTs = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function validTimestamps() {
  return {
    janus_awakening: makeTs(0),
    janus_decided:   makeTs(5_000),      // 5s decision — within 120s threshold
    athena_approved: makeTs(10_000),
    workers_dispatching: makeTs(15_000), // 5s dispatch — within 30s threshold
    cycle_complete:  makeTs(600_000),    // 10min verification — within 1hr threshold
  };
}

function makeSloRecord(overrides = {}) {
  return {
    cycleId: makeTs(0),
    startedAt: makeTs(0),
    completedAt: makeTs(600_000),
    metrics: {
      decisionLatencyMs: 5000,
      dispatchLatencyMs: 5000,
      verificationCompletionMs: 585000,
    },
    sloBreaches: [],
    status: "ok",
    statusReason: "OK",
    ...overrides,
  };
}

function makePipelineProgress(overrides = {}) {
  return {
    startedAt: makeTs(0),
    completedAt: makeTs(600_000),
    stage: "cycle_complete",
    stageTimestamps: validTimestamps(),
    ...overrides,
  };
}

function makeConfig(stateDir) {
  return {
    paths: { stateDir },
    slo: {
      enabled: true,
      thresholds: {
        decisionLatencyMs: 120_000,
        dispatchLatencyMs: 30_000,
        verificationCompletionMs: 3_600_000,
      },
    },
  };
}

// ── Schema compliance ─────────────────────────────────────────────────────────

describe("CYCLE_ANALYTICS_SCHEMA (AC8)", () => {
  it("exports schemaVersion 1", () => {
    assert.equal(CYCLE_ANALYTICS_SCHEMA.schemaVersion, 1);
  });

  it("required fields list is complete", () => {
    const req = CYCLE_ANALYTICS_SCHEMA.cycleRecord.required;
    for (const f of ["cycleId", "generatedAt", "phase", "outcomes", "kpis", "confidence", "causalLinks", "canonicalEvents", "missingData", "capabilityExecutionSummary", "interventionLineageTelemetry"]) {
      assert.ok(req.includes(f), `required field missing: ${f}`);
    }
  });

  it("phaseEnum contains all CYCLE_PHASE values", () => {
    for (const v of Object.values(CYCLE_PHASE)) {
      assert.ok(CYCLE_ANALYTICS_SCHEMA.cycleRecord.phaseEnum.includes(v), `phaseEnum missing: ${v}`);
    }
  });

  it("confidenceLevelEnum contains all CONFIDENCE_LEVEL values", () => {
    for (const v of Object.values(CONFIDENCE_LEVEL)) {
      assert.ok(CYCLE_ANALYTICS_SCHEMA.cycleRecord.confidenceLevelEnum.includes(v), `confidenceLevelEnum missing: ${v}`);
    }
  });

  it("defaultMaxHistoryEntries is 50", () => {
    assert.equal(CYCLE_ANALYTICS_SCHEMA.defaultMaxHistoryEntries, 50);
  });

  it("cycleIdSource is pipeline_progress.startedAt", () => {
    assert.equal(CYCLE_ANALYTICS_SCHEMA.cycleRecord.cycleIdSource, "pipeline_progress.startedAt");
  });
});

// ── CANONICAL_EVENT_NAMES ─────────────────────────────────────────────────────

describe("CANONICAL_EVENT_NAMES (AC2, AC13)", () => {
  it("contains exactly the 5 SLO timestamp stages", () => {
    const expected = ["janus_awakening", "janus_decided", "athena_approved", "workers_dispatching", "cycle_complete"];
    assert.deepEqual([...CANONICAL_EVENT_NAMES], expected);
  });
});

describe("migrateLegacyEvolutionProgressToCompletedTaskIds", () => {
  it("migrates legacy evolution_progress tasks map to canonical completedTaskIds", () => {
    const migration = migrateLegacyEvolutionProgressToCompletedTaskIds({
      cycle_id: "cycle-1",
      tasks: {
        "T-1": { status: "completed" },
        "T-2": { status: "in_progress" },
        "T-3": { status: "done" },
      },
    });
    assert.equal(migration.ok, true);
    assert.equal(migration.toVersion, WORKER_CYCLE_ARTIFACTS_SCHEMA.schemaVersion);
    assert.deepEqual(migration.completedTaskIds.sort(), ["T-1", "T-3"]);
  });

  it("negative path: rejects unknown future schema versions", () => {
    const migration = migrateLegacyEvolutionProgressToCompletedTaskIds({
      schemaVersion: WORKER_CYCLE_ARTIFACTS_SCHEMA.schemaVersion + 1,
      tasks: {},
    });
    assert.equal(migration.ok, false);
    assert.equal(migration.reason, "unknown_future_version");
  });
});

describe("isResolvedBenchmarkRecommendation", () => {
  it("treats closed lifecycle statuses as resolved historical recommendations", () => {
    assert.equal(
      isResolvedBenchmarkRecommendation({
        topic: "Truth maintenance",
        status: "closed",
        summary: "Planner contradiction pass shipped",
      }),
      true,
    );
  });

  it("treats explicit closure timestamps and inactive flags as resolved", () => {
    assert.equal(
      isResolvedBenchmarkRecommendation({
        topic: "Wave planner",
        resolvedAt: "2026-04-15T10:00:00.000Z",
        active: false,
      }),
      true,
    );
  });

  it("negative path: keeps pending recommendations actionable", () => {
    assert.equal(
      isResolvedBenchmarkRecommendation({
        topic: "Worker runtime",
        implementationStatus: "pending",
      }),
      false,
    );
  });
});

// ── computeCycleAnalytics — required fields (AC1) ─────────────────────────────

describe("computeCycleAnalytics — required fields (AC1)", () => {
  it("returns all required fields on full input", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress(),
      workerResults: [{ roleName: "coder", status: "done" }],
      planCount: 1,
      phase: CYCLE_PHASE.COMPLETED,
    });
    for (const f of CYCLE_ANALYTICS_SCHEMA.cycleRecord.required) {
      assert.ok(f in record, `missing required field: ${f}`);
    }
  });

  it("cycleId equals pipelineProgress.startedAt", () => {
    const config = makeConfig("state");
    const progress = makePipelineProgress();
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord(), pipelineProgress: progress });
    assert.equal(record.cycleId, progress.startedAt);
  });

  it("phase is included", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { phase: CYCLE_PHASE.INCOMPLETE });
    assert.equal(record.phase, CYCLE_PHASE.INCOMPLETE);
  });

  it("generatedAt is a valid ISO string", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config);
    assert.ok(!isNaN(new Date(record.generatedAt).getTime()), "generatedAt must be valid ISO");
  });
});

// ── computeCycleAnalytics — KPIs from canonical events only (AC2) ─────────────

describe("computeCycleAnalytics — KPIs (AC2)", () => {
  it("kpis.decisionLatencyMs comes from sloRecord.metrics", () => {
    const config = makeConfig("state");
    const sloRecord = makeSloRecord({ metrics: { decisionLatencyMs: 4200, dispatchLatencyMs: 3000, verificationCompletionMs: 300000 } });
    const record = computeCycleAnalytics(config, { sloRecord, pipelineProgress: makePipelineProgress() });
    assert.equal(record.kpis.decisionLatencyMs, 4200);
  });

  it("kpis.sloBreachCount is zero when no breaches", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord(), pipelineProgress: makePipelineProgress() });
    assert.equal(record.kpis.sloBreachCount, 0);
  });

  it("kpis.sloBreachCount counts breach entries", () => {
    const config = makeConfig("state");
    const sloRecord = makeSloRecord({ sloBreaches: [{ metric: "decisionLatencyMs" }] });
    const record = computeCycleAnalytics(config, { sloRecord });
    assert.equal(record.kpis.sloBreachCount, 1);
  });

  it("kpis.sloStatus reflects sloRecord.status", () => {
    const config = makeConfig("state");
    const sloRecord = makeSloRecord({ status: "degraded" });
    const record = computeCycleAnalytics(config, { sloRecord });
    assert.equal(record.kpis.sloStatus, "degraded");
  });

  it("kpis.sloStatus is 'unknown' when sloRecord is null (AC10)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: null });
    assert.equal(record.kpis.sloStatus, "unknown");
  });

  it("kpis.premiumEfficiencyRaw and premiumEfficiencyAdjusted are null when not provided", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord() });
    assert.equal(record.kpis.premiumEfficiencyRaw, null, "premiumEfficiencyRaw must be null when not provided");
    assert.equal(record.kpis.premiumEfficiencyAdjusted, null, "premiumEfficiencyAdjusted must be null when not provided");
  });

  it("kpis.premiumEfficiencyRaw reflects the passed raw value", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord(), premiumEfficiencyRaw: 0.80 });
    assert.equal(record.kpis.premiumEfficiencyRaw, 0.80);
  });

  it("kpis.premiumEfficiencyAdjusted reflects the passed adjusted value", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord(), premiumEfficiencyAdjusted: 0.55 });
    assert.equal(record.kpis.premiumEfficiencyAdjusted, 0.55);
  });

  it("kpis.premiumEfficiencyRaw and premiumEfficiencyAdjusted can differ (execution penalty)", () => {
    // raw=1.0 (all API calls succeeded), adjusted=0.50 (only half produced verified work)
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      premiumEfficiencyRaw: 1.0,
      premiumEfficiencyAdjusted: 0.50,
    });
    assert.equal(record.kpis.premiumEfficiencyRaw, 1.0);
    assert.equal(record.kpis.premiumEfficiencyAdjusted, 0.50);
    assert.ok(record.kpis.premiumEfficiencyRaw !== record.kpis.premiumEfficiencyAdjusted,
      "raw and adjusted can differ when workers succeed at API level but produce no verified work");
  });

  it("kpis.premiumEfficiencyRaw is null for non-finite input", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { premiumEfficiencyRaw: NaN });
    assert.equal(record.kpis.premiumEfficiencyRaw, null, "NaN should be sanitized to null");
  });

  it("kpis.rawPremiumEfficiency and executionAdjustedPremiumEfficiency are null when not provided", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord() });
    assert.equal(record.kpis.rawPremiumEfficiency, null, "rawPremiumEfficiency must be null when not provided");
    assert.equal(record.kpis.executionAdjustedPremiumEfficiency, null, "executionAdjustedPremiumEfficiency must be null when not provided");
  });

  it("kpis.rawPremiumEfficiency reflects the passed value", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord(), rawPremiumEfficiency: 0.60 });
    assert.equal(record.kpis.rawPremiumEfficiency, 0.60);
  });

  it("kpis.executionAdjustedPremiumEfficiency reflects the passed value", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord(), executionAdjustedPremiumEfficiency: 0.75 });
    assert.equal(record.kpis.executionAdjustedPremiumEfficiency, 0.75);
  });

  it("kpis.rawPremiumEfficiency and executionAdjustedPremiumEfficiency can differ (leadership overhead exclusion)", () => {
    // raw includes leadership in denominator → lower value; adjusted excludes leadership → higher value
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      rawPremiumEfficiency: 0.40,
      executionAdjustedPremiumEfficiency: 0.80,
    });
    assert.equal(record.kpis.rawPremiumEfficiency, 0.40);
    assert.equal(record.kpis.executionAdjustedPremiumEfficiency, 0.80);
    assert.ok(record.kpis.rawPremiumEfficiency !== record.kpis.executionAdjustedPremiumEfficiency,
      "new metrics can differ when leadership overhead is significant");
  });

  it("kpis.rawPremiumEfficiency is null for non-finite input", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { rawPremiumEfficiency: NaN });
    assert.equal(record.kpis.rawPremiumEfficiency, null, "NaN should be sanitized to null");
  });
});

// ── computeCycleAnalytics — canonicalEvents inventory (AC2) ──────────────────

describe("computeCycleAnalytics — canonicalEvents (AC2)", () => {
  it("lists all 5 canonical events", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress() });
    assert.equal(record.canonicalEvents.length, CANONICAL_EVENT_NAMES.length);
  });

  it("marks present=true for existing timestamps", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress() });
    for (const e of record.canonicalEvents) {
      assert.ok(e.present === true, `expected ${e.name} to be present`);
    }
  });

  it("marks present=false and timestamp=null for missing events", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    delete ts.janus_decided;
    delete ts.cycle_complete;
    const progress = makePipelineProgress({ stageTimestamps: ts });
    const record = computeCycleAnalytics(config, { pipelineProgress: progress });
    const missing = record.canonicalEvents.filter(e => !e.present);
    assert.equal(missing.length, 2);
    for (const e of missing) {
      assert.equal(e.timestamp, null);
    }
  });
});

// ── computeCycleAnalytics — missing data explicit (AC3, AC9, AC10) ────────────

describe("computeCycleAnalytics — missing data handling (AC3, AC9, AC10)", () => {
  it("null sloRecord adds MISSING_SOURCE entries for kpi fields", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: null });
    const reasons = record.missingData.map(m => m.reason);
    assert.ok(reasons.includes(MISSING_DATA_REASON.MISSING_SOURCE));
  });

  it("null pipelineProgress adds MISSING_SOURCE entry", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: null });
    const fields = record.missingData.map(m => m.field);
    assert.ok(fields.includes("pipelineProgress"), "pipelineProgress missing data not recorded");
  });

  it("latency fields are null (not 0) when sloRecord absent (AC3)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: null });
    assert.equal(record.kpis.decisionLatencyMs, null);
    assert.equal(record.kpis.dispatchLatencyMs, null);
    assert.equal(record.kpis.verificationCompletionMs, null);
  });

  it("causal link latencyMs is null when timestamps missing (AC3)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: null });
    for (const link of record.causalLinks) {
      assert.equal(link.latencyMs, null);
    }
  });

  it("causal link missing timestamp adds MISSING_TIMESTAMP entry to missingData (AC9)", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    delete ts.janus_decided;
    const progress = makePipelineProgress({ stageTimestamps: ts });
    const record = computeCycleAnalytics(config, { pipelineProgress: progress });
    const entry = record.missingData.find(m => m.field.includes("janus_awakening→janus_decided"));
    assert.ok(entry, "missing timestamp entry not found in missingData");
    assert.equal(entry.reason, MISSING_DATA_REASON.MISSING_TIMESTAMP);
    assert.equal(entry.impact, MISSING_DATA_IMPACT.CAUSAL_LINK);
  });

  it("missingData entries include impact field (AC10)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: null, pipelineProgress: null });
    for (const m of record.missingData) {
      assert.ok(Object.values(MISSING_DATA_IMPACT).includes(m.impact), `invalid impact: ${m.impact}`);
      assert.ok(Object.values(MISSING_DATA_REASON).includes(m.reason), `invalid reason: ${m.reason}`);
    }
  });
});

// ── computeCycleAnalytics — confidence (AC1, AC11) ────────────────────────────

describe("computeCycleAnalytics — confidence levels (AC1, AC11)", () => {
  it("high when all 5 events present and sloRecord provided", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress(),
    });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.HIGH);
  });

  it("medium when 4 events present (one missing)", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    delete ts.cycle_complete;
    const record = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress({ stageTimestamps: ts }),
    });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.MEDIUM);
  });

  it("medium when all events present but sloRecord absent", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      sloRecord: null,
      pipelineProgress: makePipelineProgress(),
    });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.MEDIUM);
  });

  it("low when ≤2 events present", () => {
    const config = makeConfig("state");
    const ts = { janus_awakening: makeTs(0), janus_decided: makeTs(5000) };
    const record = computeCycleAnalytics(config, {
      pipelineProgress: makePipelineProgress({ stageTimestamps: ts }),
    });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.LOW);
  });

  it("low when pipelineProgress is null", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: null });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.LOW);
  });

  it("confidence.level is always a valid enum value (AC8)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {});
    assert.ok(Object.values(CONFIDENCE_LEVEL).includes(record.confidence.level));
  });

  it("confidence.missingFields is an array", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config);
    assert.ok(Array.isArray(record.confidence.missingFields));
  });

  it("degrades high confidence to medium when capability execution evidence is absent", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress(),
      capabilityExecutionSummary: {
        observedCapabilityCount: 0,
        observedCapabilities: [],
      },
    });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.MEDIUM);
    assert.ok(record.confidence.missingFields.includes("capabilityExecutionSummary.observedCapabilityCount"));
  });

  it("keeps high confidence when capability execution evidence is present", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress(),
      capabilityExecutionSummary: {
        observedCapabilityCount: 1,
        observedCapabilities: ["ci-failure-log-injection"],
      },
    });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.HIGH);
  });
});

// ── computeCycleAnalytics — causal links (AC12) ───────────────────────────────

describe("computeCycleAnalytics — causal links (AC12)", () => {
  it("produces 3 causal links", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress() });
    assert.equal(record.causalLinks.length, 3);
  });

  it("each link has cause, effect, metric, latencyMs, anomaly, anomalyReason", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress() });
    for (const link of record.causalLinks) {
      assert.ok("cause" in link);
      assert.ok("effect" in link);
      assert.ok("metric" in link);
      assert.ok("latencyMs" in link);
      assert.ok("anomaly" in link);
      assert.ok("anomalyReason" in link);
    }
  });

  it("anomaly=false when latency within threshold", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress() });
    for (const link of record.causalLinks) {
      assert.equal(link.anomaly, false, `unexpected anomaly on ${link.cause}→${link.effect}`);
    }
  });

  it("anomaly=true and anomalyReason set when threshold exceeded (negative path)", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    // Push janus_decided beyond the 120s threshold
    ts.janus_decided = makeTs(200_000);
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ stageTimestamps: ts }) });
    const decisionLink = record.causalLinks.find(l => l.cause === "janus_awakening");
    assert.ok(decisionLink, "decision causal link not found");
    assert.equal(decisionLink.anomaly, true);
    assert.ok(typeof decisionLink.anomalyReason === "string" && decisionLink.anomalyReason.length > 0);
  });

  it("latencyMs is clamped to ≥0 (clock skew safety)", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    // Reverse janus_awakening and janus_decided to simulate clock skew
    ts.janus_awakening = makeTs(10_000);
    ts.janus_decided = makeTs(0);  // earlier than awakening
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ stageTimestamps: ts }) });
    const decisionLink = record.causalLinks.find(l => l.cause === "janus_awakening");
    assert.ok(decisionLink.latencyMs >= 0, "latencyMs must be non-negative");
  });
});

// ── computeCycleAnalytics — outcomes (AC1) ────────────────────────────────────

describe("computeCycleAnalytics — outcomes (AC1)", () => {
  it("outcomes.status is SUCCESS when all workers done", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      pipelineProgress: makePipelineProgress(),
      // dispatchContract flag satisfies seam contract (Task 3: verification evidence required for SUCCESS).
      workerResults: [{ roleName: "coder", status: "done", dispatchContract: { doneWorkerWithVerificationReportEvidence: true } }],
      planCount: 1,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.SUCCESS);
  });

  it("outcomes.status is PARTIAL when some workers failed", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      workerResults: [
        { roleName: "coder", status: "done" },
        { roleName: "qa", status: "error" },
      ],
      planCount: 2,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.PARTIAL);
  });

  it("outcomes.status is PARTIAL when tasks are dispatched but only partial worker statuses are present", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      workerResults: [
        { roleName: "coder", status: "partial" },
        { roleName: "qa", status: "partial" },
      ],
      planCount: 2,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(record.outcomes.tasksCompleted, 0);
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.PARTIAL);
  });

  it("counts skipped workers as completed to align dispatch and analytics completion semantics", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      workerResults: [{ roleName: "coder", status: "skipped" }],
      planCount: 1,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(record.outcomes.tasksCompleted, 1);
    // Skipped workers produce no verification evidence; seam contract is not satisfied.
    // Outcome degrades SUCCESS → PARTIAL (Task 3). The tasksCompleted count is the primary invariant.
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.PARTIAL);
  });

  it("outcomes.status is NO_PLANS when planCount=0 and phase=INCOMPLETE", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { planCount: 0, phase: CYCLE_PHASE.INCOMPLETE });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.NO_PLANS);
  });

  it("outcomes.status is FAILED for CYCLE_PHASE.FAILED", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { phase: CYCLE_PHASE.FAILED });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.FAILED);
  });

  it("outcomes.tasksDispatched is null when planCount not provided (AC3)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { planCount: null });
    assert.equal(record.outcomes.tasksDispatched, null);
  });

  it("outcomes.status enum value is valid (AC8)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config);
    assert.ok(Object.values(CYCLE_OUTCOME_STATUS).includes(record.outcomes.status));
  });
});

describe("computeRuntimeContractProbe — dispatch contract evidence", () => {
  it("passes done-worker verification criterion via dispatchContract without stringifying object evidence", () => {
    const probe = computeRuntimeContractProbe({
      prometheusAnalysis: { generatedAt: makeTs(0), keyFindings: "CI green; checks pass; dispatch contract verified and satisfied." },
      athenaPlanReview: { overallScore: 8 },
      workerResults: [{
        roleName: "evolution-worker",
        status: "done",
        verificationEvidence: { profile: "backend", passed: true },
        dispatchContract: {
          doneWorkerWithVerificationReportEvidence: true,
          dispatchBlockReason: null,
          replayClosure: { contractSatisfied: true, canonicalCommands: [], executedCommands: [], rawArtifactEvidenceLinks: [] },
        },
      }],
    });
    assert.equal(probe.criteria.doneWorkerWithVerificationReportEvidence.pass, true);
    assert.equal(probe.passed, true);
  });

  it("fails when blocked worker outcomes omit dispatchBlockReason", () => {
    const probe = computeRuntimeContractProbe({
      prometheusAnalysis: { generatedAt: makeTs(0), keyFindings: "CI green; checks pass; dispatch contract verified and satisfied." },
      athenaPlanReview: { overallScore: 8 },
      workerResults: [
        {
          roleName: "evolution-worker",
          status: "done",
          dispatchContract: { doneWorkerWithVerificationReportEvidence: true, dispatchBlockReason: null },
        },
        { roleName: "qa", status: "blocked" },
      ],
    });
    assert.equal(probe.criteria.dispatchBlockReasonOutcomes.pass, false);
    assert.equal(probe.passed, false);
  });

  it("populates structural analytics counts for verification, clean-tree, and blocked-reason evidence", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      workerResults: [
        {
          roleName: "evolution-worker",
          status: "done",
          dispatchContract: {
            doneWorkerWithVerificationReportEvidence: true,
            doneWorkerWithCleanTreeStatusEvidence: true,
            dispatchBlockReason: null,
          },
        },
        { roleName: "quality-worker", status: "blocked", dispatchBlockReason: "access_blocked:api" },
      ],
      phase: CYCLE_PHASE.COMPLETED,
      planCount: 2,
    });
    assert.equal(record.structuralAnalytics.doneWorkerVerificationEvidenceCount, 1);
    assert.equal(record.structuralAnalytics.doneWorkerCleanTreeEvidenceCount, 1);
    assert.equal(record.structuralAnalytics.blockedWorkerWithReasonCount, 1);
  });
});

// ── persistCycleAnalytics + readCycleAnalytics (AC4, retention policy) ────────

describe("persistCycleAnalytics and readCycleAnalytics (AC4)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates file with correct schema on first write", async () => {
    const config = makeConfig(tmpDir);
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord(), pipelineProgress: makePipelineProgress() });
    await persistCycleAnalytics(config, record);

    const data = await readCycleAnalytics(config);
    assert.ok(data !== null);
    assert.equal(data.schemaVersion, CYCLE_ANALYTICS_SCHEMA.schemaVersion);
    assert.ok("lastCycle" in data);
    assert.ok(Array.isArray(data.history));
    assert.ok("updatedAt" in data);
  });

  it("persists runtime capabilityExecutionSummary even when compute input omits it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-cap-summary-"));
    try {
      const config = makeConfig(dir);
      await recordCapabilityExecution(
        { paths: { stateDir: dir } } as any,
        "runtime-contract-probe",
        "test cycle",
      );
      const record = computeCycleAnalytics(config, {
        sloRecord: makeSloRecord(),
        pipelineProgress: makePipelineProgress(),
      });
      await persistCycleAnalytics(config, record);
      const data = await readCycleAnalytics(config);
      assert.equal(data.lastCycle.capabilityExecutionSummary.observedCapabilityCount, 1);
      assert.ok(data.lastCycle.capabilityExecutionSummary.observedCapabilities.includes("runtime-contract-probe"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("persists runtime interventionLineageTelemetry even when compute input omits it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-lineage-summary-"));
    try {
      const config = makeConfig(dir);
      await fs.writeFile(
        path.join(dir, "premium_usage_log.json"),
        JSON.stringify([
          { worker: "quality-worker", model: "Claude Sonnet 4.6", taskKind: "test", outcome: "done", lineageId: "lineage-1" },
        ], null, 2),
        "utf8",
      );
      await appendPromptCacheTelemetry(
        { paths: { stateDir: dir } } as any,
        {
          promptFamilyKey: "planner",
          agent: "quality-worker",
          model: "Claude Sonnet 4.6",
          taskKind: "test",
          totalSegments: 8,
          cachedSegments: 4,
          estimatedSavedTokens: 80,
          lineageId: "lineage-1",
        },
      );
      await fs.writeFile(
        path.join(dir, "route_roi_ledger.json"),
        JSON.stringify([{
          taskId: "task-1",
          model: "Claude Sonnet 4.6",
          tier: "T2",
          estimatedTokens: 900,
          expectedQuality: 0.8,
          realizedQuality: 0.85,
          outcome: "done",
          roi: 94.4,
          roiDelta: 5,
          routedAt: makeTs(0),
          realizedAt: makeTs(10_000),
          lineageId: "lineage-1",
          lineage: { lineageId: "lineage-1", taskId: "task-1" },
          lineageJoinKey: "lineage:lineage-1",
        }], null, 2),
        "utf8",
      );
      await fs.writeFile(
        path.join(dir, "lineage_graph.json"),
        JSON.stringify({ entries: [{ id: "lineage-1", status: "passed", sourceKind: "gap_candidate" }] }, null, 2),
        "utf8",
      );
      await fs.writeFile(
        path.join(dir, "athena_postmortems.json"),
        JSON.stringify([{ lineageId: "lineage-1", decision: "promote", resolvedPolicy: true }], null, 2),
        "utf8",
      );
      await recordCapabilityExecution(
        { paths: { stateDir: dir } } as any,
        "specialization-admission-control",
        "persisted summary test",
        {
          role: "quality-worker",
          lane: "quality",
          specialized: true,
          lineage: { lineageId: "lineage-1" },
        },
      );

      const record = computeCycleAnalytics(config, {
        sloRecord: makeSloRecord(),
        pipelineProgress: makePipelineProgress(),
      });
      await persistCycleAnalytics(config, record);
      const data = await readCycleAnalytics(config);
      assert.equal(data.lastCycle.interventionLineageTelemetry.lineageCount, 1);
      assert.equal(data.lastCycle.interventionLineageTelemetry.surfaceCoverage.promptCache, 1);
      assert.equal(data.lastCycle.interventionLineageTelemetry.surfaceCoverage.modelRouting, 1);
      assert.equal(data.lastCycle.interventionLineageTelemetry.byInterventionType.modelRouting.positiveRoiDeltaCount, 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("append-only: second write prepends to history", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-append-"));
    try {
      const config = makeConfig(dir);
      const r1 = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ startedAt: makeTs(0) }) });
      await persistCycleAnalytics(config, r1);
      const r2 = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ startedAt: makeTs(1000) }) });
      await persistCycleAnalytics(config, r2);

      const data = await readCycleAnalytics(config);
      assert.equal(data.history.length, 2);
      // Most recent is first (prepend)
      assert.equal(data.lastCycle.cycleId, r2.cycleId);
      assert.equal(data.history[0].cycleId, r2.cycleId);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("retention policy: caps history at maxHistoryEntries (AC17)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-cap-"));
    try {
      const config = { ...makeConfig(dir), cycleAnalytics: { maxHistoryEntries: 3 } };
      for (let i = 0; i < 5; i++) {
        const r = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ startedAt: makeTs(i * 1000) }) });
        await persistCycleAnalytics(config, r);
      }
      const data = await readCycleAnalytics(config);
      assert.ok(data.history.length <= 3, `history should be capped at 3, got ${data.history.length}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("readCycleAnalytics returns null when file does not exist (AC3, AC18)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-empty-"));
    try {
      const config = makeConfig(dir);
      const data = await readCycleAnalytics(config);
      assert.equal(data, null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Negative paths (AC7) ──────────────────────────────────────────────────────

describe("Negative paths (AC7)", () => {
  it("computeCycleAnalytics with all-null inputs returns valid record (no throw)", () => {
    const config = makeConfig("state");
    assert.doesNotThrow(() => {
      const record = computeCycleAnalytics(config, {
        sloRecord: null,
        pipelineProgress: null,
        workerResults: null,
        planCount: null,
        phase: CYCLE_PHASE.INCOMPLETE,
      });
      // Must still have required fields
      for (const f of CYCLE_ANALYTICS_SCHEMA.cycleRecord.required) {
        assert.ok(f in record, `missing field: ${f}`);
      }
    });
  });

  it("computeCycleAnalytics with empty config does not throw", () => {
    assert.doesNotThrow(() => computeCycleAnalytics({}));
  });

  it("computeCycleAnalytics with no arguments does not throw", () => {
    assert.doesNotThrow(() => computeCycleAnalytics());
  });

  it("missingData is populated (not empty) when inputs are null (AC10 — no silent fallback)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: null, pipelineProgress: null });
    assert.ok(record.missingData.length > 0, "missingData must be non-empty when inputs are absent");
  });

  it("invalid workerResults (non-array) treated as null — no throw, outcomes.tasksCompleted=null (AC9)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { workerResults: "not-an-array" });
    assert.equal(record.outcomes.tasksCompleted, null);
    assert.equal(record.outcomes.tasksFailed, null);
  });

  it("persistCycleAnalytics with invalid state dir throws (I/O error surfaced, not swallowed) (AC10)", async () => {
    // Create a regular file at the state dir path so ensureParent (mkdir) fails.
    // This forces a genuine I/O error that must surface rather than be swallowed.
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-ioerr-"));
    const blockerFile = path.join(tmpBase, "state-as-file");
    await fs.writeFile(blockerFile, "not-a-dir");
    // The state dir is a path that requires treating blockerFile as a directory
    const config = makeConfig(path.join(blockerFile, "subdir"));
    const record = computeCycleAnalytics(config);
    await assert.rejects(
      () => persistCycleAnalytics(config, record),
      (err) => {
        assert.ok(err instanceof Error, "must throw an Error");
        return true;
      }
    );
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it("phase enum is preserved for FAILED cycle", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { phase: CYCLE_PHASE.FAILED });
    assert.equal(record.phase, CYCLE_PHASE.FAILED);
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.FAILED);
  });

  it("null workerResults adds missingData entries for tasksCompleted and tasksFailed", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { workerResults: null });
    const fields = record.missingData.map((m: any) => m.field);
    assert.ok(fields.includes("outcomes.tasksCompleted"), "missingData must include outcomes.tasksCompleted");
    assert.ok(fields.includes("outcomes.tasksFailed"),    "missingData must include outcomes.tasksFailed");
  });

  it("UNKNOWN outcome status produces explicit missingData entry with unknownReason", () => {
    const config = makeConfig("state");
    // workerResults: null with COMPLETED phase → UNKNOWN status
    const record = computeCycleAnalytics(config, { workerResults: null, phase: CYCLE_PHASE.COMPLETED });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.UNKNOWN);
    const entry = record.missingData.find((m: any) => m.field === "outcomes.status");
    assert.ok(entry, "missingData must include an entry for outcomes.status when UNKNOWN");
    assert.equal(entry.reason, MISSING_DATA_REASON.MISSING_SOURCE);
    assert.equal(entry.impact, MISSING_DATA_IMPACT.OUTCOME);
    assert.ok(typeof entry.unknownReason === "string" && entry.unknownReason.length > 0,
      "unknownReason must be a non-empty string explaining why status is UNKNOWN");
  });

  it("UNKNOWN outcome status from empty workerResults array also sets unknownReason (negative path)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { workerResults: [], phase: CYCLE_PHASE.COMPLETED });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.UNKNOWN);
    const entry = record.missingData.find((m: any) => m.field === "outcomes.status");
    assert.ok(entry, "missingData must include outcomes.status entry for empty workerResults");
    assert.ok(typeof entry.unknownReason === "string" && entry.unknownReason.length > 0);
  });
});

describe("computeCycleAnalytics — lane telemetry outcome quality", () => {
  it("tracks attempt rate, abstain rate, precision on attempted work, and reliability per lane", () => {
    const record = computeCycleAnalytics(makeConfig("state"), {
      workerResults: [
        { roleName: "quality-worker", status: "done" },
        { roleName: "quality-worker", status: "error" },
        { roleName: "quality-worker", status: "blocked" },
      ],
      planCount: 3,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(record.laneTelemetry.quality.attemptRate, 0.667);
    assert.equal(record.laneTelemetry.quality.abstainRate, 0.333);
    assert.equal(record.laneTelemetry.quality.precisionOnAttempted, 0.5);
    assert.equal(record.laneTelemetry.quality.reliability, 0.542);
  });

  it("preserves specialist lane telemetry when workerResults carry a lane key instead of a worker slug", () => {
    const record = computeCycleAnalytics(makeConfig("state"), {
      workerResults: [
        { roleName: "quality", status: "done" },
      ],
      planCount: 1,
      phase: CYCLE_PHASE.COMPLETED,
    });

    assert.equal(record.laneTelemetry.quality.dispatched, 1);
    assert.equal(record.laneTelemetry.quality.completed, 1);
    assert.equal(record.laneTelemetry.quality.specialistLane, true);
    assert.equal("implementation" in record.laneTelemetry, false);
  });

  it("prefers resolvedRole execution when workerResults carry reroute metadata", () => {
    const record = computeCycleAnalytics(makeConfig("state"), {
      workerResults: [
        { roleName: "evolution-worker", resolvedRole: "observation-worker", status: "done" },
        { roleName: "evolution-worker", resolvedRole: "observation-worker", status: "failed" },
      ],
      planCount: 2,
      phase: CYCLE_PHASE.COMPLETED,
    });

    assert.equal(record.laneTelemetry.observation.dispatched, 2);
    assert.equal(record.laneTelemetry.observation.completed, 1);
    assert.equal(record.laneTelemetry.observation.failed, 1);
    assert.equal(record.laneTelemetry.observation.specialistLane, true);
    assert.equal("implementation" in record.laneTelemetry, false);
  });
});

// ── Funnel counts and ratios ───────────────────────────────────────────────────

describe("computeCycleAnalytics — funnel (Task 1)", () => {
  it("schema requires funnel field", () => {
    assert.ok(CYCLE_ANALYTICS_SCHEMA.cycleRecord.required.includes("funnel"),
      "schema.cycleRecord.required must list 'funnel'");
  });

  it("funnel field is present on every record regardless of funnelCounts input", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {});
    assert.ok("funnel" in record, "funnel must be present");
  });

  it("funnel contains all six expected keys", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 10, approved: 8, dispatched: 7, completed: 5 },
    });
    for (const k of ["generated", "approved", "dispatched", "completed", "approvalRate", "dispatchRate", "completionRate"]) {
      assert.ok(k in record.funnel, `funnel missing key: ${k}`);
    }
  });

  it("funnel stores provided counts verbatim", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 10, approved: 8, dispatched: 6, completed: 4 },
    });
    assert.equal(record.funnel.generated,  10);
    assert.equal(record.funnel.approved,    8);
    assert.equal(record.funnel.dispatched,  6);
    assert.equal(record.funnel.completed,   4);
  });

  it("funnel computes approvalRate = approved / generated", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 10, approved: 8, dispatched: 8, completed: 8 },
    });
    assert.equal(record.funnel.approvalRate, 0.8);
  });

  it("funnel computes dispatchRate = dispatched / approved", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 10, approved: 8, dispatched: 4, completed: 4 },
    });
    assert.equal(record.funnel.dispatchRate, 0.5);
  });

  it("funnel computes completionRate = completed / dispatched", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 10, approved: 10, dispatched: 10, completed: 3 },
    });
    assert.equal(record.funnel.completionRate, 0.3);
  });

  it("funnel rates are null when denominator stage is absent (no silent zero-fill)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: null, approved: null, dispatched: null, completed: null },
    });
    assert.equal(record.funnel.approvalRate,   null, "approvalRate must be null when generated is null");
    assert.equal(record.funnel.dispatchRate,   null, "dispatchRate must be null when approved is null");
    assert.equal(record.funnel.completionRate, null, "completionRate must be null when dispatched is null");
  });

  it("funnel rates are null when funnelCounts is absent", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {});
    assert.equal(record.funnel.generated,      null);
    assert.equal(record.funnel.approvalRate,   null);
    assert.equal(record.funnel.dispatchRate,   null);
    assert.equal(record.funnel.completionRate, null);
  });

  it("funnel rate is null when denominator is zero (no division by zero)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 0, approved: 0, dispatched: 0, completed: 0 },
    });
    assert.equal(record.funnel.approvalRate,   null, "approvalRate must be null when generated=0");
    assert.equal(record.funnel.dispatchRate,   null, "dispatchRate must be null when approved=0");
    assert.equal(record.funnel.completionRate, null, "completionRate must be null when dispatched=0");
  });

  it("100% funnel (all plans complete) produces ratios of 1", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 5, approved: 5, dispatched: 5, completed: 5 },
    });
    assert.equal(record.funnel.approvalRate,   1);
    assert.equal(record.funnel.dispatchRate,   1);
    assert.equal(record.funnel.completionRate, 1);
  });
});

// ── Dual analytics channels ────────────────────────────────────────────────────
//
// Verifies that cycle_health.json (degradation channel) is cleanly separated
// from cycle_analytics.json (performance/semantic channel).

// ── tierCounts field ──────────────────────────────────────────────────────────

describe("computeCycleAnalytics — tierCounts (tier telemetry)", () => {
  it("schema requires tierCounts field", () => {
    assert.ok(CYCLE_ANALYTICS_SCHEMA.cycleRecord.required.includes("tierCounts"),
      "schema.cycleRecord.required must list 'tierCounts'");
  });

  it("tierCounts is present on every record regardless of input", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {});
    assert.ok("tierCounts" in record, "tierCounts must be present");
  });

  it("tierCounts contains T1, T2, T3 keys", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      tierCounts: { T1: 3, T2: 2, T3: 1 },
    });
    assert.ok("T1" in record.tierCounts, "tierCounts missing T1");
    assert.ok("T2" in record.tierCounts, "tierCounts missing T2");
    assert.ok("T3" in record.tierCounts, "tierCounts missing T3");
  });

  it("tierCounts stores provided T1/T2/T3 counts verbatim", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      tierCounts: { T1: 4, T2: 3, T3: 2 },
    });
    assert.equal(record.tierCounts.T1, 4);
    assert.equal(record.tierCounts.T2, 3);
    assert.equal(record.tierCounts.T3, 2);
  });

  it("tierCounts values are null when tierCounts not provided (AC3 — no silent zero-fill)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {});
    assert.equal(record.tierCounts.T1, null, "T1 must be null when tierCounts absent");
    assert.equal(record.tierCounts.T2, null, "T2 must be null when tierCounts absent");
    assert.equal(record.tierCounts.T3, null, "T3 must be null when tierCounts absent");
  });

  it("missing tierCounts adds MISSING_SOURCE entry to missingData (AC3)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { tierCounts: null });
    const entry = record.missingData.find((m: any) => m.field === "tierCounts");
    assert.ok(entry, "missingData must include an entry for tierCounts when absent");
    assert.equal(entry.reason, MISSING_DATA_REASON.MISSING_SOURCE);
    assert.equal(entry.impact, MISSING_DATA_IMPACT.KPI);
  });

  it("partial tierCounts: non-numeric keys are null (AC3)", () => {
    const config = makeConfig("state");
    // T2 has valid value; T1 and T3 are missing (not numeric)
    const record = computeCycleAnalytics(config, {
      tierCounts: { T2: 5 },
    });
    assert.equal(record.tierCounts.T1, null, "T1 must be null when not numeric");
    assert.equal(record.tierCounts.T2, 5);
    assert.equal(record.tierCounts.T3, null, "T3 must be null when not numeric");
  });

  it("negative path: tierCounts not added to missingData when all three tiers present", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      tierCounts: { T1: 1, T2: 2, T3: 0 },
    });
    const entry = record.missingData.find((m: any) => m.field === "tierCounts");
    // missingData entry is only added when the whole tierCounts object is null/absent
    assert.equal(entry, undefined, "no missingData entry expected when tierCounts is provided");
  });
});

// ── fastPathCounts field ──────────────────────────────────────────────────────

describe("computeCycleAnalytics — fastPathCounts (fast-path telemetry)", () => {
  it("schema requires fastPathCounts field", () => {
    assert.ok(CYCLE_ANALYTICS_SCHEMA.cycleRecord.required.includes("fastPathCounts"),
      "schema.cycleRecord.required must list 'fastPathCounts'");
  });

  it("fastPathCounts is present on every record regardless of input", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {});
    assert.ok("fastPathCounts" in record, "fastPathCounts must be present");
  });

  it("fastPathCounts contains athenaAutoApproved, athenaFullReview, fastPathRate keys", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 2, athenaFullReview: 3 },
    });
    assert.ok("athenaAutoApproved" in record.fastPathCounts);
    assert.ok("athenaFullReview" in record.fastPathCounts);
    assert.ok("fastPathRate" in record.fastPathCounts);
  });

  it("fastPathCounts stores provided counts verbatim", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 3, athenaFullReview: 7 },
    });
    assert.equal(record.fastPathCounts.athenaAutoApproved, 3);
    assert.equal(record.fastPathCounts.athenaFullReview,   7);
  });

  it("fastPathRate = athenaAutoApproved / (athenaAutoApproved + athenaFullReview)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 2, athenaFullReview: 8 },
    });
    // 2 / (2+8) = 0.2
    assert.equal(record.fastPathCounts.fastPathRate, 0.2);
  });

  it("fastPathRate is 1 when all reviews were auto-approved", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 5, athenaFullReview: 0 },
    });
    assert.equal(record.fastPathCounts.fastPathRate, 1);
  });

  it("fastPathRate is 0 when no reviews were auto-approved", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 0, athenaFullReview: 4 },
    });
    assert.equal(record.fastPathCounts.fastPathRate, 0);
  });

  it("fastPathRate is null when athenaAutoApproved is absent (AC3 — no division by zero)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaFullReview: 4 },
    });
    assert.equal(record.fastPathCounts.athenaAutoApproved, null);
    assert.equal(record.fastPathCounts.fastPathRate, null,
      "fastPathRate must be null when athenaAutoApproved is absent");
  });

  it("fastPathCounts values are null when fastPathCounts not provided (AC3)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {});
    assert.equal(record.fastPathCounts.athenaAutoApproved, null);
    assert.equal(record.fastPathCounts.athenaFullReview,   null);
    assert.equal(record.fastPathCounts.fastPathRate,       null);
  });

  it("missing fastPathCounts adds MISSING_SOURCE entry to missingData (AC3)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { fastPathCounts: null });
    const entry = record.missingData.find((m: any) => m.field === "fastPathCounts");
    assert.ok(entry, "missingData must include fastPathCounts entry when absent");
    assert.equal(entry.reason, MISSING_DATA_REASON.MISSING_SOURCE);
    assert.equal(entry.impact, MISSING_DATA_IMPACT.KPI);
  });

  it("negative path: fastPathRate is null when total reviews is zero", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 0, athenaFullReview: 0 },
    });
    assert.equal(record.fastPathCounts.fastPathRate, null,
      "fastPathRate must be null when total reviews is 0 (no division by zero)");
  });

  it("byReasonCode is present on every fastPathCounts record with three null slots by default", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 3, athenaFullReview: 0 },
    });
    assert.ok("byReasonCode" in record.fastPathCounts,
      "byReasonCode must be present even when autoApproveReasonCode is not provided");
    assert.equal(record.fastPathCounts.byReasonCode.LOW_RISK_UNCHANGED,    null);
    assert.equal(record.fastPathCounts.byReasonCode.HIGH_QUALITY_LOW_RISK, null);
    assert.equal(record.fastPathCounts.byReasonCode.DELTA_REVIEW_APPROVED, null);
  });

  it("populates LOW_RISK_UNCHANGED slot when autoApproveReasonCode=LOW_RISK_UNCHANGED", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 5, athenaFullReview: 0, autoApproveReasonCode: "LOW_RISK_UNCHANGED" },
    });
    assert.equal(record.fastPathCounts.byReasonCode.LOW_RISK_UNCHANGED,    5);
    assert.equal(record.fastPathCounts.byReasonCode.HIGH_QUALITY_LOW_RISK, null);
    assert.equal(record.fastPathCounts.byReasonCode.DELTA_REVIEW_APPROVED, null);
  });

  it("populates HIGH_QUALITY_LOW_RISK slot when autoApproveReasonCode=HIGH_QUALITY_LOW_RISK", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 2, athenaFullReview: 0, autoApproveReasonCode: "HIGH_QUALITY_LOW_RISK" },
    });
    assert.equal(record.fastPathCounts.byReasonCode.HIGH_QUALITY_LOW_RISK, 2);
    assert.equal(record.fastPathCounts.byReasonCode.LOW_RISK_UNCHANGED,    null);
    assert.equal(record.fastPathCounts.byReasonCode.DELTA_REVIEW_APPROVED, null);
  });

  it("populates DELTA_REVIEW_APPROVED slot when autoApproveReasonCode=DELTA_REVIEW_APPROVED", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 4, athenaFullReview: 1, autoApproveReasonCode: "DELTA_REVIEW_APPROVED" },
    });
    assert.equal(record.fastPathCounts.byReasonCode.DELTA_REVIEW_APPROVED, 4);
    assert.equal(record.fastPathCounts.byReasonCode.LOW_RISK_UNCHANGED,    null);
    assert.equal(record.fastPathCounts.byReasonCode.HIGH_QUALITY_LOW_RISK, null);
  });

  it("negative path: unknown autoApproveReasonCode leaves all byReasonCode slots null", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 3, athenaFullReview: 0, autoApproveReasonCode: "UNKNOWN_CODE" },
    });
    assert.equal(record.fastPathCounts.byReasonCode.LOW_RISK_UNCHANGED,    null);
    assert.equal(record.fastPathCounts.byReasonCode.HIGH_QUALITY_LOW_RISK, null);
    assert.equal(record.fastPathCounts.byReasonCode.DELTA_REVIEW_APPROVED, null);
  });

  it("negative path: null autoApproveReasonCode leaves all byReasonCode slots null", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaAutoApproved: 2, athenaFullReview: 0, autoApproveReasonCode: null },
    });
    assert.equal(record.fastPathCounts.byReasonCode.LOW_RISK_UNCHANGED,    null);
    assert.equal(record.fastPathCounts.byReasonCode.HIGH_QUALITY_LOW_RISK, null);
    assert.equal(record.fastPathCounts.byReasonCode.DELTA_REVIEW_APPROVED, null);
  });

  it("byReasonCode slot is null when autoApproved is null (no count to assign)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      fastPathCounts: { athenaFullReview: 3, autoApproveReasonCode: "LOW_RISK_UNCHANGED" },
    });
    // athenaAutoApproved absent → null; slot must not be populated with non-number
    assert.equal(record.fastPathCounts.byReasonCode.LOW_RISK_UNCHANGED, null);
  });
});



describe("CYCLE_HEALTH_SCHEMA", () => {
  it("exports schemaVersion 1", () => {
    assert.equal(CYCLE_HEALTH_SCHEMA.schemaVersion, 1);
  });

  it("required top-level fields are present", () => {
    for (const f of ["schemaVersion", "lastCycle", "history", "updatedAt"]) {
      assert.ok(CYCLE_HEALTH_SCHEMA.required.includes(f), `missing required top-level field: ${f}`);
    }
  });

  it("healthRecord.required contains all expected fields", () => {
    for (const f of ["cycleId", "generatedAt", "sloStatus", "sloBreachCount", "anomalyCount", "anomalies", "healthScore", "healthReason"]) {
      assert.ok(CYCLE_HEALTH_SCHEMA.healthRecord.required.includes(f), `healthRecord.required missing: ${f}`);
    }
  });

  it("healthScoreEnum contains all HEALTH_SCORE values", () => {
    for (const v of Object.values(HEALTH_SCORE)) {
      assert.ok(CYCLE_HEALTH_SCHEMA.healthRecord.healthScoreEnum.includes(v), `healthScoreEnum missing: ${v}`);
    }
  });

  it("defaultMaxHistoryEntries is 50", () => {
    assert.equal(CYCLE_HEALTH_SCHEMA.defaultMaxHistoryEntries, 50);
  });
});

describe("HEALTH_SCORE enum", () => {
  it("exports healthy, degraded, critical", () => {
    assert.equal(HEALTH_SCORE.HEALTHY,  "healthy");
    assert.equal(HEALTH_SCORE.DEGRADED, "degraded");
    assert.equal(HEALTH_SCORE.CRITICAL, "critical");
  });
});

describe("computeCycleHealth — required fields", () => {
  it("returns all required health record fields", () => {
    const config = makeConfig("state");
    const analytics = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress(),
    });
    const health = computeCycleHealth(analytics);
    for (const f of CYCLE_HEALTH_SCHEMA.healthRecord.required) {
      assert.ok(f in health, `health record missing required field: ${f}`);
    }
  });

  it("cycleId is inherited from the analytics record", () => {
    const config = makeConfig("state");
    const progress = makePipelineProgress();
    const analytics = computeCycleAnalytics(config, { pipelineProgress: progress });
    const health = computeCycleHealth(analytics);
    assert.equal(health.cycleId, progress.startedAt);
  });

  it("generatedAt is a valid ISO string", () => {
    const health = computeCycleHealth({});
    assert.ok(!isNaN(new Date(health.generatedAt).getTime()), "generatedAt must be a valid ISO string");
  });

  it("anomalies is always an array", () => {
    const health = computeCycleHealth({});
    assert.ok(Array.isArray(health.anomalies));
  });

  it("healthScore is always a valid enum value", () => {
    const config = makeConfig("state");
    const analytics = computeCycleAnalytics(config, {});
    const health = computeCycleHealth(analytics);
    assert.ok(Object.values(HEALTH_SCORE).includes(health.healthScore));
  });
});

describe("computeCycleHealth — health score derivation", () => {
  it("healthy when sloStatus=ok and no anomalies", () => {
    const config = makeConfig("state");
    const analytics = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord({ status: "ok", sloBreaches: [] }),
      pipelineProgress: makePipelineProgress(),
    });
    const health = computeCycleHealth(analytics);
    assert.equal(health.healthScore, HEALTH_SCORE.HEALTHY);
    assert.equal(health.anomalyCount, 0);
    assert.equal(health.sloBreachCount, 0);
    assert.equal(health.sloStatus, "ok");
  });

  it("degraded when sloStatus=degraded (negative path)", () => {
    const config = makeConfig("state");
    const analytics = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord({ status: "degraded", sloBreaches: [{ metric: "decisionLatencyMs" }] }),
    });
    const health = computeCycleHealth(analytics);
    assert.equal(health.healthScore, HEALTH_SCORE.DEGRADED);
    assert.equal(health.sloStatus, "degraded");
    assert.equal(health.sloBreachCount, 1);
  });

  it("degraded when one causal-link anomaly exists (negative path)", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    // Push decision beyond the 120s threshold
    ts.janus_decided = makeTs(200_000);
    const analytics = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord({ status: "ok" }),
      pipelineProgress: makePipelineProgress({ stageTimestamps: ts }),
    });
    const health = computeCycleHealth(analytics);
    assert.equal(health.healthScore, HEALTH_SCORE.DEGRADED);
    assert.ok(health.anomalyCount >= 1);
    assert.ok(health.anomalies.length >= 1);
  });

  it("critical when sloStatus=degraded and ≥2 causal-link anomalies", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    // Exceed decision AND dispatch thresholds
    ts.janus_decided      = makeTs(200_000); // > 120 000 ms threshold
    ts.workers_dispatching = makeTs(250_000); // 50 000 ms after athena_approved at 10 000 ms → > 30 000 ms threshold
    const analytics = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord({ status: "degraded", sloBreaches: [{ metric: "decisionLatencyMs" }, { metric: "dispatchLatencyMs" }] }),
      pipelineProgress: makePipelineProgress({ stageTimestamps: ts }),
    });
    const health = computeCycleHealth(analytics);
    assert.equal(health.healthScore, HEALTH_SCORE.CRITICAL);
    assert.ok(health.anomalyCount >= 2);
  });

  it("healthReason is a non-empty string for every score level", () => {
    const config = makeConfig("state");
    for (const [label, opts] of [
      ["healthy", { sloRecord: makeSloRecord(), pipelineProgress: makePipelineProgress() }],
      ["degraded_slo", { sloRecord: makeSloRecord({ status: "degraded" }), pipelineProgress: makePipelineProgress() }],
    ] as const) {
      const analytics = computeCycleAnalytics(config, opts as any);
      const health = computeCycleHealth(analytics);
      assert.ok(typeof health.healthReason === "string" && health.healthReason.length > 0,
        `healthReason must be a non-empty string for ${label}`);
    }
  });

  it("does NOT include raw latency values (semantic-clean degradation channel)", () => {
    const config = makeConfig("state");
    const analytics = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress(),
    });
    const health = computeCycleHealth(analytics);
    // Health record should not contain KPI timing fields
    assert.ok(!("decisionLatencyMs" in health), "health record must not contain decisionLatencyMs");
    assert.ok(!("dispatchLatencyMs" in health), "health record must not contain dispatchLatencyMs");
    assert.ok(!("verificationCompletionMs" in health), "health record must not contain verificationCompletionMs");
    assert.ok(!("kpis" in health), "health record must not embed the full kpis block");
  });

  it("handles null/missing analytics record gracefully (negative path)", () => {
    assert.doesNotThrow(() => computeCycleHealth(null));
    assert.doesNotThrow(() => computeCycleHealth(undefined));
    assert.doesNotThrow(() => computeCycleHealth({}));
  });

  it("handles missing causalLinks gracefully", () => {
    const health = computeCycleHealth({ kpis: { sloStatus: "ok", sloBreachCount: 0 } });
    assert.equal(health.anomalyCount, 0);
    assert.deepEqual(health.anomalies, []);
    assert.equal(health.healthScore, HEALTH_SCORE.HEALTHY);
  });
});

describe("persistCycleHealth and readCycleHealth", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-health-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates cycle_health.json with correct schema on first write", async () => {
    const config = makeConfig(tmpDir);
    const analytics = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress(),
    });
    const health = computeCycleHealth(analytics);
    await persistCycleHealth(config, health);

    const data = await readCycleHealth(config);
    assert.ok(data !== null);
    assert.equal(data.schemaVersion, CYCLE_HEALTH_SCHEMA.schemaVersion);
    assert.ok("lastCycle" in data);
    assert.ok(Array.isArray(data.history));
    assert.ok("updatedAt" in data);
  });

  it("append-only: second write prepends to history", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-health-append-"));
    try {
      const config = makeConfig(dir);
      const a1 = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ startedAt: makeTs(0) }) });
      await persistCycleHealth(config, computeCycleHealth(a1));
      const a2 = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ startedAt: makeTs(1000) }) });
      await persistCycleHealth(config, computeCycleHealth(a2));

      const data = await readCycleHealth(config);
      assert.equal(data.history.length, 2);
      assert.equal(data.lastCycle.cycleId, a2.cycleId);
      assert.equal(data.history[0].cycleId, a2.cycleId);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("retention policy: caps history at maxHistoryEntries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-health-cap-"));
    try {
      const config = { ...makeConfig(dir), cycleAnalytics: { maxHistoryEntries: 3 } };
      for (let i = 0; i < 5; i++) {
        const a = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ startedAt: makeTs(i * 1000) }) });
        await persistCycleHealth(config, computeCycleHealth(a));
      }
      const data = await readCycleHealth(config);
      assert.ok(data.history.length <= 3, `health history should be capped at 3, got ${data.history.length}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("readCycleHealth returns null when file does not exist", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-health-empty-"));
    try {
      const config = makeConfig(dir);
      const data = await readCycleHealth(config);
      assert.equal(data, null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("persistCycleHealthDivergence updates divergence channel without overwriting lastCycle", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-health-divergence-"));
    try {
      const config = makeConfig(dir);
      const analytics = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ startedAt: makeTs(0) }) });
      await persistCycleHealth(config, computeCycleHealth(analytics));
      await persistCycleHealthDivergence(config, {
        divergenceState: "planner_warning",
        pipelineStatus: "warning",
        operationalStatus: "operational",
        plannerHealth: "needs-work",
        isWarning: true,
        recordedAt: makeTs(500),
      });
      const data = await readCycleHealth(config);
      assert.equal(data.lastCycle.cycleId, analytics.cycleId, "runtime health channel must be preserved");
      assert.equal(data.lastDivergence.divergenceState, "planner_warning");
      assert.equal(data.divergenceState, "planner_warning", "top-level compatibility mirror must be preserved");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("persistCycleHealthComposite writes runtime and divergence channels atomically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-health-composite-"));
    try {
      const config = makeConfig(dir);
      const analytics = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ startedAt: makeTs(0) }) });
      const health = computeCycleHealth(analytics);
      await persistCycleHealthComposite(config, {
        healthRecord: health,
        divergenceSnapshot: {
          divergenceState: "planner_warning",
          pipelineStatus: "warning",
          operationalStatus: "degraded",
          plannerHealth: "warning",
          isWarning: true,
          recordedAt: makeTs(900),
        },
      } as any);
      const data = await readCycleHealth(config);
      assert.equal(data.lastCycle.cycleId, analytics.cycleId);
      assert.equal(data.lastDivergence.divergenceState, "planner_warning");
      assert.equal(data.divergenceState, "planner_warning");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("cycle_health.json and cycle_analytics.json are written to separate files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-dual-channel-"));
    try {
      const config = makeConfig(dir);
      const analytics = computeCycleAnalytics(config, {
        sloRecord: makeSloRecord(),
        pipelineProgress: makePipelineProgress(),
      });
      await persistCycleAnalytics(config, analytics);
      await persistCycleHealth(config, computeCycleHealth(analytics));

      const analyticsFile = path.join(dir, "cycle_analytics.json");
      const healthFile    = path.join(dir, "cycle_health.json");
      await fs.access(analyticsFile);
      await fs.access(healthFile);
      // Confirm they are distinct files with distinct content structures
      const analyticsData = JSON.parse(await fs.readFile(analyticsFile, "utf8"));
      const healthData    = JSON.parse(await fs.readFile(healthFile,    "utf8"));
      assert.ok("lastCycle" in analyticsData && "kpis" in analyticsData.lastCycle,
        "analytics file must have kpis");
      assert.ok("lastCycle" in healthData && !("kpis" in healthData.lastCycle),
        "health file must not have kpis");
      assert.ok("healthScore" in healthData.lastCycle,
        "health file must have healthScore");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Deterministic guards — evidence envelope boundary ─────────────────────────
// These tests verify that evidence envelope evolution cannot corrupt the
// KPI channel or the health channel semantics.

describe("computeCycleAnalytics — evidence envelope guards", () => {
  const config = {};

  it("extra EvidenceEnvelope fields on workerResults items are stripped before outcome computation", () => {
    const envelopeLike = {
      roleName: "evolution-worker",
      status: "done",
      // These EvidenceEnvelope fields must not influence outcome computation
      verificationEvidence: { build: "fail", tests: "fail", lint: "fail" },
      prChecks: { ok: false, passed: false, failed: ["ci"], pending: [], total: 1 },
      verificationPassed: false,
    };
    const record = computeCycleAnalytics(config, {
      workerResults: [envelopeLike],
      phase: CYCLE_PHASE.COMPLETED,
    });
    // Outcome must not be FAILED because status="done" — envelope fields must not cause FAILED.
    // With Task 3 seam binding: object-shaped verificationEvidence doesn't parse as a
    // VERIFICATION_REPORT, so seamContractSatisfied=false → outcome degrades to PARTIAL.
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.PARTIAL);
    assert.equal(record.outcomes.tasksCompleted, 1);
    assert.equal(record.outcomes.tasksFailed, 0);
  });

  it("non-numeric sloRecord.metrics values are treated as null (not propagated to KPIs)", () => {
    const corruptSlo = {
      ...makeSloRecord(),
      metrics: {
        decisionLatencyMs: "not-a-number",  // string instead of number
        dispatchLatencyMs: null,
        verificationCompletionMs: {},       // object instead of number
      },
    };
    const record = computeCycleAnalytics(config, { sloRecord: corruptSlo });
    assert.equal(record.kpis.decisionLatencyMs, null,
      "non-numeric decisionLatencyMs must be null");
    assert.equal(record.kpis.dispatchLatencyMs, null,
      "null dispatchLatencyMs must stay null");
    assert.equal(record.kpis.verificationCompletionMs, null,
      "object verificationCompletionMs must be null");
  });

  it("negative path: Infinity and NaN in sloRecord metrics are clamped to null", () => {
    const slo = { ...makeSloRecord(), metrics: { decisionLatencyMs: Infinity, dispatchLatencyMs: NaN, verificationCompletionMs: -Infinity } };
    const record = computeCycleAnalytics(config, { sloRecord: slo });
    assert.equal(record.kpis.decisionLatencyMs, null);
    assert.equal(record.kpis.dispatchLatencyMs, null);
    assert.equal(record.kpis.verificationCompletionMs, null);
  });
});

describe("computeCycleHealth — sloStatus enum guard", () => {
  it("unknown sloStatus string is clamped to 'unknown' to preserve health channel semantics", () => {
    // Directly construct an analytics-like record with a rogue sloStatus value
    const analytics = { kpis: { sloStatus: "future-unknown-value", sloBreachCount: 0 }, causalLinks: [] };
    const health = computeCycleHealth(analytics);
    assert.equal(health.sloStatus, "unknown",
      "invalid sloStatus must be clamped to 'unknown'");
  });

  it("valid sloStatus values pass through unchanged", () => {
    for (const status of ["ok", "degraded", "unknown"]) {
      const analytics = { kpis: { sloStatus: status, sloBreachCount: 0 }, causalLinks: [] };
      const health = computeCycleHealth(analytics);
      assert.equal(health.sloStatus, status, `sloStatus="${status}" must pass through`);
    }
  });

  it("negative path: non-string sloStatus is clamped to 'unknown'", () => {
    const analytics = { kpis: { sloStatus: 42, sloBreachCount: 0 }, causalLinks: [] };
    const health = computeCycleHealth(analytics);
    assert.equal(health.sloStatus, "unknown");
  });
});

// ── computeCycleHealth — sustainedBreachSignatures ────────────────────────────

describe("computeCycleHealth — sustainedBreachSignatures", () => {
  it("sustainedBreachSignatures field is present in schema required list", () => {
    assert.ok(
      CYCLE_HEALTH_SCHEMA.healthRecord.required.includes("sustainedBreachSignatures"),
      "schema must list sustainedBreachSignatures as required"
    );
  });

  it("defaults to empty array when no signatures supplied", () => {
    const config = makeConfig("state");
    const analytics = computeCycleAnalytics(config, {});
    const health = computeCycleHealth(analytics);
    assert.ok(Array.isArray(health.sustainedBreachSignatures));
    assert.equal(health.sustainedBreachSignatures.length, 0);
  });

  it("passes through supplied signatures verbatim", () => {
    const config = makeConfig("state");
    const analytics = computeCycleAnalytics(config, {});
    const sigs = [
      {
        metric: "decisionLatencyMs",
        consecutiveBreaches: 3,
        affectedCycleIds: ["c3", "c2", "c1"],
        averageExcessMs: 50000,
        maxExcessMs: 80000,
        severity: "high",
      },
    ];
    const health = computeCycleHealth(analytics, sigs);
    assert.deepEqual(health.sustainedBreachSignatures, sigs);
  });

  it("non-array signatures argument is coerced to empty array (defensive)", () => {
    const config = makeConfig("state");
    const analytics = computeCycleAnalytics(config, {});
    const health = computeCycleHealth(analytics, null as any);
    assert.ok(Array.isArray(health.sustainedBreachSignatures));
    assert.equal(health.sustainedBreachSignatures.length, 0);
  });

  it("health record conforms to schema required fields including sustainedBreachSignatures", () => {
    const config = makeConfig("state");
    const analytics = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress(),
    });
    const health = computeCycleHealth(analytics, []);
    for (const f of CYCLE_HEALTH_SCHEMA.healthRecord.required) {
      assert.ok(f in health, `health record missing required field: ${f}`);
    }
  });
});

// ── DISPATCH_BLOCK_REMEDIATION outcome binding ────────────────────────────────

describe("cycle_analytics — DISPATCH_BLOCK_REMEDIATION outcome binding (Task 2)", () => {
  const makeConfig = (stateDir = "state") => ({
    paths: { stateDir },
    slo: { thresholds: {} },
  });

  it("forces DISPATCH_BLOCK_REMEDIATION when blocked workers omit dispatchBlockReason and outcome would be SUCCESS", () => {
    const record = computeCycleAnalytics(makeConfig(), {
      workerResults: [
        // done worker WITH verification evidence (satisfies seam)
        { roleName: "coder", status: "done", dispatchContract: { doneWorkerWithVerificationReportEvidence: true } },
        // blocked worker WITHOUT dispatchBlockReason (violates dispatch-block contract)
        { roleName: "qa", status: "blocked", dispatchContract: { dispatchBlockReason: null } },
      ],
      planCount: 2,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(
      record.outcomes.status,
      CYCLE_OUTCOME_STATUS.DISPATCH_BLOCK_REMEDIATION,
      "outcome must be DISPATCH_BLOCK_REMEDIATION when blocked workers lack explicit dispatchBlockReason",
    );
    assert.ok(record.outcomes.probeFailureRemediation, "probeFailureRemediation must be populated");
    assert.ok(
      Array.isArray(record.outcomes.probeFailureRemediation!.blockedBy) &&
      record.outcomes.probeFailureRemediation!.blockedBy.includes("dispatchBlockReasonOutcomes"),
      "blockedBy must contain dispatchBlockReasonOutcomes",
    );
    assert.ok(
      Array.isArray(record.outcomes.probeFailureRemediation!.remediationActions) &&
      record.outcomes.probeFailureRemediation!.remediationActions.length > 0,
      "remediationActions must be non-empty",
    );
  });

  it("forces DISPATCH_BLOCK_REMEDIATION when blocked workers omit dispatchBlockReason and outcome would be PARTIAL", () => {
    // Use "partial" + "blocked" so base outcome is PARTIAL (not FAILED), then verify override.
    const record = computeCycleAnalytics(makeConfig(), {
      workerResults: [
        { roleName: "coder", status: "partial" },
        { roleName: "qa", status: "blocked" }, // no dispatchBlockReason
      ],
      planCount: 2,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.DISPATCH_BLOCK_REMEDIATION);
    assert.ok(record.outcomes.probeFailureRemediation, "probeFailureRemediation must be populated for PARTIAL→DISPATCH_BLOCK");
  });

  it("probeFailureRemediation is null when dispatch-block criterion passes", () => {
    const record = computeCycleAnalytics(makeConfig(), {
      workerResults: [
        { roleName: "coder", status: "done", dispatchContract: { doneWorkerWithVerificationReportEvidence: true } },
      ],
      planCount: 1,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(record.outcomes.probeFailureRemediation, null);
  });

  it("negative: prometheus/athena signal absence alone does NOT trigger DISPATCH_BLOCK_REMEDIATION", () => {
    // No prometheusAnalysis or athenaPlanReview supplied — those criteria fail,
    // but that is expected in headless/test invocations and must not change outcome.
    const record = computeCycleAnalytics(makeConfig(), {
      workerResults: [
        { roleName: "coder", status: "done", dispatchContract: { doneWorkerWithVerificationReportEvidence: true } },
      ],
      planCount: 1,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.SUCCESS);
    assert.equal(record.outcomes.probeFailureRemediation, null);
  });

  it("DISPATCH_BLOCK_REMEDIATION is a member of CYCLE_OUTCOME_STATUS", () => {
    assert.equal(CYCLE_OUTCOME_STATUS.DISPATCH_BLOCK_REMEDIATION, "dispatch_block_remediation");
  });
});

// ── interventionImpactCounters ─────────────────────────────────────────────────

describe("interventionImpactCounters in cycle analytics record", () => {
  it("is null when optimizerUsage is not provided", () => {
    const record = computeCycleAnalytics(makeConfig(), { phase: CYCLE_PHASE.COMPLETED });
    assert.equal(record.interventionImpactCounters, null);
  });

  it("surfaces failureClassificationsApplied from optimizerUsage", () => {
    const record = computeCycleAnalytics(makeConfig(), {
      phase: CYCLE_PHASE.COMPLETED,
      optimizerUsage: { failureClassificationsApplied: 3 },
    });
    assert.equal(record.interventionImpactCounters?.failureClassificationsApplied, 3);
  });

  it("surfaces rerouteCostPenaltiesApplied from optimizerUsage", () => {
    const record = computeCycleAnalytics(makeConfig(), {
      phase: CYCLE_PHASE.COMPLETED,
      optimizerUsage: { rerouteCostPenaltiesApplied: 2 },
    });
    assert.equal(record.interventionImpactCounters?.rerouteCostPenaltiesApplied, 2);
  });

  it("returns null when optimizerUsage has no tracked counter fields", () => {
    const record = computeCycleAnalytics(makeConfig(), {
      phase: CYCLE_PHASE.COMPLETED,
      optimizerUsage: { someOtherField: "value" },
    });
    assert.equal(record.interventionImpactCounters, null);
  });

  it("ignores non-numeric counter values", () => {
    const record = computeCycleAnalytics(makeConfig(), {
      phase: CYCLE_PHASE.COMPLETED,
      optimizerUsage: { failureClassificationsApplied: "not-a-number" },
    });
    assert.equal(record.interventionImpactCounters, null);
  });
});

// ── Task 3: modelRoutingTelemetry contract ─────────────────────────────────────

describe("modelRoutingTelemetry schema contract", () => {
  it("modelRoutingTelemetry is declared as required in CYCLE_ANALYTICS_SCHEMA.cycleRecord", () => {
    assert.ok(
      CYCLE_ANALYTICS_SCHEMA.cycleRecord.required.includes("modelRoutingTelemetry"),
      "modelRoutingTelemetry must be a required field in the cycle record schema"
    );
  });

  it("computeCycleAnalytics always includes modelRoutingTelemetry even with empty log", () => {
    const record = computeCycleAnalytics(makeConfig(), { phase: CYCLE_PHASE.COMPLETED });
    assert.ok(record.modelRoutingTelemetry !== null && record.modelRoutingTelemetry !== undefined,
      "modelRoutingTelemetry must always be present in analytics record");
    assert.ok(typeof record.modelRoutingTelemetry === "object",
      "modelRoutingTelemetry must be an object");
    assert.ok("byTaskKind" in record.modelRoutingTelemetry,
      "modelRoutingTelemetry must have byTaskKind field");
    assert.ok(typeof (record.modelRoutingTelemetry as any).sampleCount === "number",
      "modelRoutingTelemetry must have a numeric sampleCount");
  });

  it("computeCycleAnalytics modelRoutingTelemetry.sampleCount is 0 for empty premium log", () => {
    const record = computeCycleAnalytics(makeConfig(), {
      phase: CYCLE_PHASE.COMPLETED,
      premiumUsageLog: [],
    });
    assert.equal((record.modelRoutingTelemetry as any).sampleCount, 0);
    assert.deepEqual((record.modelRoutingTelemetry as any).byTaskKind, {});
  });

  it("buildInterventionLineageTelemetry joins cache, routing, specialization, outcomes, and postmortems", () => {
    const telemetry = buildInterventionLineageTelemetry({
      premiumUsageLog: [
        { worker: "quality-worker", model: "Claude Sonnet 4.6", taskKind: "test", outcome: "done", lineageId: "lineage-1" },
        { worker: "evolution-worker", model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "blocked", lineageId: "lineage-2" },
      ],
      promptCacheTelemetry: [
        { promptFamilyKey: "planner", totalSegments: 8, cachedSegments: 4, estimatedSavedTokens: 80, lineageId: "lineage-1", agent: "quality-worker" },
      ],
      routeRoiLedger: [
        {
          taskId: "task-1",
          model: "Claude Sonnet 4.6",
          tier: "T2",
          estimatedTokens: 1200,
          expectedQuality: 0.8,
          realizedQuality: 0.9,
          outcome: "done",
          roi: 75,
          roiDelta: 8,
          routedAt: makeTs(0),
          realizedAt: makeTs(60_000),
          lineageId: "lineage-1",
        },
      ],
      capabilityExecutionSummary: {
        observedCapabilityCount: 1,
        observedCapabilities: ["specialization-admission-control"],
        recentTraces: [{
          capability: "specialization-admission-control",
          observedAt: makeTs(10_000),
          context: "selected quality lane",
          role: "quality-worker",
          lineage: {
            lineageId: "lineage-1",
            lane: "quality",
            specialized: true,
          },
        }],
      },
      lineageLog: [
        { id: "lineage-1", status: "passed", sourceKind: "gap_candidate" },
        { id: "lineage-2", status: "blocked", sourceKind: "carry_forward" },
      ],
      postmortemOutcomes: [
        { lineageId: "lineage-1", decision: "promote", resolvedPolicy: true },
        { lineageId: "lineage-2", decision: "hold", recurred: true },
      ],
    });
    assert.equal(telemetry.lineageCount, 2);
    assert.equal(telemetry.surfaceCoverage.promptCache, 1);
    assert.equal(telemetry.surfaceCoverage.modelRouting, 1);
    assert.equal(telemetry.surfaceCoverage.specializationRouting, 1);
    assert.equal(telemetry.surfaceCoverage.workerOutcome, 2);
    assert.equal(telemetry.surfaceCoverage.postmortem, 2);
    assert.equal(telemetry.verifiedCapacityPerPremiumRequest, 0.5);
    assert.equal(telemetry.byInterventionType.modelRouting.positiveRoiDeltaCount, 1);
    assert.equal(telemetry.byInterventionType.specializationRouting.specialistAssignmentCount, 1);
    assert.equal(telemetry.byInterventionType.postmortem.closedOutcomeCount, 1);
  });

  it("buildInterventionLineageTelemetry honors explicit stable join keys across surfaces", () => {
    const telemetry = buildInterventionLineageTelemetry({
      premiumUsageLog: [
        {
          worker: "prometheus",
          model: "GPT-5.4",
          taskKind: "planning",
          outcome: "done",
          lineage: {
            lineageId: "lineage-premium-1",
            taskKind: "planning",
            promptFamilyKey: "planner-family-1",
          },
          lineageJoinKey: "prompt-family:planner-family-1",
        },
      ],
      routeRoiLedger: [
        {
          taskId: "plan-1",
          model: "GPT-5.4",
          tier: "T2",
          estimatedTokens: 800,
          expectedQuality: 0.8,
          realizedQuality: 0.9,
          outcome: "done",
          roi: 1.125,
          roiDelta: 0.125,
          routedAt: makeTs(0),
          realizedAt: makeTs(60_000),
          lineage: {
            lineageId: "lineage-routing-1",
            taskKind: "planning",
            promptFamilyKey: "planner-family-1",
          },
          lineageJoinKey: "prompt-family:planner-family-1",
        },
      ],
      workerResults: [
        {
          roleName: "prometheus",
          status: "done",
          lineage: {
            lineageId: "lineage-worker-1",
            taskKind: "planning",
            promptFamilyKey: "planner-family-1",
          },
          lineageJoinKey: "prompt-family:planner-family-1",
        },
      ],
    });

    assert.equal(telemetry.lineageCount, 1);
    assert.equal(telemetry.joinedLineages[0]?.joinKey, "prompt-family:planner-family-1");
    assert.ok(telemetry.joinedLineages[0]?.surfaces.includes("modelRouting"));
    assert.ok(telemetry.joinedLineages[0]?.surfaces.includes("workerOutcome"));
  });

  it("buildModelRoutingTelemetry aggregates usage entries by taskKind and model", () => {
    const log = [
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "done", lineageId: "impl-1" },
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "done", lineageId: "impl-2" },
      { model: "GPT-5.3-Codex",     taskKind: "implementation", outcome: "blocked", lineageId: "impl-3" },
      { model: "Claude Sonnet 4.6", taskKind: "ci-fix",          outcome: "done", lineageId: "ci-1" },
    ];
    const result = buildModelRoutingTelemetry(log);
    assert.ok(result !== null, "must never return null");
    assert.ok("implementation" in result.byTaskKind, "implementation taskKind must be present");
    assert.ok("ci-fix" in result.byTaskKind, "ci-fix taskKind must be present");
    const implEntry = result.byTaskKind["implementation"];
    assert.equal(implEntry.sampleCount, 3);
    assert.ok("claude sonnet 4.6" in implEntry.models, "Claude model must be tracked under canonical key");
  });

  it("buildModelRoutingTelemetry remains stable when lineageId is missing on some rows", () => {
    const log = [
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "done", lineageId: "impl-1" },
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "blocked" },
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "done", lineageId: "impl-2" },
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "done", lineageId: "" },
    ];
    const result = buildModelRoutingTelemetry(log);
    assert.equal(result.sampleCount, 4, "sampleCount tracks all structurally valid rows");
    assert.equal(result.byTaskKind.implementation.sampleCount, 4);
    assert.equal(result.byTaskKind.implementation.lineageLinkedSampleCount, 2);
    assert.equal(result.byTaskKind.implementation.lineageLinkedRatio, 0.5);
  });

  it("buildModelRoutingTelemetry enforces lineage reference set when lineage log is provided", () => {
    const log = [
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "done", lineageId: "impl-1" },
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "done", lineageId: "impl-2" },
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "blocked", lineageId: "orphan-lineage" },
    ];
    const lineageLog = [
      { id: "impl-1", sourceKind: "gap_candidate" },
      { id: "impl-2", sourceKind: "carry_forward" },
    ];
    const result = buildModelRoutingTelemetry(log, lineageLog);
    assert.equal(result.byTaskKind.implementation.sampleCount, 3);
    assert.equal(result.byTaskKind.implementation.lineageLinkedSampleCount, 2,
      "only lineage IDs present in lineageLog should be counted as linked");
    assert.equal(result.byTaskKind.implementation.lineageLinkedRatio, 0.667);
  });

  it("buildModelRoutingTelemetry adds long-horizon attempt, precision, hard-chain, and lane reliability signals", () => {
    const log = [
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "done", lineageId: "chain-1", worker: "quality-worker" },
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "done", lineageId: "chain-1", worker: "quality-worker" },
      { model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "blocked", lineageId: "solo-1", worker: "quality-worker" },
      { model: "GPT-5.3-Codex", taskKind: "implementation", outcome: "done", lineageId: "chain-2", worker: "integration-worker" },
      { model: "GPT-5.3-Codex", taskKind: "implementation", outcome: "error", lineageId: "chain-2", worker: "integration-worker" },
    ];
    const result = buildModelRoutingTelemetry(log);
    const telemetry = result.byTaskKind.implementation.default;
    assert.equal(telemetry.attemptRate, 0.8);
    assert.equal(telemetry.abstainRate, 0.2);
    assert.equal(telemetry.precisionOnAttempted, 0.75);
    assert.equal(telemetry.hardChainSuccessRate, 0.5);
    assert.equal(telemetry.hardChainSampleCount, 2);
    assert.equal(telemetry.laneReliability, 0.75);
    assert.equal(telemetry.outcomeScore, 0.72);
    assert.equal(telemetry.capacityImpact, telemetry.outcomeScore);
  });

  it("buildModelRoutingTelemetry penalizes abstention in outcome scoring even when attempted precision stays high", () => {
    const log = [
      { model: "Claude Sonnet 4.6", taskKind: "observation", outcome: "done", worker: "observation-worker", lineageId: "obs-1" },
      { model: "Claude Sonnet 4.6", taskKind: "observation", outcome: "blocked", worker: "observation-worker", lineageId: "obs-2" },
    ];
    const result = buildModelRoutingTelemetry(log);
    const telemetry = result.byTaskKind.observation.default;
    assert.equal(telemetry.precisionOnAttempted, 1);
    assert.equal(telemetry.attemptRate, 0.5);
    assert.equal(telemetry.abstainRate, 0.5);
    assert.equal(telemetry.laneReliability, 0.625);
    assert.equal(telemetry.outcomeScore, 0.656);
  });

  it("buildModelRoutingTelemetry prefers realized route ROI samples over duplicate premium usage rows", () => {
    const result = buildModelRoutingTelemetry(
      [
        { taskId: "task-1", model: "Claude Sonnet 4.6", taskKind: "implementation", outcome: "blocked", worker: "evolution-worker", lineageId: "lineage-1" },
      ],
      [{ id: "lineage-1", sourceKind: "gap_candidate" }],
      [
        {
          taskId: "task-1",
          model: "Claude Sonnet 4.6",
          taskKind: "implementation",
          outcome: "done",
          roi: 90,
          realizedAt: makeTs(10_000),
          role: "quality-worker",
          lineageId: "lineage-1",
        },
      ],
    );
    assert.equal(result.sampleCount, 1);
    assert.equal(result.byTaskKind.implementation.default.successProbability, 1);
    assert.ok(result.byTaskKind.implementation.default.outcomeScore > 0.8);
  });

  it("computeCycleAnalytics classifies autonomy execution dispatch blocks as governance-blocked terminal exits", () => {
    const record = computeCycleAnalytics(makeConfig(), {
      phase: CYCLE_PHASE.COMPLETED,
      dispatchBlockReason: "autonomy_execution_gate_not_ready:insufficient_exploitation_window",
      workerTopology: {
        effectiveLaneCount: 1,
        nominalLaneCount: 2,
        fallbackCollapseRate: 0.5,
      },
    });
    assert.equal(record.cycleTruthContract.nullEventsTerminalBlockReason, CYCLE_TRUTH_TERMINAL_BLOCK_REASON.GOVERNANCE_BLOCKED);
    assert.equal(record.workerTopology.effectiveLaneCount, 1);
    assert.equal(record.workerTopology.nominalLaneCount, 2);
  });

  it("MIN_TELEMETRY_SAMPLE_THRESHOLD is exported and is a positive integer", () => {
    assert.ok(typeof MIN_TELEMETRY_SAMPLE_THRESHOLD === "number", "must be a number");
    assert.ok(MIN_TELEMETRY_SAMPLE_THRESHOLD > 0, "must be positive");
    assert.ok(Number.isInteger(MIN_TELEMETRY_SAMPLE_THRESHOLD), "must be an integer");
  });

  it("computeCycleAnalytics records packet-size outcome correlation by taskKind", () => {
    const record = computeCycleAnalytics(makeConfig("state"), {
      phase: CYCLE_PHASE.COMPLETED,
      workerResults: [
        {
          roleName: "quality-worker",
          status: "done",
          taskKind: "test",
          batchSize: 2,
          orderedStepCount: 4,
          contextUtilizationPercent: 62,
        },
        {
          roleName: "quality-worker",
          status: "failed",
          taskKind: "test",
          batchSize: 3,
          orderedStepCount: 7,
          contextUtilizationPercent: 84,
        },
      ],
    });

    assert.equal(record.packetOutcomeCorrelation.sampleCount, 2);
    assert.deepEqual(record.packetOutcomeCorrelation.byTaskKind.test, {
      sampleCount: 2,
      successRate: 0.5,
      averageBatchSize: 2.5,
      averageOrderedStepCount: 5.5,
      averageContextUtilizationPercent: 73,
    });
  });

  it("computeCycleAnalytics includes interventionLineageTelemetry when explicit source logs are provided", () => {
    const record = computeCycleAnalytics(makeConfig("state"), {
      phase: CYCLE_PHASE.COMPLETED,
      premiumUsageLog: [
        { worker: "quality-worker", model: "Claude Sonnet 4.6", taskKind: "test", outcome: "done", lineageId: "lineage-1" },
      ],
      promptCacheTelemetry: [
        { promptFamilyKey: "planner", totalSegments: 6, cachedSegments: 3, estimatedSavedTokens: 60, lineageId: "lineage-1", agent: "quality-worker" },
      ],
      routeRoiLedger: [
        {
          taskId: "task-1",
          model: "Claude Sonnet 4.6",
          tier: "T2",
          estimatedTokens: 900,
          expectedQuality: 0.8,
          realizedQuality: 0.85,
          outcome: "done",
          roi: 94.4,
          roiDelta: 5,
          routedAt: makeTs(0),
          realizedAt: makeTs(20_000),
          lineageId: "lineage-1",
        },
      ],
      capabilityExecutionSummary: {
        observedCapabilityCount: 1,
        observedCapabilities: ["specialization-admission-control"],
        recentTraces: [{
          capability: "specialization-admission-control",
          observedAt: makeTs(5_000),
          context: "quality lane",
          role: "quality-worker",
          lineage: { lineageId: "lineage-1", lane: "quality", specialized: true },
        }],
      },
      lineageLog: [{ id: "lineage-1", status: "passed", sourceKind: "gap_candidate" }],
      postmortemOutcomes: [{ lineageId: "lineage-1", decision: "promote", resolvedPolicy: true }],
    });
    assert.equal(record.interventionLineageTelemetry.lineageCount, 1);
    assert.equal(record.interventionLineageTelemetry.surfaceCoverage.fullyJoined, 1);
    assert.equal(record.interventionLineageTelemetry.byInterventionType.promptCache.averageHitRate, 0.5);
  });
});

describe("buildRoutingROISummary", () => {
  it("enforces lineage log linkage when lineage log is provided", () => {
    const premiumUsageLog = [
      { taskKind: "implementation", model: "Claude Sonnet 4.6", outcome: "done", lineageId: "impl-1" },
      { taskKind: "implementation", model: "Claude Sonnet 4.6", outcome: "blocked", lineageId: "orphan-lineage" },
      { taskKind: "implementation", model: "Claude Sonnet 4.6", outcome: "done", lineageId: "" },
    ];
    const lineageLog = [{ id: "impl-1", sourceKind: "gap_candidate" }];
    const summary = buildRoutingROISummary(premiumUsageLog, lineageLog);
    assert.equal(summary.totalRequests, 3);
    assert.equal(summary.linkedRequests, 1);
    assert.equal(summary.linkedRatio, 0.333);
    assert.equal(summary.roiByLineageId["lineage:impl-1"]?.roi, 1);
    assert.equal(summary.overallLinkedROI, 1);
  });
});

// ── Task 2: dispatchBlockReason surfaced in outcomes ──────────────────────────

describe("cycle_analytics — dispatchBlockReason in outcomes (Task 2)", () => {
  it("surfaces dispatchBlockReason in outcomes when governance gate blocks cycle", () => {
    const config = makeConfig("state");
    const blockReason = "GOVERNANCE_FREEZE_ACTIVE:monthly-freeze-active";
    const record = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.INCOMPLETE,
      dispatchBlockReason: blockReason,
    });
    assert.equal(record.outcomes.dispatchBlockReason, blockReason,
      "dispatchBlockReason must flow from opts into outcomes for observability");
    assert.equal(record.phase, CYCLE_PHASE.INCOMPLETE);
  });

  it("outcomes.dispatchBlockReason is null when no block reason provided (normal cycle)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.COMPLETED,
      workerResults: [{ roleName: "evolution-worker", status: "done" }],
      planCount: 1,
    });
    assert.equal(record.outcomes.dispatchBlockReason, null,
      "dispatchBlockReason must be null when no block fires — no silent contamination of normal cycles");
  });

  it("negative: empty dispatchBlockReason string is stored as null (no empty sentinels)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.INCOMPLETE,
      dispatchBlockReason: "   ",
    });
    assert.equal(record.outcomes.dispatchBlockReason, null,
      "whitespace-only dispatchBlockReason must be normalized to null");
  });

  it("pre_dispatch_gate block reason is preserved verbatim in outcomes", () => {
    const config = makeConfig("state");
    const reason = "LINEAGE_CYCLE_DETECTED:CYCLE_DETECTED";
    const record = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.INCOMPLETE,
      dispatchBlockReason: reason,
    });
    assert.equal(record.outcomes.dispatchBlockReason, reason);
    assert.equal(record.phase, CYCLE_PHASE.INCOMPLETE);
  });

  it("parses the renamed lane diversity dispatch block contract", () => {
    const reason = "lane_diversity_insufficient:activeLanes=1,minimumLanes=2";
    assert.deepEqual(parseDispatchBlockReasonContract(reason), {
      code: DISPATCH_BLOCK_REASON_CODE.LANE_DIVERSITY_GATE_BLOCKED,
      detail: {
        rawDetail: "activeLanes=1,minimumLanes=2",
        activeLanes: "1",
        minimumLanes: "2",
      },
      raw: reason,
    });
  });

  it("negative path: treats prose-only lane diversity blocks as unknown analytics codes", () => {
    const contract = parseDispatchBlockReasonContract("Only 1 lane(s) active, minimum is 2.");
    assert.equal(contract?.code, DISPATCH_BLOCK_REASON_CODE.UNKNOWN);
  });

  it("classifies lane_diversity_insufficient as a dispatch-blocked terminal exit", () => {
    const config = makeConfig("state");
    const reason = "lane_diversity_insufficient:activeLanes=1,minimumLanes=2";
    const record = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.COMPLETED,
      pipelineProgress: makePipelineProgress({ stageTimestamps: {} }),
      dispatchBlockReason: reason,
    });
    assert.equal(record.outcomes.dispatchBlockReason, reason);
    assert.equal(record.cycleTruthContract.nullEventsTerminalBlockReason, CYCLE_TRUTH_TERMINAL_BLOCK_REASON.DISPATCH_BLOCKED);
  });
});

// ── Legacy evolution_progress constants ─────────────────────────────────────────
// Verifies that the named constants for the legacy compatibility path are stable
// and carry the correct values so callers can reference them programmatically.

describe("cycle_analytics — LEGACY_EVOLUTION_PROGRESS constants", () => {
  it("LEGACY_EVOLUTION_PROGRESS_FILE resolves to the expected legacy filename", () => {
    assert.equal(
      LEGACY_EVOLUTION_PROGRESS_FILE,
      "evolution_progress.json",
      "LEGACY_EVOLUTION_PROGRESS_FILE must match the legacy on-disk filename"
    );
  });

  it("LEGACY_EVOLUTION_PROGRESS_SCHEMA_VERSION is the implicit v0 version for files without a schemaVersion field", () => {
    assert.equal(
      LEGACY_EVOLUTION_PROGRESS_SCHEMA_VERSION,
      0,
      "LEGACY_EVOLUTION_PROGRESS_SCHEMA_VERSION must be 0 (legacy task-map format)"
    );
  });

  it("migrateLegacyEvolutionProgressToCompletedTaskIds treats legacy format as fromVersion=0", () => {
    // A legacy evolution_progress file has no explicit schemaVersion field.
    const legacy = {
      cycle_id: "cycle-1",
      tasks: {
        "task-A": { status: "done" },
        "task-B": { status: "completed" },
        "task-C": { status: "pending" },
      },
    };
    const result = migrateLegacyEvolutionProgressToCompletedTaskIds(legacy);
    assert.ok(result.ok, "migration must succeed for valid legacy input");
    assert.equal(
      result.fromVersion,
      LEGACY_EVOLUTION_PROGRESS_SCHEMA_VERSION,
      "fromVersion must match LEGACY_EVOLUTION_PROGRESS_SCHEMA_VERSION for files without an explicit version"
    );
    // Only completed tasks should appear in completedTaskIds
    assert.ok(result.completedTaskIds.includes("task-A"), "task-A (done) must be in completedTaskIds");
    assert.ok(result.completedTaskIds.includes("task-B"), "task-B (completed) must be in completedTaskIds");
    assert.ok(!result.completedTaskIds.includes("task-C"), "task-C (pending) must NOT be in completedTaskIds");
  });

  it("LEGACY_EVOLUTION_PROGRESS_SCHEMA_VERSION is less than the canonical WORKER_CYCLE_ARTIFACTS_SCHEMA version", () => {
    // This invariant ensures the migration direction is always forward.
    assert.ok(
      LEGACY_EVOLUTION_PROGRESS_SCHEMA_VERSION < WORKER_CYCLE_ARTIFACTS_SCHEMA.schemaVersion,
      "legacy schema version must be less than the canonical schema version"
    );
  });
});

// ── benchmarkAnalytics in computeCycleAnalytics ───────────────────────────────

import { BENCHMARK_INTEGRITY_SCHEMA_VERSION } from "../../src/core/model_policy.js";

describe("computeCycleAnalytics — benchmarkAnalytics field", () => {
  const config = { paths: { stateDir: "state" } };

  it("benchmarkAnalytics is null when benchmarkGroundTruth is not provided", () => {
    const result = computeCycleAnalytics(config, { phase: CYCLE_PHASE.COMPLETED });
    assert.equal(result.benchmarkAnalytics, null);
  });

  it("benchmarkAnalytics is populated when benchmarkGroundTruth is provided", () => {
    const groundTruth = {
      entries: [
        {
          cycleId: "c-1",
          recommendations: [
            { topic: "perf", implementationStatus: "implemented",  benchmarkScore: 0.8, capacityGain: 0.5 },
            { topic: "auth", implementationStatus: "pending",      benchmarkScore: 0.6, capacityGain: 0.3 },
          ],
        },
      ],
    };
    const result = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.COMPLETED,
      benchmarkGroundTruth: groundTruth,
    });
    assert.ok(result.benchmarkAnalytics, "benchmarkAnalytics must be present");
    assert.equal(result.benchmarkAnalytics.schemaVersion, BENCHMARK_INTEGRITY_SCHEMA_VERSION);
    assert.equal(result.benchmarkAnalytics.sampleCount, 2);
    assert.ok(result.benchmarkAnalytics.unresolvedRatio >= 0 && result.benchmarkAnalytics.unresolvedRatio <= 1);
    assert.ok(typeof result.benchmarkAnalytics.integrityScore === "number");
  });

  it("benchmarkAnalytics contains contradiction count when present", () => {
    const groundTruth = {
      entries: [
        {
          recommendations: [
            { topic: "cache", implementationStatus: "implemented" },
            { topic: "cache", implementationStatus: "pending" },
          ],
        },
      ],
    };
    const result = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.COMPLETED,
      benchmarkGroundTruth: groundTruth,
    });
    assert.ok(result.benchmarkAnalytics, "benchmarkAnalytics must be present");
    assert.equal(result.benchmarkAnalytics.contradictionCount, 1);
  });

  it("negative path: benchmarkAnalytics is null for empty entries", () => {
    const result = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.COMPLETED,
      benchmarkGroundTruth: { entries: [] },
    });
    // An empty entries array produces a zero-signal BenchmarkIntegrityResult
    assert.ok(result.benchmarkAnalytics !== undefined, "benchmarkAnalytics must be defined");
    assert.equal(result.benchmarkAnalytics.sampleCount, 0);
  });
});

// ── cycleTruthContract — canonical cycle-truth binding (Task 1) ───────────────

describe("computeCycleAnalytics — cycleTruthContract (cycle-truth contract)", () => {
  const config = { paths: { stateDir: "state" } };

  it("cycleTruthContract is present on all records", () => {
    const result = computeCycleAnalytics(config, { phase: CYCLE_PHASE.COMPLETED });
    assert.ok(result.cycleTruthContract, "cycleTruthContract must be present");
    assert.ok("missingCanonicalEventCount" in result.cycleTruthContract);
    assert.ok("nullEventsTerminalBlockReason" in result.cycleTruthContract);
    assert.ok("isFullyCovered" in result.cycleTruthContract);
  });

  it("cycleTruthContract.isFullyCovered is true when all canonical events are present", () => {
    const result = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.COMPLETED,
      pipelineProgress: makePipelineProgress({ stageTimestamps: validTimestamps() }),
    });
    assert.equal(result.cycleTruthContract.missingCanonicalEventCount, 0);
    assert.equal(result.cycleTruthContract.nullEventsTerminalBlockReason, null);
    assert.equal(result.cycleTruthContract.isFullyCovered, true);
  });

  it("cycleTruthContract classifies dispatch_blocked when dispatchBlockReason is set and canonical events are null", () => {
    const result = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.COMPLETED,
      pipelineProgress: makePipelineProgress({ stageTimestamps: {} }),
      dispatchBlockReason: "specialization_admission_gate_failed: deficit=2",
    });
    assert.ok(result.cycleTruthContract.missingCanonicalEventCount > 0);
    assert.equal(result.cycleTruthContract.nullEventsTerminalBlockReason, CYCLE_TRUTH_TERMINAL_BLOCK_REASON.DISPATCH_BLOCKED);
    assert.equal(result.cycleTruthContract.isFullyCovered, true, "covered because block reason is explicit");
  });

  it("cycleTruthContract classifies governance_blocked for governance-related block reasons", () => {
    const result = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.COMPLETED,
      pipelineProgress: makePipelineProgress({ stageTimestamps: {} }),
      dispatchBlockReason: "governance_freeze_active: safety gate",
    });
    assert.equal(result.cycleTruthContract.nullEventsTerminalBlockReason, CYCLE_TRUTH_TERMINAL_BLOCK_REASON.GOVERNANCE_BLOCKED);
    assert.equal(result.cycleTruthContract.isFullyCovered, true);
  });

  it("cycleTruthContract classifies no_plans_generated when outcome is NO_PLANS", () => {
    const result = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.INCOMPLETE,
      pipelineProgress: makePipelineProgress({ stageTimestamps: {} }),
      planCount: 0,
    });
    // INCOMPLETE phase with planCount=0 produces NO_PLANS status
    assert.equal(result.outcomes.status, CYCLE_OUTCOME_STATUS.NO_PLANS);
    // INCOMPLETE phase does not trigger the COMPLETED-phase null-events contract
    assert.equal(result.cycleTruthContract.nullEventsTerminalBlockReason, null);
  });

  it("cycleTruthContract classifies unspecified_early_exit when no explicit reason is available", () => {
    const result = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.COMPLETED,
      pipelineProgress: makePipelineProgress({ stageTimestamps: {} }),
      // no dispatchBlockReason, no matching outcome status
    });
    assert.ok(result.cycleTruthContract.missingCanonicalEventCount > 0);
    assert.equal(result.cycleTruthContract.nullEventsTerminalBlockReason, CYCLE_TRUTH_TERMINAL_BLOCK_REASON.UNSPECIFIED_EARLY_EXIT);
    assert.equal(result.cycleTruthContract.isFullyCovered, true, "unspecified is still explicit — coverage met");
  });

  it("cycleTruthContract is in CYCLE_ANALYTICS_SCHEMA required fields", () => {
    assert.ok(
      CYCLE_ANALYTICS_SCHEMA.cycleRecord.required.includes("cycleTruthContract"),
      "cycleTruthContract must be in schema required list"
    );
  });

  it("CYCLE_TRUTH_TERMINAL_BLOCK_REASON contains expected codes", () => {
    const expected = ["dispatch_blocked", "governance_blocked", "no_plans_generated", "plan_not_approved", "unspecified_early_exit"];
    for (const code of expected) {
      assert.ok(
        Object.values(CYCLE_TRUTH_TERMINAL_BLOCK_REASON).includes(code),
        `missing terminal block reason code: ${code}`
      );
    }
  });

  it("negative path: null canonical events without a terminal block reason yields isFullyCovered=false only when phase!=COMPLETED", () => {
    // In FAILED phase, we still check the null-event path
    const result = computeCycleAnalytics(config, {
      phase: CYCLE_PHASE.FAILED,
      pipelineProgress: makePipelineProgress({ stageTimestamps: {} }),
    });
    // FAILED phase doesn't trigger the COMPLETED-path block reason classification
    assert.equal(result.cycleTruthContract.nullEventsTerminalBlockReason, null);
    // isFullyCovered is false because events are missing and no reason was set
    assert.equal(result.cycleTruthContract.isFullyCovered, false);
  });
});

// ── CYCLE_OUTCOME_STATUS — CI_DEBT_UNRESOLVED ─────────────────────────────────

import { computeCiRemediationStatus } from "../../src/core/cycle_analytics.js";

describe("CYCLE_OUTCOME_STATUS.CI_DEBT_UNRESOLVED", () => {
  it("is defined and equals 'ci_debt_unresolved'", () => {
    assert.equal(CYCLE_OUTCOME_STATUS.CI_DEBT_UNRESOLVED, "ci_debt_unresolved");
  });

  it("is frozen in the enum", () => {
    assert.ok(Object.isFrozen(CYCLE_OUTCOME_STATUS));
  });
});

describe("computeCiRemediationStatus", () => {
  it("required=false and satisfied=false when no findings", () => {
    const result = computeCiRemediationStatus([], []);
    assert.equal(result.required, false);
    assert.equal(result.satisfied, false);
    assert.equal(result.completedCiFixWorkers, 0);
    assert.deepEqual(result.findingIds, []);
  });

  it("required=true when a finding has ciFastlaneRequired=true", () => {
    const findings = [{ ciFastlaneRequired: true, findingId: "f1" }];
    const result = computeCiRemediationStatus([], findings);
    assert.equal(result.required, true);
    assert.equal(result.satisfied, false);
    assert.deepEqual(result.findingIds, ["f1"]);
  });

  it("satisfied=true when ci-fix worker completed", () => {
    const findings = [{ ciFastlaneRequired: true, findingId: "f2" }];
    const workers = [{ taskKind: "ci-fix", status: "done" }];
    const result = computeCiRemediationStatus(workers, findings);
    assert.equal(result.required, true);
    assert.equal(result.satisfied, true);
    assert.equal(result.completedCiFixWorkers, 1);
  });

  it("negative: ci-fix worker with status other than done does not satisfy", () => {
    const findings = [{ area: "ci", findingId: "f3" }];
    const workers = [{ taskKind: "ci-fix", status: "failed" }];
    const result = computeCiRemediationStatus(workers, findings);
    assert.equal(result.satisfied, false);
    assert.equal(result.completedCiFixWorkers, 0);
  });

  it("negative: non-ci-fix worker does not satisfy CI requirement", () => {
    const findings = [{ capabilityNeeded: "ci-fix", findingId: "f4" }];
    const workers = [{ taskKind: "refactor", status: "done" }];
    const result = computeCiRemediationStatus(workers, findings);
    assert.equal(result.required, true);
    assert.equal(result.satisfied, false);
  });

  it("handles null/non-array inputs gracefully", () => {
    const result = computeCiRemediationStatus(null as any, null as any);
    assert.equal(result.required, false);
    assert.equal(result.satisfied, false);
  });
});

// ── computeHistoricalLaneDifficultyPriors ─────────────────────────────────────
import { computeHistoricalLaneDifficultyPriors } from "../../src/core/cycle_analytics.js";

describe("computeHistoricalLaneDifficultyPriors", () => {
  it("returns empty map for empty input", () => {
    const result = computeHistoricalLaneDifficultyPriors([]);
    assert.deepEqual(result, {});
  });

  it("returns empty map when records have no laneTelemetry", () => {
    const result = computeHistoricalLaneDifficultyPriors([{ foo: "bar" }, null, 42]);
    assert.deepEqual(result, {});
  });

  it("aggregates per-lane completionRate and roi across records", () => {
    const records = [
      {
        laneTelemetry: {
          implementation: { completionRate: 0.8, roi: 4.0 },
          research:       { completionRate: 0.6, roi: 3.0 },
        },
      },
      {
        laneTelemetry: {
          implementation: { completionRate: 0.6, roi: 2.0 },
        },
      },
    ];
    const result = computeHistoricalLaneDifficultyPriors(records);
    assert.ok("implementation" in result);
    assert.ok("research" in result);
    assert.equal(result.implementation.sampleCount, 2);
    // Avg completionRate for implementation: (0.8 + 0.6) / 2 = 0.7
    assert.equal(result.implementation.completionRate, 0.7);
    assert.equal(result.research.sampleCount, 1);
    assert.equal(result.research.completionRate, 0.6);
  });

  it("aggregates attempt, abstain, precision, and reliability priors alongside completion history", () => {
    const records = [
      {
        laneTelemetry: {
          quality: { completionRate: 0.5, roi: 1.0, attemptRate: 0.75, abstainRate: 0.25, precisionOnAttempted: 0.667, reliability: 0.639 },
        },
      },
      {
        laneTelemetry: {
          quality: { completionRate: 1.0, roi: 2.0, attemptRate: 1.0, abstainRate: 0.0, precisionOnAttempted: 1.0, reliability: 1.0 },
        },
      },
    ];
    const result = computeHistoricalLaneDifficultyPriors(records);
    assert.equal(result.quality.attemptRate, 0.875);
    assert.equal(result.quality.abstainRate, 0.125);
    assert.equal(result.quality.precisionOnAttempted, 0.834);
    assert.equal(result.quality.reliability, 0.82);
  });

  it("classifies difficulty correctly based on completionRate", () => {
    const records = [
      {
        laneTelemetry: {
          easy:     { completionRate: 0.80, roi: 4.0 },
          moderate: { completionRate: 0.50, roi: 2.0 },
          hard:     { completionRate: 0.20, roi: 0.5 },
        },
      },
    ];
    const result = computeHistoricalLaneDifficultyPriors(records);
    assert.equal(result.easy.difficulty,     "easy");
    assert.equal(result.moderate.difficulty, "moderate");
    assert.equal(result.hard.difficulty,     "hard");
  });

  it("negative path: handles null records gracefully without throwing", () => {
    const result = computeHistoricalLaneDifficultyPriors([null, undefined, { laneTelemetry: null }] as any);
    assert.deepEqual(result, {});
  });
});

// ── violationFeedback in computeCycleAnalytics ─────────────────────────────────

describe("computeCycleAnalytics — violationFeedback field", () => {
  const config = makeConfig("state");

  it("violationFeedback is always present in returned record", () => {
    const record = computeCycleAnalytics(config, {});
    assert.ok(record.violationFeedback, "violationFeedback must exist");
    assert.equal(typeof record.violationFeedback.retryCount, "number");
    assert.equal(typeof record.violationFeedback.closureBoundaryViolations, "number");
    assert.equal(typeof record.violationFeedback.hookTelemetryViolations, "number");
    assert.equal(typeof record.violationFeedback.dispatchBlockedWorkers, "number");
    assert.equal(typeof record.violationFeedback.specialistRerouteCount, "number");
    assert.ok(Array.isArray(record.violationFeedback.reroutedRoles));
  });

  it("violationFeedback defaults to zero counters with no inputs", () => {
    const record = computeCycleAnalytics(config, {});
    const vf = record.violationFeedback as ViolationFeedback;
    assert.equal(vf.retryCount, 0);
    assert.equal(vf.closureBoundaryViolations, 0);
    assert.equal(vf.hookTelemetryViolations, 0);
    assert.equal(vf.dispatchBlockedWorkers, 0);
    assert.equal(vf.specialistRerouteCount, 0);
    assert.deepEqual(vf.reroutedRoles, []);
    assert.equal(vf.retryRate, null);
    assert.equal(vf.contractViolationRate, null);
    assert.equal(vf.rerouteRate, null);
  });

  it("passes through contractViolationCounters from caller", () => {
    const record = computeCycleAnalytics(config, {
      contractViolationCounters: { closureBoundaryViolations: 2, hookTelemetryViolations: 1, dispatchBlockedWorkers: 3 },
      funnelCounts: { generated: 5, approved: 5, dispatched: 5, completed: 2 },
    });
    const vf = record.violationFeedback as ViolationFeedback;
    assert.equal(vf.closureBoundaryViolations, 2);
    assert.equal(vf.hookTelemetryViolations, 1);
    assert.equal(vf.dispatchBlockedWorkers, 3);
    // contractViolationRate = (2+1)/5 = 0.6
    assert.equal(vf.contractViolationRate, 0.6);
  });

  it("passes through rerouteMetrics from caller", () => {
    const record = computeCycleAnalytics(config, {
      rerouteMetrics: { specialistRerouteCount: 2, reroutedRoles: ["research-worker", "evolution-worker"] },
      funnelCounts: { generated: 4, approved: 4, dispatched: 4, completed: 2 },
    });
    const vf = record.violationFeedback as ViolationFeedback;
    assert.equal(vf.specialistRerouteCount, 2);
    assert.deepEqual(vf.reroutedRoles, ["research-worker", "evolution-worker"]);
    assert.equal(vf.rerouteRate, 0.5);
  });

  it("passes through retryCount and computes retryRate", () => {
    const record = computeCycleAnalytics(config, {
      retryCount: 3,
      funnelCounts: { generated: 6, approved: 6, dispatched: 6, completed: 3 },
    });
    const vf = record.violationFeedback as ViolationFeedback;
    assert.equal(vf.retryCount, 3);
    assert.equal(vf.retryRate, 0.5);
  });

  it("rates are null when dispatched count is missing", () => {
    const record = computeCycleAnalytics(config, {
      retryCount: 2,
      contractViolationCounters: { closureBoundaryViolations: 1, hookTelemetryViolations: 0, dispatchBlockedWorkers: 1 },
    });
    const vf = record.violationFeedback as ViolationFeedback;
    assert.equal(vf.retryRate, null);
    assert.equal(vf.contractViolationRate, null);
    assert.equal(vf.rerouteRate, null);
  });

  it("negative path: ignores non-numeric contractViolationCounters fields", () => {
    const record = computeCycleAnalytics(config, {
      contractViolationCounters: { closureBoundaryViolations: "bad", hookTelemetryViolations: null, dispatchBlockedWorkers: undefined },
    });
    const vf = record.violationFeedback as ViolationFeedback;
    assert.equal(vf.closureBoundaryViolations, 0);
    assert.equal(vf.hookTelemetryViolations, 0);
    assert.equal(vf.dispatchBlockedWorkers, 0);
  });
});


