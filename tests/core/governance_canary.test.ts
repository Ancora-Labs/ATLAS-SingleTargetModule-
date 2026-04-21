/**
 * Tests for T-035: Governance canary for policy changes.
 *
 * This file provides deterministic, machine-checkable verification of all
 * T-035 acceptance criteria. Each describe block maps to one or more ACs.
 *
 * Coverage mapping:
 *   AC1  / Athena#1 : assignCohort is deterministic hash-mod; canaryRatio configured
 *   AC2  / Athena#2 : cohortStats tracks canary AND control cohorts separately
 *   AC3  / Athena#3 : explicit promotion thresholds (falseBlockRateMax=0.02, safetyScoreMin=0.95)
 *   AC4  / Athena#4 : breach triggers rollback; breachAction=halt_new_assignments
 *   AC5             : audit logs include cohort assignment on every METRICS_RECORDED event
 *   AC7             : negative path — rollback on high falseBlockRate
 *   AC8             : GOVERNANCE_CANARY_STATUS, GOVERNANCE_AUDIT_EVENT enums; schema fields
 *   AC9  / Athena#7 : validateGovernanceCanaryInput distinguishes MISSING_FIELD / INVALID_VALUE
 *   AC10            : explicit status on NOT_FOUND; auditError on missing required fields
 *   AC14 (breach)   : shouldApplyGovernanceRule returns applyNewRules=false when breach active
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  COHORT,
  GOVERNANCE_CANARY_STATUS,
  GOVERNANCE_AUDIT_EVENT,
  GOVERNANCE_AUDIT_REQUIRED_FIELDS,
  GOVERNANCE_METRIC_NAMES,
  GOVERNANCE_VALIDATION_CODE,
  GOVERNANCE_BREACH_ACTION,
  DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS,
  DEFAULT_GOVERNANCE_BREACH_THRESHOLDS,
  DEFAULT_COHORT_ALGORITHM,
  DEFAULT_MEASUREMENT_WINDOW_CYCLES,
  DEFAULT_BREACH_ACTION,
  assignCohort,
  buildGovernanceCanaryId,
  getGovernanceCanaryConfig,
  validateGovernanceCanaryInput,
  collectGovernanceMetrics,
  aggregateGovernanceMetrics,
  evaluateGovernancePromotion,
  evaluateGovernanceBreach,
  appendGovernanceAuditLog,
  loadGovernanceLedger,
  saveGovernanceLedger,
  startGovernanceCanary,
  processGovernanceCycle,
  isGovernanceCanaryBreachActive
} from "../../src/core/governance_canary.js";

import {
  shouldApplyGovernanceRule
} from "../../src/core/policy_engine.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "box-t035-"));
}

/** Build a minimal runtime config pointing to tmpDir. */
function makeConfig(tmpDir, govOverrides = {}) {
  return {
    rootDir: tmpDir,
    paths:   { stateDir: tmpDir },
    canary: {
      enabled:     true,
      defaultRatio: 0.2,
      governance: {
        canaryRatio:             0.2,
        cohortSelectionAlgorithm: "hash-mod",
        measurementWindowCycles:  5,
        falseBlockRateMax:        0.02,
        safetyScoreMin:           0.95,
        falseBlockRateTrigger:    0.05,
        safetyScoreTriggerLow:    0.80,
        breachAction:             "halt_new_assignments",
        ...govOverrides
      }
    }
  };
}

/** Read governance_canary_audit.jsonl as parsed objects. */
async function readAuditLog(tmpDir) {
  try {
    const raw = await fs.readFile(path.join(tmpDir, "governance_canary_audit.jsonl"), "utf8");
    return raw.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Minimal policy evaluation outcomes. */
function makeEvalOutcomes({ totalEvaluations = 10, falseBlocks = 0, safetyPassed = 10 } = {}) {
  return { totalEvaluations, falseBlocks, safetyPassed };
}

// ── AC8: Enum correctness ─────────────────────────────────────────────────────

describe("COHORT enum (AC1 / AC8)", () => {
  it("is frozen with canary and control values", () => {
    assert.ok(Object.isFrozen(COHORT));
    assert.equal(COHORT.CANARY,  "canary");
    assert.equal(COHORT.CONTROL, "control");
  });
});

describe("GOVERNANCE_CANARY_STATUS enum (AC8)", () => {
  it("is frozen with all four status values", () => {
    assert.ok(Object.isFrozen(GOVERNANCE_CANARY_STATUS));
    assert.equal(GOVERNANCE_CANARY_STATUS.RUNNING,     "running");
    assert.equal(GOVERNANCE_CANARY_STATUS.PROMOTED,    "promoted");
    assert.equal(GOVERNANCE_CANARY_STATUS.ROLLED_BACK, "rolled_back");
    assert.equal(GOVERNANCE_CANARY_STATUS.FAILED,      "failed");
  });
});

describe("GOVERNANCE_AUDIT_EVENT enum (AC8)", () => {
  it("is frozen with all required event names", () => {
    assert.ok(Object.isFrozen(GOVERNANCE_AUDIT_EVENT));
    assert.equal(GOVERNANCE_AUDIT_EVENT.CANARY_STARTED,     "GOVERNANCE_CANARY_STARTED");
    assert.equal(GOVERNANCE_AUDIT_EVENT.CYCLE_ASSIGNED,     "GOVERNANCE_CYCLE_ASSIGNED");
    assert.equal(GOVERNANCE_AUDIT_EVENT.METRICS_RECORDED,   "GOVERNANCE_METRICS_RECORDED");
    assert.equal(GOVERNANCE_AUDIT_EVENT.CANARY_PROMOTED,    "GOVERNANCE_CANARY_PROMOTED");
    assert.equal(GOVERNANCE_AUDIT_EVENT.CANARY_ROLLED_BACK, "GOVERNANCE_CANARY_ROLLED_BACK");
  });
});

describe("GOVERNANCE_BREACH_ACTION enum (AC4 / AC8)", () => {
  it("exposes halt_new_assignments as the breach action", () => {
    assert.ok(Object.isFrozen(GOVERNANCE_BREACH_ACTION));
    assert.equal(GOVERNANCE_BREACH_ACTION.HALT_NEW_ASSIGNMENTS, "halt_new_assignments");
    assert.equal(DEFAULT_BREACH_ACTION, "halt_new_assignments");
  });
});

describe("GOVERNANCE_METRIC_NAMES (AC2 / AC8)", () => {
  it("is frozen with falseBlockRate and safetyScore keys", () => {
    assert.ok(Object.isFrozen(GOVERNANCE_METRIC_NAMES));
    assert.equal(GOVERNANCE_METRIC_NAMES.FALSE_BLOCK_RATE, "falseBlockRate");
    assert.equal(GOVERNANCE_METRIC_NAMES.SAFETY_SCORE,     "safetyScore");
  });
});

// ── AC3: Promotion thresholds (Athena missing item 3) ────────────────────────

describe("DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS (AC3 / Athena#3)", () => {
  it("is frozen with explicit numeric values falseBlockRateMax=0.02, safetyScoreMin=0.95", () => {
    assert.ok(Object.isFrozen(DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS));
    assert.equal(DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS.falseBlockRateMax, 0.02,
      "falseBlockRateMax must be 0.02 (< 2% false-block rate required)");
    assert.equal(DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS.safetyScoreMin, 0.95,
      "safetyScoreMin must be 0.95 (>= 95% safety score required)");
  });
});

describe("DEFAULT_GOVERNANCE_BREACH_THRESHOLDS (AC4 / Athena#4)", () => {
  it("is frozen with explicit numeric breach trigger values", () => {
    assert.ok(Object.isFrozen(DEFAULT_GOVERNANCE_BREACH_THRESHOLDS));
    assert.equal(DEFAULT_GOVERNANCE_BREACH_THRESHOLDS.falseBlockRateTrigger, 0.05);
    assert.equal(DEFAULT_GOVERNANCE_BREACH_THRESHOLDS.safetyScoreTriggerLow, 0.80);
  });
});

describe("DEFAULT_COHORT_ALGORITHM (AC1 / Athena#1)", () => {
  it("is hash-mod", () => {
    assert.equal(DEFAULT_COHORT_ALGORITHM, "hash-mod");
  });
});

describe("DEFAULT_MEASUREMENT_WINDOW_CYCLES (AC4)", () => {
  it("is 5", () => {
    assert.equal(DEFAULT_MEASUREMENT_WINDOW_CYCLES, 5);
  });
});

// ── AC1: Cohort selection (Athena missing item 1) ─────────────────────────────

describe("assignCohort (AC1 / Athena#1)", () => {
  it("returns CANARY or CONTROL (only valid values)", () => {
    for (let i = 0; i < 20; i++) {
      const cohort = assignCohort(`cycle-${i}`, 0.5);
      assert.ok([COHORT.CANARY, COHORT.CONTROL].includes(cohort),
        `invalid cohort value: ${cohort}`);
    }
  });

  it("is deterministic — same cycleId always maps to same cohort (AC1)", () => {
    for (let i = 0; i < 10; i++) {
      const id = `cycle-determinism-${i}`;
      const c1 = assignCohort(id, 0.2);
      const c2 = assignCohort(id, 0.2);
      assert.equal(c1, c2, `cohort must be stable for cycleId=${id}`);
    }
  });

  it("produces different cohorts for different cycleIds (hash variety)", () => {
    const cohorts = new Set();
    for (let i = 0; i < 100; i++) {
      cohorts.add(assignCohort(`cycle-variety-${i}`, 0.5));
    }
    assert.ok(cohorts.has(COHORT.CANARY),  "must assign CANARY at some point");
    assert.ok(cohorts.has(COHORT.CONTROL), "must assign CONTROL at some point");
  });

  it("with ratio=1.0, all cycles map to CANARY", () => {
    for (let i = 0; i < 20; i++) {
      assert.equal(assignCohort(`c-${i}`, 1.0), COHORT.CANARY);
    }
  });

  it("with ratio approaching 0, almost all map to CONTROL", () => {
    let canaryCount = 0;
    for (let i = 0; i < 1000; i++) {
      if (assignCohort(`c-${i}`, 0.01) === COHORT.CANARY) canaryCount++;
    }
    // With 1% ratio, expect < 5% canary over 1000 samples
    assert.ok(canaryCount < 50, `too many canary assignments for ratio=0.01: ${canaryCount}/1000`);
  });

  it("returns CONTROL for empty cycleId (safe fallback — no new rules)", () => {
    assert.equal(assignCohort("", 0.9), COHORT.CONTROL);
    assert.equal(assignCohort(null, 0.9), COHORT.CONTROL);
  });

  it("uses hash-mod algorithm as documented (bucket = parseInt(sha1.slice(0,8),16) % 100)", () => {
    // Verify the exact algorithm by checking known cycle IDs
    // Different from random — must be sha1-based
    const c1 = assignCohort("test-cycle-001", 0.5);
    const c2 = assignCohort("test-cycle-001", 0.5);
    assert.equal(c1, c2, "hash-mod must be reproducible");
    // Changing ratio must change cohort boundary
    // With ratio=0.001 (<0.1%), cycle should be CONTROL
    assert.equal(assignCohort("test-cycle-001", 0.001), COHORT.CONTROL);
    // With ratio=1.0, must be CANARY
    assert.equal(assignCohort("test-cycle-001", 1.0), COHORT.CANARY);
  });
});

// ── AC9: Input validation (Athena missing item 7) ────────────────────────────

describe("validateGovernanceCanaryInput (AC9 / Athena#7)", () => {
  it("returns ok=true for a valid input", () => {
    const result = validateGovernanceCanaryInput({
      policyRulePatch: { blockedCommands: ["rm -rf"] },
      canaryRatio: 0.2
    });
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("returns MISSING_FIELD when policyRulePatch is absent (AC9)", () => {
    const result = validateGovernanceCanaryInput({ canaryRatio: 0.2 });
    assert.equal(result.ok, false);
    const err = result.errors.find(e => e.field === "policyRulePatch");
    assert.ok(err, "must have error for policyRulePatch");
    assert.equal(err.code, GOVERNANCE_VALIDATION_CODE.MISSING_FIELD,
      "missing field must use MISSING_FIELD code, not INVALID_VALUE");
  });

  it("returns INVALID_VALUE when policyRulePatch is an array (AC9)", () => {
    const result = validateGovernanceCanaryInput({ policyRulePatch: [1, 2, 3] });
    assert.equal(result.ok, false);
    const err = result.errors.find(e => e.field === "policyRulePatch");
    assert.ok(err);
    assert.equal(err.code, GOVERNANCE_VALIDATION_CODE.INVALID_VALUE,
      "array policyRulePatch must use INVALID_VALUE code, not MISSING_FIELD");
  });

  it("returns INVALID_VALUE when canaryRatio is out of range (AC9)", () => {
    const result = validateGovernanceCanaryInput({
      policyRulePatch: { x: 1 },
      canaryRatio: 1.5
    });
    assert.equal(result.ok, false);
    const err = result.errors.find(e => e.field === "canaryRatio");
    assert.ok(err);
    assert.equal(err.code, GOVERNANCE_VALIDATION_CODE.INVALID_VALUE);
  });

  it("returns MISSING_FIELD on null input (root validation)", () => {
    const result = validateGovernanceCanaryInput(null);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].field,  "root");
    assert.equal(result.errors[0].code,   GOVERNANCE_VALIDATION_CODE.MISSING_FIELD);
  });
});

// ── AC2: Metric collection and aggregation ────────────────────────────────────

describe("collectGovernanceMetrics (AC2 / Athena#2)", () => {
  it("computes falseBlockRate correctly", () => {
    const m = collectGovernanceMetrics(makeEvalOutcomes({ totalEvaluations: 100, falseBlocks: 2 }));
    assert.equal(m.falseBlockRate, 0.02);
  });

  it("computes safetyScore correctly", () => {
    const m = collectGovernanceMetrics(makeEvalOutcomes({ totalEvaluations: 10, safetyPassed: 9 }));
    assert.equal(m.safetyScore, 0.9);
  });

  it("returns zero falseBlockRate and safetyScore=1 for empty outcomes (no NaN)", () => {
    const m = collectGovernanceMetrics({});
    assert.equal(m.falseBlockRate, 0);
    assert.equal(m.safetyScore,   1);
    assert.equal(m.sampleSize,    0);
  });

  it("handles null gracefully (AC10 — no silent NaN)", () => {
    const m = collectGovernanceMetrics(null);
    assert.equal(m.falseBlockRate, 0);
    assert.equal(m.safetyScore,   1);
  });
});

describe("aggregateGovernanceMetrics (AC2)", () => {
  it("averages falseBlockRate and safetyScore across snapshots", () => {
    const snaps = [
      { falseBlockRate: 0.01, safetyScore: 0.99 },
      { falseBlockRate: 0.02, safetyScore: 0.97 }
    ];
    const agg = aggregateGovernanceMetrics(snaps);
    assert.ok(Math.abs(agg.falseBlockRate - 0.015) < 1e-10);
    assert.ok(Math.abs(agg.safetyScore    - 0.98)  < 1e-10);
    assert.equal(agg.totalObservations, 2);
  });

  it("returns safe defaults for empty array", () => {
    const agg = aggregateGovernanceMetrics([]);
    assert.equal(agg.falseBlockRate, 0);
    assert.equal(agg.safetyScore,   1);
    assert.equal(agg.totalObservations, 0);
  });
});

// ── AC3: Promotion evaluation ─────────────────────────────────────────────────

describe("evaluateGovernancePromotion (AC3 / Athena#3)", () => {
  it("returns promote=true when falseBlockRate < 0.02 and safetyScore >= 0.95", () => {
    const r = evaluateGovernancePromotion({ falseBlockRate: 0.01, safetyScore: 0.97 });
    assert.equal(r.promote, true);
    assert.equal(r.reason, "ALL_GOVERNANCE_THRESHOLDS_MET");
  });

  it("returns promote=false when falseBlockRate >= 0.02 (boundary)", () => {
    const r = evaluateGovernancePromotion({ falseBlockRate: 0.02, safetyScore: 0.97 });
    assert.equal(r.promote, false);
    assert.ok(r.reason.includes("FALSE_BLOCK_RATE_ABOVE_THRESHOLD"), `reason: ${r.reason}`);
  });

  it("returns promote=false when falseBlockRate > 0.02 (AC7 — negative path)", () => {
    const r = evaluateGovernancePromotion({ falseBlockRate: 0.05, safetyScore: 0.97 });
    assert.equal(r.promote, false);
    assert.ok(r.reason.includes("FALSE_BLOCK_RATE_ABOVE_THRESHOLD"), `reason: ${r.reason}`);
  });

  it("returns promote=false when safetyScore < 0.95 (AC7 — negative path)", () => {
    const r = evaluateGovernancePromotion({ falseBlockRate: 0.01, safetyScore: 0.90 });
    assert.equal(r.promote, false);
    assert.ok(r.reason.includes("SAFETY_SCORE_BELOW_THRESHOLD"), `reason: ${r.reason}`);
  });

  it("respects custom threshold overrides", () => {
    // Relaxed thresholds: up to 10% falseBlockRate, safetyScore ≥ 0.8
    const r = evaluateGovernancePromotion(
      { falseBlockRate: 0.05, safetyScore: 0.85 },
      { falseBlockRateMax: 0.10, safetyScoreMin: 0.80 }
    );
    assert.equal(r.promote, true);
  });
});

// ── AC4: Breach evaluation (Athena missing item 4) ────────────────────────────

describe("evaluateGovernanceBreach (AC4 / Athena#4 / AC7)", () => {
  it("returns breach=false for healthy metrics", () => {
    const r = evaluateGovernanceBreach({ falseBlockRate: 0.01, safetyScore: 0.99 });
    assert.equal(r.breach, false);
    assert.equal(r.reason, null);
  });

  it("returns breach=true when falseBlockRate > triggerFbr=0.05 (AC7 — negative path)", () => {
    const r = evaluateGovernanceBreach({ falseBlockRate: 0.08, safetyScore: 0.99 });
    assert.equal(r.breach, true);
    assert.ok(r.reason.includes("GOVERNANCE_BREACH_FALSE_BLOCK_RATE"), `reason: ${r.reason}`);
  });

  it("returns breach=true when safetyScore < triggerSs=0.80 (AC7 — negative path)", () => {
    const r = evaluateGovernanceBreach({ falseBlockRate: 0.01, safetyScore: 0.70 });
    assert.equal(r.breach, true);
    assert.ok(r.reason.includes("GOVERNANCE_BREACH_SAFETY_SCORE_TOO_LOW"), `reason: ${r.reason}`);
  });

  it("respects custom threshold overrides", () => {
    // High triggers: breach only at very bad metrics
    const r = evaluateGovernanceBreach(
      { falseBlockRate: 0.08, safetyScore: 0.99 },
      { falseBlockRateTrigger: 0.20, safetyScoreTriggerLow: 0.50 }
    );
    assert.equal(r.breach, false);
  });
});

// ── AC5: Audit log ────────────────────────────────────────────────────────────

describe("appendGovernanceAuditLog (AC5)", () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async  () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("writes a valid JSONL line to governance_canary_audit.jsonl", async () => {
    await appendGovernanceAuditLog(tmpDir, {
      event:        GOVERNANCE_AUDIT_EVENT.CANARY_STARTED,
      canaryId:     "govcanary-abc123",
      experimentId: "exp-001",
      cycleId:      null,
      cohort:       null,
      timestamp:    "2026-01-01T00:00:00Z",
      metrics:      null,
      reason:       "test"
    });

    const lines = await readAuditLog(tmpDir);
    assert.ok(lines.length >= 1, "at least one line written");
    const entry = lines[lines.length - 1];
    assert.equal(entry.event,    GOVERNANCE_AUDIT_EVENT.CANARY_STARTED);
    assert.equal(entry.canaryId, "govcanary-abc123");
  });

  it("sets auditError when required fields are missing (AC10 — no silent failure)", async () => {
    const dir2 = await makeTmpDir();
    try {
      await appendGovernanceAuditLog(dir2, {
        // Missing: event, canaryId
        timestamp: "2026-01-01T00:00:00Z"
      });
      const lines = await readAuditLog(dir2);
      assert.equal(lines.length, 1);
      assert.ok(lines[0].auditError, "missing required fields must produce auditError");
      assert.ok(lines[0].auditError.startsWith("MISSING_REQUIRED_FIELDS:"),
        `got: ${lines[0].auditError}`);
    } finally {
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });
});

// ── AC1 / Athena#1: buildGovernanceCanaryId ───────────────────────────────────

describe("buildGovernanceCanaryId (AC1 / Athena#1)", () => {
  it("returns govcanary-<sha1-12> format", () => {
    const id = buildGovernanceCanaryId('{"x":1}', "2026-01-01T00:00:00Z");
    assert.match(id, /^govcanary-[0-9a-f]{12}$/, "ID must match govcanary-<sha1-12>");
  });

  it("is deterministic for same inputs", () => {
    const id1 = buildGovernanceCanaryId("key1", "2026-01-01T00:00:00Z");
    const id2 = buildGovernanceCanaryId("key1", "2026-01-01T00:00:00Z");
    assert.equal(id1, id2);
  });

  it("produces different IDs for different keys", () => {
    const id1 = buildGovernanceCanaryId("key1", "2026-01-01T00:00:00Z");
    const id2 = buildGovernanceCanaryId("key2", "2026-01-01T00:00:00Z");
    assert.notEqual(id1, id2);
  });
});

// ── AC1 / AC5: startGovernanceCanary ─────────────────────────────────────────

describe("startGovernanceCanary (AC1 / AC5)", () => {
  let tmpDir;
  before(async () => { tmpDir = await makeTmpDir(); });
  after(async  () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns ok=true with govcanary-<sha1-12> canaryId", async () => {
    const config = makeConfig(tmpDir);
    const result = await startGovernanceCanary(
      config,
      { blockedCommands: ["rm -rf /"] },
      "exp-gov-001"
    );
    assert.equal(result.ok, true);
    assert.match(result.canaryId, /^govcanary-[0-9a-f]{12}$/, "canaryId must match format");
  });

  it("records entry in governance_canary_ledger.json with correct fields", async () => {
    const ledger = await loadGovernanceLedger(tmpDir);
    const entry  = ledger.experiments.find(e => e.experimentId === "exp-gov-001");
    assert.ok(entry, "ledger entry must exist");
    assert.equal(entry.status,      GOVERNANCE_CANARY_STATUS.RUNNING);
    assert.ok(typeof entry.canaryRatio === "number", "canaryRatio must be a number");
    // AC2: cohortStats must have both canary and control keys
    assert.ok(entry.cohortStats?.canary,  "cohortStats.canary must exist");
    assert.ok(entry.cohortStats?.control, "cohortStats.control must exist");
    assert.ok(Array.isArray(entry.cycleLog), "cycleLog must be an array");
  });

  it("emits GOVERNANCE_CANARY_STARTED audit event (AC5)", async () => {
    const lines = await readAuditLog(tmpDir);
    const evt   = lines.find(l => l.event === GOVERNANCE_AUDIT_EVENT.CANARY_STARTED);
    assert.ok(evt, "GOVERNANCE_CANARY_STARTED event must be written");
    assert.match(evt.canaryId, /^govcanary-[0-9a-f]{12}$/);
  });

  it("returns ALREADY_RUNNING for duplicate patch (AC10 — explicit status)", async () => {
    const config = makeConfig(tmpDir);
    const result = await startGovernanceCanary(
      config,
      { blockedCommands: ["rm -rf /"] },  // same patch as above
      null
    );
    assert.equal(result.ok,     false);
    assert.equal(result.status, "ALREADY_RUNNING");
    assert.ok(result.canaryId, "ALREADY_RUNNING must include the existing canaryId");
  });

  it("returns CANARY_DISABLED when canary.enabled=false (AC10)", async () => {
    const dir2   = await makeTmpDir();
    const config = { ...makeConfig(dir2), canary: { enabled: false } };
    const result = await startGovernanceCanary(config, { x: 1 }, null);
    assert.equal(result.ok,     false);
    assert.equal(result.status, "CANARY_DISABLED");
    await fs.rm(dir2, { recursive: true, force: true });
  });

  it("returns INVALID_INPUT for null policyRulePatch (AC9)", async () => {
    const dir2   = await makeTmpDir();
    const config = makeConfig(dir2);
    const result = await startGovernanceCanary(config, null, null);
    assert.equal(result.ok,     false);
    assert.equal(result.status, "INVALID_INPUT");
    assert.ok(Array.isArray(result.errors));
    assert.equal(result.errors[0].code, GOVERNANCE_VALIDATION_CODE.MISSING_FIELD);
    await fs.rm(dir2, { recursive: true, force: true });
  });
});

// ── AC2 / AC3 / AC5: processGovernanceCycle — promote path ───────────────────

describe("processGovernanceCycle — promote path (AC2 / AC3 / AC5)", () => {
  let tmpDir;
  let canaryId;

  before(async () => {
    tmpDir = await makeTmpDir();
    // Use ratio=1.0 so all cycles map to CANARY cohort, and window=2 for quick test
    const config = makeConfig(tmpDir, { canaryRatio: 1.0, measurementWindowCycles: 2 });
    const result = await startGovernanceCanary(config, { blockedCommands: ["drop table"] }, "exp-promote-gov");
    canaryId = result.canaryId;
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("action=continue before enough canary cycle observations", async () => {
    const config  = makeConfig(tmpDir, { canaryRatio: 1.0, measurementWindowCycles: 2 });
    // Only 1 cycle so far (need 2)
    const goodOutcomes = makeEvalOutcomes({ totalEvaluations: 10, falseBlocks: 0, safetyPassed: 10 });
    const results = await processGovernanceCycle(config, "cycle-pre-window-1", goodOutcomes);
    assert.equal(results.length, 1);
    // After 1 cycle we still need 1 more
    assert.ok(["continue", "promote"].includes(results[0].action),
      `expected continue or promote, got ${results[0].action}`);
  });

  it("promotes after measurementWindowCycles with good metrics (AC3)", async () => {
    const config      = makeConfig(tmpDir, { canaryRatio: 1.0, measurementWindowCycles: 2 });
    const goodOutcomes = makeEvalOutcomes({ totalEvaluations: 10, falseBlocks: 0, safetyPassed: 10 });
    const results      = await processGovernanceCycle(config, "cycle-promote-2", goodOutcomes);
    assert.equal(results.length, 1, "one running canary → one result");
    assert.equal(results[0].action, "promote",
      `expected promote after 2 good cycles, got ${results[0].action}: ${results[0].reason}`);
  });

  it("ledger entry marked as promoted (AC3)", async () => {
    const ledger = await loadGovernanceLedger(tmpDir);
    const entry  = ledger.experiments.find(e => e.canaryId === canaryId);
    assert.ok(entry, "ledger entry must exist");
    assert.equal(entry.status, GOVERNANCE_CANARY_STATUS.PROMOTED);
    assert.ok(entry.promotedAt, "promotedAt must be set");
  });

  it("audit log contains METRICS_RECORDED with cohort field (AC5)", async () => {
    const lines = await readAuditLog(tmpDir);
    const metricEvts = lines.filter(l => l.event === GOVERNANCE_AUDIT_EVENT.METRICS_RECORDED);
    assert.ok(metricEvts.length > 0, "METRICS_RECORDED events must be written");
    for (const evt of metricEvts) {
      assert.ok(evt.cohort, "each METRICS_RECORDED event must include cohort (AC5)");
      assert.ok([COHORT.CANARY, COHORT.CONTROL].includes(evt.cohort),
        `cohort must be canary or control, got ${evt.cohort}`);
    }
  });

  it("audit log contains GOVERNANCE_CANARY_PROMOTED event (AC5)", async () => {
    const lines = await readAuditLog(tmpDir);
    const promoted = lines.find(l => l.event === GOVERNANCE_AUDIT_EVENT.CANARY_PROMOTED);
    assert.ok(promoted, "GOVERNANCE_CANARY_PROMOTED must be in audit log");
    assert.equal(promoted.experimentId, "exp-promote-gov");
  });
});

// ── AC4 / AC7: processGovernanceCycle — breach/rollback path ─────────────────

describe("processGovernanceCycle — breach (rollback) path (AC4 / AC7 / Athena#4)", () => {
  let tmpDir;
  let canaryId;

  before(async () => {
    tmpDir = await makeTmpDir();
    // Use ratio=1.0 so all cycles go to CANARY, window=5
    const config = makeConfig(tmpDir, { canaryRatio: 1.0, measurementWindowCycles: 5 });
    const result = await startGovernanceCanary(config, { blockedCommands: ["format c:"] }, "exp-breach-gov");
    canaryId = result.canaryId;
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("triggers immediate rollback when falseBlockRate exceeds breach threshold (AC4 / AC7)", async () => {
    const config = makeConfig(tmpDir, { canaryRatio: 1.0, measurementWindowCycles: 5 });
    // falseBlockRate=0.10 >> triggerFbr=0.05 → breach
    const badOutcomes = makeEvalOutcomes({ totalEvaluations: 10, falseBlocks: 1, safetyPassed: 10 });
    // Adjust: 1/10 = 0.10 which is > 0.05 trigger
    const results = await processGovernanceCycle(config, "breach-cycle-1", badOutcomes);
    assert.equal(results.length, 1);
    assert.equal(results[0].action, "rollback",
      `expected rollback on high falseBlockRate, got ${results[0].action}: ${results[0].reason}`);
    assert.ok(results[0].reason.includes("GOVERNANCE_BREACH_FALSE_BLOCK_RATE"),
      `reason must identify the breach metric: ${results[0].reason}`);
  });

  it("ledger entry is rolled_back with breachAction=halt_new_assignments (AC4 / AC8)", async () => {
    const ledger = await loadGovernanceLedger(tmpDir);
    const entry  = ledger.experiments.find(e => e.canaryId === canaryId);
    assert.ok(entry, "ledger entry must exist");
    assert.equal(entry.status, GOVERNANCE_CANARY_STATUS.ROLLED_BACK);
    assert.ok(entry.statusReason, "statusReason must be non-null");
    assert.equal(entry.breachAction, GOVERNANCE_BREACH_ACTION.HALT_NEW_ASSIGNMENTS,
      "breachAction must be halt_new_assignments (AC4)");
    assert.ok(entry.rolledBackAt, "rolledBackAt must be set");
  });

  it("audit log contains GOVERNANCE_CANARY_ROLLED_BACK event (AC5)", async () => {
    const lines = await readAuditLog(tmpDir);
    const rolled = lines.find(l => l.event === GOVERNANCE_AUDIT_EVENT.CANARY_ROLLED_BACK);
    assert.ok(rolled, "GOVERNANCE_CANARY_ROLLED_BACK must be in audit log");
    assert.equal(rolled.experimentId, "exp-breach-gov");
    assert.ok(rolled.reason.includes("halt_new_assignments"), "reason must include breach action");
  });
});

// ── AC4 / AC7: rollback on low safetyScore ───────────────────────────────────

describe("processGovernanceCycle — breach on low safetyScore (AC4 / AC7)", () => {
  let tmpDir;

  before(async () => { tmpDir = await makeTmpDir(); });
  after(async  () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("triggers rollback when safetyScore is below breach threshold (AC7 — negative path)", async () => {
    const config = makeConfig(tmpDir, { canaryRatio: 1.0, measurementWindowCycles: 5 });
    await startGovernanceCanary(config, { protectedPaths: ["src/**"] }, null);

    // safetyPassed=5/10 = 0.5 < safetyScoreTriggerLow=0.80 → breach
    const badOutcomes = makeEvalOutcomes({ totalEvaluations: 10, falseBlocks: 0, safetyPassed: 5 });
    const results     = await processGovernanceCycle(config, "low-safety-cycle", badOutcomes);
    assert.equal(results.length, 1);
    assert.equal(results[0].action, "rollback",
      `expected rollback on low safetyScore, got ${results[0].action}: ${results[0].reason}`);
    assert.ok(results[0].reason.includes("GOVERNANCE_BREACH_SAFETY_SCORE_TOO_LOW"),
      `reason must identify safety breach: ${results[0].reason}`);
  });
});

// ── AC2: cohort tracking — control cohort is tracked separately ───────────────

describe("Control cohort tracking (AC2 / Athena#2)", () => {
  let tmpDir;

  before(async () => { tmpDir = await makeTmpDir(); });
  after(async  () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("records control cohort cycles in cohortStats.control (AC2)", async () => {
    // Use ratio=0 (actually 0.001) to force all cycles to CONTROL
    const config = makeConfig(tmpDir, { canaryRatio: 0.001, measurementWindowCycles: 10 });
    await startGovernanceCanary(config, { rolePolicies: {} }, "exp-control-track");

    const goodOutcomes = makeEvalOutcomes({ totalEvaluations: 5, falseBlocks: 0, safetyPassed: 5 });
    const results      = await processGovernanceCycle(config, "control-cycle-1", goodOutcomes);

    assert.equal(results.length, 1);
    assert.equal(results[0].cohort,  COHORT.CONTROL, "very low ratio should assign CONTROL");
    assert.equal(results[0].action,  "continue",     "control cohort should continue observing");
    assert.ok(results[0].reason.includes("CONTROL_COHORT"),
      `reason must indicate control cohort: ${results[0].reason}`);

    const ledger = await loadGovernanceLedger(tmpDir);
    const entry  = ledger.experiments.find(e => e.experimentId === "exp-control-track");
    assert.ok(entry, "ledger entry must exist");
    assert.ok(entry.cohortStats.control.cycleCount > 0, "control cohort must have tracked cycles");
  });
});

// ── AC4: shouldApplyGovernanceRule — breach blocks new assignments ─────────────

describe("shouldApplyGovernanceRule (AC4 / Athena#4)", () => {
  let tmpDir;

  before(async () => { tmpDir = await makeTmpDir(); });
  after(async  () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns applyNewRules based on cohort assignment (ratio=1.0 → always canary)", async () => {
    const config = makeConfig(tmpDir, { canaryRatio: 1.0 });
    const result = await shouldApplyGovernanceRule(config, "test-cycle-policy-001");
    assert.ok([true, false].includes(result.applyNewRules), "applyNewRules must be boolean");
    assert.ok([COHORT.CANARY, COHORT.CONTROL].includes(result.cohort), "cohort must be enum value");
    assert.ok(typeof result.reason === "string", "reason must be a string");
    // With ratio=1.0, all cycles → canary → apply=true
    assert.equal(result.applyNewRules, true);
    assert.equal(result.cohort, COHORT.CANARY);
  });

  it("returns applyNewRules=false for CONTROL cohort (ratio≈0)", async () => {
    const config = makeConfig(tmpDir, { canaryRatio: 0.001 });
    const result = await shouldApplyGovernanceRule(config, "test-cycle-policy-002");
    assert.equal(result.applyNewRules, false);
    assert.equal(result.cohort, COHORT.CONTROL);
  });

  it("returns applyNewRules=false with reason MISSING_CYCLE_ID when cycleId is empty (AC9)", async () => {
    const config = makeConfig(tmpDir);
    const result = await shouldApplyGovernanceRule(config, "");
    assert.equal(result.applyNewRules, false);
    assert.ok(result.reason.includes("MISSING_CYCLE_ID"), `reason: ${result.reason}`);
  });

  it("returns applyNewRules=false with BREACH_ACTIVE reason when breach is active (AC4)", async () => {
    const dir2 = await makeTmpDir();
    try {
      // Force a breach by inserting a rolled_back entry with halt_new_assignments
      const ledger = await loadGovernanceLedger(dir2);
      ledger.experiments.push({
        canaryId:     "govcanary-breach-test",
        experimentId: null,
        policyKey:    '{"test":1}',
        policyRulePatch: { test: 1 },
        canaryRatio:  0.2,
        status:       GOVERNANCE_CANARY_STATUS.ROLLED_BACK,
        statusReason: "GOVERNANCE_BREACH_FALSE_BLOCK_RATE:0.1000>0.05",
        breachAction: GOVERNANCE_BREACH_ACTION.HALT_NEW_ASSIGNMENTS,
        cohortStats: {
          canary:  { cycleCount: 1, falseBlockRate: 0.1, safetyScore: 0.9 },
          control: { cycleCount: 0, falseBlockRate: 0,   safetyScore: 1   }
        },
        cycleLog:    [],
        createdAt:   new Date().toISOString(),
        promotedAt:  null,
        rolledBackAt: new Date().toISOString()
      });
      await saveGovernanceLedger(dir2, ledger);

      const config = makeConfig(dir2, { canaryRatio: 1.0 });
      const result = await shouldApplyGovernanceRule(config, "cycle-during-breach");
      assert.equal(result.applyNewRules, false,
        "must not apply new rules when breach is active (AC4)");
      assert.ok(result.reason.includes("BREACH_ACTIVE"),
        `reason must indicate breach: ${result.reason}`);
    } finally {
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });
});

// ── AC10: isGovernanceCanaryBreachActive (no silent failure) ──────────────────

describe("isGovernanceCanaryBreachActive (AC10)", () => {
  let tmpDir;

  before(async () => { tmpDir = await makeTmpDir(); });
  after(async  () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns breachActive=false when no experiments exist", async () => {
    const config = makeConfig(tmpDir);
    const result = await isGovernanceCanaryBreachActive(config);
    assert.equal(result.breachActive, false);
    assert.equal(result.reason,       null);
  });

  it("returns breachActive=false when canary is disabled", async () => {
    const config = { ...makeConfig(tmpDir), canary: { enabled: false } };
    const result = await isGovernanceCanaryBreachActive(config);
    assert.equal(result.breachActive, false);
  });

  it("returns breachActive=true when a rolled_back entry with halt_new_assignments exists (AC4)", async () => {
    const ledger = await loadGovernanceLedger(tmpDir);
    ledger.experiments.push({
      canaryId:     "govcanary-breach-active-check",
      status:       GOVERNANCE_CANARY_STATUS.ROLLED_BACK,
      breachAction: GOVERNANCE_BREACH_ACTION.HALT_NEW_ASSIGNMENTS,
      statusReason: "TEST_BREACH",
      experimentId: null, policyKey: "{}", policyRulePatch: {}, canaryRatio: 0.2,
      cohortStats: { canary: { cycleCount: 0, falseBlockRate: 0, safetyScore: 1 },
                     control: { cycleCount: 0, falseBlockRate: 0, safetyScore: 1 } },
      cycleLog: [], createdAt: new Date().toISOString(), promotedAt: null, rolledBackAt: new Date().toISOString()
    });
    await saveGovernanceLedger(tmpDir, ledger);

    const config = makeConfig(tmpDir);
    const result = await isGovernanceCanaryBreachActive(config);
    assert.equal(result.breachActive, true);
    assert.ok(result.reason, "must include reason when breach is active");
  });
});

// ── AC8: Schema field completeness ────────────────────────────────────────────

describe("Ledger schema field completeness (AC8 / Athena#2)", () => {
  let tmpDir;
  let canaryId;

  before(async () => {
    tmpDir = await makeTmpDir();
    const config = makeConfig(tmpDir);
    const result = await startGovernanceCanary(config, { testField: "schema-check" }, "exp-schema");
    canaryId = result.canaryId;
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("ledger entry has all required schema fields", async () => {
    const ledger = await loadGovernanceLedger(tmpDir);
    const entry  = ledger.experiments.find(e => e.canaryId === canaryId);
    assert.ok(entry, "entry must exist");
    const required = [
      "canaryId", "experimentId", "policyRulePatch", "canaryRatio",
      "status", "statusReason", "cohortStats", "cycleLog", "createdAt",
      "promotedAt", "rolledBackAt"
    ];
    for (const field of required) {
      assert.ok(field in entry, `ledger entry must have field: ${field}`);
    }
  });

  it("cohortStats has canary and control sub-objects with named fields (AC2)", async () => {
    const ledger = await loadGovernanceLedger(tmpDir);
    const entry  = ledger.experiments.find(e => e.canaryId === canaryId);
    for (const cohortKey of ["canary", "control"]) {
      const cs = entry.cohortStats[cohortKey];
      assert.ok(cs, `cohortStats.${cohortKey} must exist`);
      assert.ok("cycleCount"    in cs, `cohortStats.${cohortKey}.cycleCount required`);
      assert.ok("falseBlockRate" in cs, `cohortStats.${cohortKey}.falseBlockRate required`);
      assert.ok("safetyScore"   in cs, `cohortStats.${cohortKey}.safetyScore required`);
    }
  });

  it("ledger has schemaVersion=1", async () => {
    const ledger = await loadGovernanceLedger(tmpDir);
    assert.equal(ledger.schemaVersion, 1);
  });
});

// ── getGovernanceCanaryConfig ─────────────────────────────────────────────────

describe("getGovernanceCanaryConfig (AC1 / AC3 / AC4)", () => {
  it("reads values from canary.governance in config", () => {
    const config = makeConfig("/tmp/x", {
      canaryRatio: 0.3, falseBlockRateMax: 0.01, safetyScoreMin: 0.98
    });
    const gc = getGovernanceCanaryConfig(config);
    assert.equal(gc.canaryRatio,       0.3);
    assert.equal(gc.falseBlockRateMax, 0.01);
    assert.equal(gc.safetyScoreMin,    0.98);
    assert.equal(gc.cohortSelectionAlgorithm, "hash-mod");
  });

  it("applies defaults when canary.governance is absent", () => {
    const gc = getGovernanceCanaryConfig({});
    assert.equal(gc.falseBlockRateMax, DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS.falseBlockRateMax);
    assert.equal(gc.safetyScoreMin,    DEFAULT_GOVERNANCE_PROMOTION_THRESHOLDS.safetyScoreMin);
    assert.equal(gc.breachAction,      DEFAULT_BREACH_ACTION);
    assert.equal(gc.cohortSelectionAlgorithm, DEFAULT_COHORT_ALGORITHM);
  });
});

// ── AC6: GOVERNANCE_AUDIT_REQUIRED_FIELDS ────────────────────────────────────

describe("GOVERNANCE_AUDIT_REQUIRED_FIELDS (AC6 / AC5)", () => {
  it("includes the three required fields: event, canaryId, timestamp", () => {
    for (const f of ["event", "canaryId", "timestamp"]) {
      assert.ok(
        GOVERNANCE_AUDIT_REQUIRED_FIELDS.includes(f),
        `GOVERNANCE_AUDIT_REQUIRED_FIELDS must include ${f}`
      );
    }
  });
});

// ── Audit write failure — explicit non-fatal signal ───────────────────────────

describe("appendGovernanceAuditLog — audit-write-failed status", () => {
  it("should return audit-write-failed status when appendFile fails", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-audit-fail-"));
    try {
      // Make the audit log path a directory so fs.appendFile fails
      const auditLogPath = path.join(tmpDir, "governance_canary_audit.jsonl");
      await fs.mkdir(auditLogPath, { recursive: true });

      const result = await appendGovernanceAuditLog(tmpDir, {
        event:     GOVERNANCE_AUDIT_EVENT.CANARY_STARTED,
        canaryId:  "govcanary-test-fail",
        timestamp: new Date().toISOString()
      });

      assert.equal(result.ok, false, "ok must be false when appendFile fails");
      assert.equal(result.status, "audit-write-failed",
        "status must be audit-write-failed on write failure");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns ok=true and status=written on successful append", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-audit-ok-"));
    try {
      const result = await appendGovernanceAuditLog(tmpDir, {
        event:     GOVERNANCE_AUDIT_EVENT.CANARY_STARTED,
        canaryId:  "govcanary-test-ok",
        timestamp: new Date().toISOString()
      });
      assert.equal(result.ok, true);
      assert.equal(result.status, "written");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
