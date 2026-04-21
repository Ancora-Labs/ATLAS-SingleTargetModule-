/**
 * self_improvement_repair.test.ts
 *
 * Unit tests for the self-improvement repair engine (Phase A & B).
 *
 * Coverage:
 *   - REPAIR_GATE / HEALTH_GATE constants
 *   - normalizeRepairOutput: safe defaults, STOP_AND_ESCALATE passthrough
 *   - normalizeHealthOutput: safe defaults, UNHEALTHY passthrough
 *   - persistSelfImprovementDecision: writes log + latest files
 *   - escalateRepairFailure: calls appendEscalation correctly
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  REPAIR_GATE,
  HEALTH_GATE,
  normalizeRepairOutput,
  normalizeHealthOutput,
  persistSelfImprovementDecision,
} from "../../src/core/self_improvement_repair.js";

// ── REPAIR_GATE constants ────────────────────────────────────────────────────

describe("REPAIR_GATE constants", () => {
  it("has REPLAN_ONCE and STOP_AND_ESCALATE", () => {
    assert.equal(REPAIR_GATE.REPLAN_ONCE, "REPLAN_ONCE");
    assert.equal(REPAIR_GATE.STOP_AND_ESCALATE, "STOP_AND_ESCALATE");
  });

  it("is frozen", () => {
    assert.throws(() => { REPAIR_GATE.NEW = "x"; }, TypeError);
  });
});

// ── HEALTH_GATE constants ────────────────────────────────────────────────────

describe("HEALTH_GATE constants", () => {
  it("has HEALTHY and UNHEALTHY", () => {
    assert.equal(HEALTH_GATE.HEALTHY, "HEALTHY");
    assert.equal(HEALTH_GATE.UNHEALTHY, "UNHEALTHY");
  });

  it("is frozen", () => {
    assert.throws(() => { HEALTH_GATE.NEW = "x"; }, TypeError);
  });
});

// ── normalizeRepairOutput ────────────────────────────────────────────────────

describe("normalizeRepairOutput", () => {
  it("returns safe defaults for empty input", () => {
    const result = normalizeRepairOutput({});
    assert.equal(result.phase, "repair");
    assert.deepEqual(result.rootCauses, []);
    assert.deepEqual(result.behaviorPatches, []);
    assert.deepEqual(result.repairedPlanConstraints, {});
    assert.deepEqual(result.verificationUpgrades, []);
    assert.equal(result.gateDecision, REPAIR_GATE.REPLAN_ONCE);
    assert.equal(result.gateReason, "");
  });

  it("preserves STOP_AND_ESCALATE gate decision", () => {
    const result = normalizeRepairOutput({
      gateDecision: "STOP_AND_ESCALATE",
      gateReason: "systemic failure",
      rootCauses: [{ cause: "test", severity: "critical", affectedComponent: "prometheus" }],
    });
    assert.equal(result.gateDecision, REPAIR_GATE.STOP_AND_ESCALATE);
    assert.equal(result.gateReason, "systemic failure");
    assert.equal(result.rootCauses.length, 1);
  });

  it("defaults unknown gate decisions to REPLAN_ONCE", () => {
    const result = normalizeRepairOutput({ gateDecision: "UNKNOWN_VALUE" });
    assert.equal(result.gateDecision, REPAIR_GATE.REPLAN_ONCE);
  });

  it("preserves arrays when provided", () => {
    const result = normalizeRepairOutput({
      behaviorPatches: [{ target: "prometheus", patch: "x", rationale: "y" }],
      verificationUpgrades: [{ area: "a", currentProblem: "b", requiredStandard: "c" }],
    });
    assert.equal(result.behaviorPatches.length, 1);
    assert.equal(result.verificationUpgrades.length, 1);
  });
});

// ── normalizeHealthOutput ────────────────────────────────────────────────────

describe("normalizeHealthOutput", () => {
  it("returns safe defaults for empty input", () => {
    const result = normalizeHealthOutput({});
    assert.equal(result.phase, "health_audit");
    assert.equal(result.gateDecision, HEALTH_GATE.HEALTHY);
    assert.equal(result.gateReason, "");
    assert.deepEqual(result.recommendations, []);
  });

  it("preserves UNHEALTHY gate decision", () => {
    const result = normalizeHealthOutput({
      gateDecision: "UNHEALTHY",
      gateReason: "worker errors",
      workerHealth: { overall: "UNHEALTHY", reason: "test", problemWorkers: [{ worker: "w1", issue: "err", severity: "high" }] },
    });
    assert.equal(result.gateDecision, HEALTH_GATE.UNHEALTHY);
    assert.equal(result.workerHealth.problemWorkers.length, 1);
  });

  it("defaults unknown gate decisions to HEALTHY", () => {
    const result = normalizeHealthOutput({ gateDecision: "MAYBE" });
    assert.equal(result.gateDecision, HEALTH_GATE.HEALTHY);
  });
});

// ── persistSelfImprovementDecision ───────────────────────────────────────────

describe("persistSelfImprovementDecision", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "si-repair-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes both log and latest files", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const analysis = {
      gateDecision: "REPLAN_ONCE",
      gateReason: "fixable issue",
      rootCauses: [{ cause: "missing target_files", severity: "high", affectedComponent: "prometheus" }],
      behaviorPatches: [],
      repairedPlanConstraints: {},
      verificationUpgrades: [],
    };

    const record = await persistSelfImprovementDecision(config, "repair", analysis, { athenaReviewCount: 1 });

    assert.equal(record.phase, "repair");
    assert.equal(record.gateDecision, "REPLAN_ONCE");
    assert.ok(record.decidedAt);

    // Check log file
    const logRaw = await fs.readFile(path.join(tmpDir, "self_improvement_decisions.json"), "utf8");
    const log = JSON.parse(logRaw);
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0].gateDecision, "REPLAN_ONCE");

    // Check latest file
    const latestRaw = await fs.readFile(path.join(tmpDir, "self_improvement_latest.json"), "utf8");
    const latest = JSON.parse(latestRaw);
    assert.equal(latest.phase, "repair");
    assert.equal(latest.context.athenaReviewCount, 1);
  });

  it("appends to existing log entries", async () => {
    const config = { paths: { stateDir: tmpDir } };

    await persistSelfImprovementDecision(config, "health_audit", {
      gateDecision: "HEALTHY",
      gateReason: "all good",
    }, {});

    const logRaw = await fs.readFile(path.join(tmpDir, "self_improvement_decisions.json"), "utf8");
    const log = JSON.parse(logRaw);
    assert.equal(log.entries.length, 2);
    assert.equal(log.entries[1].phase, "health_audit");
  });

  it("writes a capability execution trace for the governance gate evaluation", async () => {
    const config = { paths: { stateDir: tmpDir } };

    await persistSelfImprovementDecision(config, "repair", {
      gateDecision: "REPLAN_ONCE",
      gateReason: "trace-test",
    }, {});

    const traceRaw = await fs.readFile(path.join(tmpDir, "capability_execution_traces.json"), "utf8");
    const traceData = JSON.parse(traceRaw);
    assert.ok(Array.isArray(traceData.traces), "traces must be an array");
    const siTrace = traceData.traces.find((t) => t.capability === "self-improvement-gate-evaluation");
    assert.ok(siTrace, "must write a self-improvement-gate-evaluation trace");
    assert.ok(siTrace.context.includes("repair"), "trace context must include phase name");
    assert.ok(siTrace.context.includes("REPLAN_ONCE"), "trace context must include gate decision");
  });
});

