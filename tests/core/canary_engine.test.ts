/**
 * Tests for T-022: Canary rollout for autonomous config changes.
 *
 * Covers all acceptance criteria with deterministic pass/fail evidence:
 *
 *   AC1:  Canary ratio is configurable and auditable
 *         → canary_audit.jsonl is written with required fields on every event
 *   AC2:  Canary metrics compare against control cohort (named metrics: taskSuccessRate, errorRate)
 *         → collectCanaryMetrics extracts named metrics; aggregateMetricSnapshots aggregates them
 *   AC3:  Automatic promotion requires meeting success thresholds (minTaskSuccessRate, maxErrorRate)
 *         → evaluatePromotion returns promote=true only when both thresholds satisfied
 *   AC4:  Automatic rollback triggers on failure signals (triggerErrorRate, triggerTaskSuccessRateLow)
 *         → evaluateRollback returns rollback=true; rollbackCanary restores controlValue
 *   AC5:  Change provenance includes experiment id
 *         → canary entries carry experimentId and canaryId in ledger and audit log
 *   AC6:  Each criterion maps to at least one explicit verification command (this file)
 *   AC7:  Negative path — failure handling (rollback on high error rate)
 *   AC8:  JSON output and state have defined schemas (CANARY_STATUS, CANARY_AUDIT_EVENT enums)
 *   AC9:  Validation distinguishes MISSING_FIELD from INVALID_VALUE
 *   AC10: No silent fallback — degraded behavior sets explicit status + reason code
 *   AC11: Named metrics: taskSuccessRate, errorRate, workerTimeoutRate
 *   AC12: Promotion thresholds defined with config keys and defaults
 *   AC13: Failure signals defined with rollback trigger + rollback target state
 *   AC14: Audit output contract: log path, event name enum, required fields
 *   AC15: Experiment ID storage: state/canary_ledger.json, format: canary-<sha1-12>
 *   AC16: Feature spans ≥5 files (canary_metrics.js, canary_ledger.js, canary_engine.js,
 *         self_improvement.js, box.config.json)
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  CANARY_METRIC_NAMES,
  DEFAULT_PROMOTION_THRESHOLDS,
  DEFAULT_ROLLBACK_THRESHOLDS,
  collectCanaryMetrics,
  evaluatePromotion,
  evaluateRollback,
  aggregateMetricSnapshots
} from "../../src/core/canary_metrics.js";

import {
  CANARY_STATUS,
  CANARY_AUDIT_EVENT,
  AUDIT_REQUIRED_FIELDS,
  buildCanaryId,
  validateCanaryEntry,
  loadLedger,
  saveLedger,
  appendAuditLog
} from "../../src/core/canary_ledger.js";

import {
  CANARY_DEFAULTS,
  getCanaryConfig,
  startCanary,
  recordMetricSnapshot,
  evaluateAndAdvance,
  promoteCanary,
  rollbackCanary,
  processRunningCanaries
} from "../../src/core/canary_engine.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "box-t022-"));
}

async function writeJson(dir, file, data) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), JSON.stringify(data, null, 2), "utf8");
}

/** Build a minimal runtime config pointing to tmpDir. */
function makeConfig(tmpDir, canaryOverrides = {}) {
  return {
    rootDir: tmpDir,
    paths:   { stateDir: tmpDir },
    canary:  {
      enabled:            true,
      defaultRatio:       0.2,
      minCyclesToObserve: 2,
      promotion: { minTaskSuccessRate: 0.8, maxErrorRate: 0.1 },
      rollback:  { triggerErrorRate: 0.25, triggerTaskSuccessRateLow: 0.5 },
      ...canaryOverrides
    },
    selfImprovement: { experimentEnforcement: "soft" }
  };
}

/** Write a minimal box.config.json so _applyConfigValue has a real file to edit. */
async function writeBoxConfig(tmpDir, extra = {}) {
  const cfg = {
    runtime: { workerTimeoutMinutes: 30, maxRetries: 3 },
    systemGuardian: { staleWorkerMinutes: 20, cooldownMinutes: 30 },
    ...extra
  };
  await writeJson(tmpDir, "box.config.json", cfg);
  return cfg;
}

/** Read back box.config.json from tmpDir. */
async function readBoxConfig(tmpDir) {
  const raw = await fs.readFile(path.join(tmpDir, "box.config.json"), "utf8");
  return JSON.parse(raw);
}

/** Read canary_audit.jsonl and return parsed lines. */
async function readAuditLog(tmpDir) {
  try {
    const raw = await fs.readFile(path.join(tmpDir, "canary_audit.jsonl"), "utf8");
    return raw.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Minimal cycle outcomes with given task and dispatch metrics. */
function makeOutcomes({ totalPlans = 10, completedCount = 8, failures = 1, timeouts = 0, dispatches = 10 } = {}) {
  return {
    totalPlans,
    completedCount,
    workerOutcomes: [
      { totalDispatches: dispatches, failures, timeouts, successes: dispatches - failures - timeouts }
    ]
  };
}

// ── AC8 / AC11: Named metric constants and schema enums ───────────────────────

describe("CANARY_METRIC_NAMES (AC8 / AC11)", () => {
  it("is a frozen object with all three named metric keys", () => {
    assert.ok(Object.isFrozen(CANARY_METRIC_NAMES), "must be frozen");
    assert.equal(CANARY_METRIC_NAMES.TASK_SUCCESS_RATE,   "taskSuccessRate");
    assert.equal(CANARY_METRIC_NAMES.ERROR_RATE,          "errorRate");
    assert.equal(CANARY_METRIC_NAMES.WORKER_TIMEOUT_RATE, "workerTimeoutRate");
  });
});

describe("CANARY_STATUS (AC8)", () => {
  it("is a frozen object with all four status values", () => {
    assert.ok(Object.isFrozen(CANARY_STATUS));
    assert.equal(CANARY_STATUS.RUNNING,     "running");
    assert.equal(CANARY_STATUS.PROMOTED,    "promoted");
    assert.equal(CANARY_STATUS.ROLLED_BACK, "rolled_back");
    assert.equal(CANARY_STATUS.FAILED,      "failed");
  });
});

describe("CANARY_AUDIT_EVENT (AC8 / AC14)", () => {
  it("contains all five required event names", () => {
    assert.ok(Object.isFrozen(CANARY_AUDIT_EVENT));
    assert.equal(CANARY_AUDIT_EVENT.CANARY_STARTED,         "CANARY_STARTED");
    assert.equal(CANARY_AUDIT_EVENT.CANARY_METRIC_SNAPSHOT, "CANARY_METRIC_SNAPSHOT");
    assert.equal(CANARY_AUDIT_EVENT.CANARY_PROMOTED,        "CANARY_PROMOTED");
    assert.equal(CANARY_AUDIT_EVENT.CANARY_ROLLED_BACK,     "CANARY_ROLLED_BACK");
    assert.equal(CANARY_AUDIT_EVENT.CANARY_FAILED,          "CANARY_FAILED");
  });

  it("AUDIT_REQUIRED_FIELDS lists all mandatory audit fields", () => {
    for (const f of ["event", "experimentId", "canaryId", "timestamp", "configPath", "canaryRatio"]) {
      assert.ok(AUDIT_REQUIRED_FIELDS.includes(f), `AUDIT_REQUIRED_FIELDS must include ${f}`);
    }
  });
});

// ── AC12: Default promotion thresholds ────────────────────────────────────────

describe("DEFAULT_PROMOTION_THRESHOLDS (AC12)", () => {
  it("is frozen with correct default values", () => {
    assert.ok(Object.isFrozen(DEFAULT_PROMOTION_THRESHOLDS));
    assert.equal(DEFAULT_PROMOTION_THRESHOLDS.minTaskSuccessRate, 0.8);
    assert.equal(DEFAULT_PROMOTION_THRESHOLDS.maxErrorRate,       0.1);
  });
});

// ── AC13: Default rollback thresholds ─────────────────────────────────────────

describe("DEFAULT_ROLLBACK_THRESHOLDS (AC13)", () => {
  it("is frozen with correct default values", () => {
    assert.ok(Object.isFrozen(DEFAULT_ROLLBACK_THRESHOLDS));
    assert.equal(DEFAULT_ROLLBACK_THRESHOLDS.triggerErrorRate,          0.25);
    assert.equal(DEFAULT_ROLLBACK_THRESHOLDS.triggerTaskSuccessRateLow, 0.5);
  });
});

// ── AC1: Canary config is configurable ────────────────────────────────────────

describe("CANARY_DEFAULTS (AC1 / AC3 / AC12 / AC13)", () => {
  it("exposes defaultRatio as a config key", () => {
    assert.equal(typeof CANARY_DEFAULTS.defaultRatio, "number");
    assert.equal(CANARY_DEFAULTS.defaultRatio, 0.2);
  });

  it("exposes minCyclesToObserve as a config key", () => {
    assert.equal(typeof CANARY_DEFAULTS.minCyclesToObserve, "number");
  });

  it("exposes promotion thresholds with correct keys (AC12)", () => {
    assert.equal(typeof CANARY_DEFAULTS.promotion.minTaskSuccessRate, "number");
    assert.equal(typeof CANARY_DEFAULTS.promotion.maxErrorRate,       "number");
  });

  it("exposes rollback thresholds with correct keys (AC13)", () => {
    assert.equal(typeof CANARY_DEFAULTS.rollback.triggerErrorRate,          "number");
    assert.equal(typeof CANARY_DEFAULTS.rollback.triggerTaskSuccessRateLow, "number");
  });
});

describe("getCanaryConfig (AC1)", () => {
  it("returns defaults when config.canary is absent", () => {
    const cc = getCanaryConfig({});
    assert.equal(cc.defaultRatio,       CANARY_DEFAULTS.defaultRatio);
    assert.equal(cc.minCyclesToObserve, CANARY_DEFAULTS.minCyclesToObserve);
  });

  it("respects overrides from config.canary", () => {
    const cc = getCanaryConfig({ canary: { defaultRatio: 0.5, minCyclesToObserve: 5 } });
    assert.equal(cc.defaultRatio,       0.5);
    assert.equal(cc.minCyclesToObserve, 5);
  });

  it("applies promotion sub-defaults when only some keys are provided", () => {
    const cc = getCanaryConfig({ canary: { promotion: { minTaskSuccessRate: 0.95 } } });
    assert.equal(cc.promotion.minTaskSuccessRate, 0.95);
    assert.equal(cc.promotion.maxErrorRate, CANARY_DEFAULTS.promotion.maxErrorRate);
  });
});

// ── AC2 / AC11: Metric collection ─────────────────────────────────────────────

describe("collectCanaryMetrics (AC2 / AC11)", () => {
  it("computes taskSuccessRate correctly", () => {
    const m = collectCanaryMetrics(makeOutcomes({ totalPlans: 10, completedCount: 8 }));
    assert.equal(m.taskSuccessRate, 0.8);
  });

  it("computes errorRate correctly", () => {
    const m = collectCanaryMetrics(makeOutcomes({ dispatches: 10, failures: 2 }));
    assert.equal(m.errorRate, 0.2);
  });

  it("computes workerTimeoutRate correctly", () => {
    const m = collectCanaryMetrics(makeOutcomes({ dispatches: 10, timeouts: 1, failures: 0 }));
    assert.equal(m.workerTimeoutRate, 0.1);
  });

  it("returns zero metrics for empty outcomes (no NaN propagation)", () => {
    const m = collectCanaryMetrics({});
    assert.equal(m.taskSuccessRate,   0);
    assert.equal(m.errorRate,         0);
    assert.equal(m.workerTimeoutRate, 0);
    assert.equal(m.sampleSize,        0);
  });

  it("handles null outcomes gracefully (AC10 — no silent NaN)", () => {
    const m = collectCanaryMetrics(null);
    assert.equal(m.taskSuccessRate, 0);
    assert.equal(m.errorRate,       0);
  });
});

describe("aggregateMetricSnapshots (AC2)", () => {
  it("averages metrics across snapshots", () => {
    const snaps = [
      { taskSuccessRate: 0.8, errorRate: 0.1, workerTimeoutRate: 0.05 },
      { taskSuccessRate: 0.9, errorRate: 0.0, workerTimeoutRate: 0.0  }
    ];
    const agg = aggregateMetricSnapshots(snaps);
    assert.ok(Math.abs(agg.taskSuccessRate - 0.85) < 1e-10, `expected ~0.85, got ${agg.taskSuccessRate}`);
    assert.ok(Math.abs(agg.errorRate - 0.05)        < 1e-10, `expected ~0.05, got ${agg.errorRate}`);
    assert.equal(agg.totalObservations, 2);
  });

  it("returns zero values for empty snapshots array", () => {
    const agg = aggregateMetricSnapshots([]);
    assert.equal(agg.taskSuccessRate,   0);
    assert.equal(agg.totalObservations, 0);
  });
});

// ── AC3: Promotion threshold evaluation ───────────────────────────────────────

describe("evaluatePromotion (AC3 / AC12)", () => {
  it("returns promote=true when all thresholds are satisfied", () => {
    const result = evaluatePromotion({ taskSuccessRate: 0.9, errorRate: 0.05 });
    assert.equal(result.promote, true);
    assert.equal(result.reason,  "ALL_THRESHOLDS_MET");
  });

  it("returns promote=false when taskSuccessRate is below threshold", () => {
    const result = evaluatePromotion({ taskSuccessRate: 0.7, errorRate: 0.05 });
    assert.equal(result.promote, false);
    assert.ok(result.reason.includes("TASK_SUCCESS_RATE_BELOW_THRESHOLD"));
  });

  it("returns promote=false when errorRate is above threshold", () => {
    const result = evaluatePromotion({ taskSuccessRate: 0.9, errorRate: 0.15 });
    assert.equal(result.promote, false);
    assert.ok(result.reason.includes("ERROR_RATE_ABOVE_THRESHOLD"));
  });

  it("respects custom threshold overrides (AC1 configurable)", () => {
    const result = evaluatePromotion(
      { taskSuccessRate: 0.75, errorRate: 0.05 },
      { minTaskSuccessRate: 0.7, maxErrorRate: 0.2 }
    );
    assert.equal(result.promote, true);
  });
});

// ── AC4: Rollback signal evaluation ───────────────────────────────────────────

describe("evaluateRollback (AC4 / AC7 / AC13)", () => {
  it("returns rollback=false for healthy metrics", () => {
    const result = evaluateRollback({ taskSuccessRate: 0.9, errorRate: 0.05 });
    assert.equal(result.rollback, false);
    assert.equal(result.reason,   null);
  });

  it("returns rollback=true when errorRate exceeds trigger threshold (AC7 — negative path)", () => {
    const result = evaluateRollback({ taskSuccessRate: 0.9, errorRate: 0.30 });
    assert.equal(result.rollback, true);
    assert.ok(result.reason.includes("ROLLBACK_ERROR_RATE_EXCEEDED"), `got: ${result.reason}`);
  });

  it("returns rollback=true when taskSuccessRate is too low (AC7 — negative path)", () => {
    const result = evaluateRollback({ taskSuccessRate: 0.4, errorRate: 0.05 });
    assert.equal(result.rollback, true);
    assert.ok(result.reason.includes("ROLLBACK_SUCCESS_RATE_TOO_LOW"), `got: ${result.reason}`);
  });

  it("respects custom threshold overrides", () => {
    // Custom thresholds lower the trigger → should not rollback even at 0.3 error rate
    const result = evaluateRollback(
      { taskSuccessRate: 0.9, errorRate: 0.30 },
      { triggerErrorRate: 0.5, triggerTaskSuccessRateLow: 0.2 }
    );
    assert.equal(result.rollback, false);
  });
});

// ── AC5 / AC15: Canary ID generation and ledger ───────────────────────────────

describe("buildCanaryId (AC5 / AC15)", () => {
  it("returns a string in format canary-<sha1-12>", () => {
    const id = buildCanaryId("runtime.workerTimeoutMinutes", 45, "2026-01-01T00:00:00.000Z");
    assert.match(id, /^canary-[0-9a-f]{12}$/);
  });

  it("is deterministic for the same inputs", () => {
    const id1 = buildCanaryId("a.b", 42, "2026-01-01T00:00:00Z");
    const id2 = buildCanaryId("a.b", 42, "2026-01-01T00:00:00Z");
    assert.equal(id1, id2);
  });

  it("produces different IDs for different configPaths", () => {
    const id1 = buildCanaryId("a.b", 42, "2026-01-01T00:00:00Z");
    const id2 = buildCanaryId("a.c", 42, "2026-01-01T00:00:00Z");
    assert.notEqual(id1, id2);
  });
});

// ── AC9: validateCanaryEntry distinguishes MISSING_FIELD from INVALID_VALUE ───

describe("validateCanaryEntry (AC9)", () => {
  it("returns ok=true for a complete valid entry", () => {
    const result = validateCanaryEntry({
      canaryId:        "canary-abc123def456",
      configPath:      "runtime.workerTimeoutMinutes",
      canaryRatio:     0.2,
      status:          "running",
      metricSnapshots: [],
      createdAt:       "2026-01-01T00:00:00.000Z"
    });
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("returns MISSING_FIELD code when canaryId is absent (not INVALID_VALUE)", () => {
    const result = validateCanaryEntry({
      configPath: "a.b", canaryRatio: 0.2, status: "running", createdAt: "2026-01-01T00:00:00Z"
    });
    assert.equal(result.ok, false);
    const err = result.errors.find(e => e.field === "canaryId");
    assert.ok(err, "error for canaryId must exist");
    assert.equal(err.code, "MISSING_FIELD");
  });

  it("returns INVALID_VALUE code when canaryRatio is out of range (not MISSING_FIELD)", () => {
    const result = validateCanaryEntry({
      canaryId: "canary-abc", configPath: "a.b", canaryRatio: 1.5,
      status: "running", createdAt: "2026-01-01T00:00:00Z"
    });
    assert.equal(result.ok, false);
    const err = result.errors.find(e => e.field === "canaryRatio");
    assert.ok(err, "error for canaryRatio must exist");
    assert.equal(err.code, "INVALID_VALUE");
  });

  it("returns INVALID_VALUE code for unknown status (not MISSING_FIELD)", () => {
    const result = validateCanaryEntry({
      canaryId: "canary-abc", configPath: "a.b", canaryRatio: 0.2,
      status: "unknown_status", createdAt: "2026-01-01T00:00:00Z"
    });
    const err = result.errors.find(e => e.field === "status");
    assert.ok(err);
    assert.equal(err.code, "INVALID_VALUE");
  });

  it("returns error for null input (MISSING_FIELD on root)", () => {
    const result = validateCanaryEntry(null);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].field, "root");
    assert.equal(result.errors[0].code,  "MISSING_FIELD");
  });
});

// ── AC1 / AC14: Audit log output contract ────────────────────────────────────

describe("appendAuditLog (AC1 / AC14)", () => {
  let tmpDir;

  before(async () => { tmpDir = await makeTmpDir(); });
  after(async  () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("writes a valid JSONL line to canary_audit.jsonl", async () => {
    await appendAuditLog(tmpDir, {
      event:        CANARY_AUDIT_EVENT.CANARY_STARTED,
      experimentId: "exp-abc",
      canaryId:     "canary-123",
      timestamp:    "2026-01-01T00:00:00Z",
      configPath:   "runtime.workerTimeoutMinutes",
      canaryRatio:  0.2,
      metrics:      null,
      reason:       null
    });

    const lines = await readAuditLog(tmpDir);
    assert.equal(lines.length, 1);
    const entry = lines[0];
    assert.equal(entry.event,      CANARY_AUDIT_EVENT.CANARY_STARTED);
    assert.equal(entry.canaryId,   "canary-123");
    assert.equal(entry.configPath, "runtime.workerTimeoutMinutes");
    assert.equal(entry.canaryRatio, 0.2);
  });

  it("appends multiple lines (not overwrites)", async () => {
    await appendAuditLog(tmpDir, {
      event: CANARY_AUDIT_EVENT.CANARY_PROMOTED, experimentId: "e1",
      canaryId: "canary-456", timestamp: "2026-01-02T00:00:00Z",
      configPath: "a.b", canaryRatio: 0.5, metrics: null, reason: "ALL_THRESHOLDS_MET"
    });
    const lines = await readAuditLog(tmpDir);
    assert.ok(lines.length >= 2, "audit log must accumulate entries");
  });

  it("sets auditError field when required fields are missing (AC10 — no silent failure)", async () => {
    const dir2 = await makeTmpDir();
    try {
      await appendAuditLog(dir2, {
        event: CANARY_AUDIT_EVENT.CANARY_STARTED,
        // Missing: experimentId, canaryId, configPath, canaryRatio
        timestamp: "2026-01-01T00:00:00Z"
      });
      const lines = await readAuditLog(dir2);
      assert.equal(lines.length, 1);
      assert.ok(lines[0].auditError, "missing fields must produce auditError on the entry");
      assert.ok(lines[0].auditError.startsWith("MISSING_REQUIRED_FIELDS:"), `got: ${lines[0].auditError}`);
    } finally {
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });
});

// ── AC1 / AC5 / AC15: startCanary ────────────────────────────────────────────

describe("startCanary (AC1 / AC5 / AC15)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await makeTmpDir();
    await writeBoxConfig(tmpDir);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns ok=true and a canary-<sha1-12> canaryId", async () => {
    const config = makeConfig(tmpDir);
    const result = await startCanary(config, "runtime.workerTimeoutMinutes", 30, 45, "exp-abc");
    assert.equal(result.ok, true);
    assert.match(result.canaryId, /^canary-[0-9a-f]{12}$/, "canaryId must match format (AC15)");
  });

  it("writes canary value to box.config.json immediately", async () => {
    const boxCfg = await readBoxConfig(tmpDir);
    assert.equal(boxCfg.runtime.workerTimeoutMinutes, 45,
      "canary value must be applied to box.config.json");
  });

  it("records entry in canary_ledger.json with controlValue (rollback target AC4)", async () => {
    const ledger = await loadLedger(tmpDir);
    const entry  = ledger.experiments.find(e => e.configPath === "runtime.workerTimeoutMinutes");
    assert.ok(entry, "ledger entry must exist");
    assert.equal(entry.controlValue,  30,        "controlValue is the rollback target");
    assert.equal(entry.canaryValue,   45);
    assert.equal(entry.status,        CANARY_STATUS.RUNNING);
    assert.equal(entry.experimentId,  "exp-abc", "experiment ID provenance (AC5)");
    assert.equal(typeof entry.canaryRatio, "number");
  });

  it("emits CANARY_STARTED audit event (AC1 / AC14)", async () => {
    const lines = await readAuditLog(tmpDir);
    const evt   = lines.find(l => l.event === CANARY_AUDIT_EVENT.CANARY_STARTED);
    assert.ok(evt, "CANARY_STARTED audit event must exist");
    assert.equal(evt.configPath,  "runtime.workerTimeoutMinutes");
    assert.equal(evt.experimentId, "exp-abc");
    assert.equal(typeof evt.canaryRatio, "number");
  });

  it("returns ALREADY_RUNNING when a canary for the same path exists (AC10 — explicit status)", async () => {
    const config = makeConfig(tmpDir);
    const result = await startCanary(config, "runtime.workerTimeoutMinutes", 30, 50, null);
    assert.equal(result.ok,     false);
    assert.equal(result.status, "ALREADY_RUNNING");
    assert.ok(result.canaryId, "ALREADY_RUNNING must include the existing canaryId");
  });

  it("returns CANARY_DISABLED when canary.enabled=false (AC10 — explicit status)", async () => {
    const dir2   = await makeTmpDir();
    await writeBoxConfig(dir2);
    const config = makeConfig(dir2, { enabled: false });
    const result = await startCanary(config, "runtime.workerTimeoutMinutes", 30, 45, null);
    assert.equal(result.ok,     false);
    assert.equal(result.status, "CANARY_DISABLED");
    await fs.rm(dir2, { recursive: true, force: true });
  });
});

// ── AC2 / AC3 / AC4: recordMetricSnapshot + evaluateAndAdvance ────────────────

describe("evaluateAndAdvance — promote path (AC2 / AC3)", () => {
  let tmpDir;
  let canaryId;

  before(async () => {
    tmpDir = await makeTmpDir();
    await writeBoxConfig(tmpDir);
    const config = makeConfig(tmpDir, { minCyclesToObserve: 2, defaultRatio: 1.0 });
    const result = await startCanary(config, "runtime.maxRetries", 3, 5, "exp-promote-001");
    canaryId = result.canaryId;
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("action=continue before enough snapshots", async () => {
    // With defaultRatio=1.0, effectiveCycles = ceil(2/1) = 2. Zero snapshots so far.
    const config = makeConfig(tmpDir, { minCyclesToObserve: 2, defaultRatio: 1.0 });
    const result = await evaluateAndAdvance(config, canaryId);
    // No snapshots yet → continue
    assert.equal(result.ok,     true);
    assert.equal(result.action, "continue");
  });

  it("records snapshot and advances to promote after minCyclesToObserve (AC3)", async () => {
    const config  = makeConfig(tmpDir, { minCyclesToObserve: 2, defaultRatio: 1.0 });
    const stateDir = tmpDir;
    const goodMetrics = { taskSuccessRate: 0.9, errorRate: 0.02, workerTimeoutRate: 0.0 };

    // Add 2 good snapshots
    await recordMetricSnapshot(stateDir, canaryId, goodMetrics, "cycle-1");
    await recordMetricSnapshot(stateDir, canaryId, goodMetrics, "cycle-2");

    const result = await evaluateAndAdvance(config, canaryId);
    assert.equal(result.ok,     true);
    assert.equal(result.action, "promote", `expected promote, got ${result.action}: ${result.reason}`);
  });

  it("ledger entry is marked as promoted after evaluation (AC3)", async () => {
    const ledger = await loadLedger(tmpDir);
    const entry  = ledger.experiments.find(e => e.canaryId === canaryId);
    assert.ok(entry, "ledger entry must exist");
    assert.equal(entry.status, CANARY_STATUS.PROMOTED);
    assert.ok(entry.promotedAt, "promotedAt must be set");
  });

  it("CANARY_PROMOTED audit event is written (AC1 / AC14)", async () => {
    const lines = await readAuditLog(tmpDir);
    const evt   = lines.find(l => l.event === CANARY_AUDIT_EVENT.CANARY_PROMOTED);
    assert.ok(evt, "CANARY_PROMOTED audit event must be written");
    assert.equal(evt.experimentId, "exp-promote-001");
  });
});

describe("evaluateAndAdvance — rollback path / negative path (AC4 / AC7 / AC13)", () => {
  let tmpDir;
  let canaryId;

  before(async () => {
    tmpDir = await makeTmpDir();
    await writeBoxConfig(tmpDir);
    const config = makeConfig(tmpDir, { minCyclesToObserve: 2, defaultRatio: 1.0 });
    const result = await startCanary(config, "runtime.workerTimeoutMinutes", 30, 60, "exp-rollback-001");
    canaryId = result.canaryId;
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("immediately triggers rollback when latest snapshot has error rate above trigger threshold (AC4 / AC7)", async () => {
    const config     = makeConfig(tmpDir, { minCyclesToObserve: 2, defaultRatio: 1.0 });
    const badMetrics = { taskSuccessRate: 0.9, errorRate: 0.40, workerTimeoutRate: 0.1 };

    await recordMetricSnapshot(tmpDir, canaryId, badMetrics, "bad-cycle-1");
    const result = await evaluateAndAdvance(config, canaryId);

    assert.equal(result.ok,     true);
    assert.equal(result.action, "rollback", `expected rollback, got ${result.action}: ${result.reason}`);
    assert.ok(result.reason.includes("ROLLBACK_ERROR_RATE_EXCEEDED"), `reason: ${result.reason}`);
  });

  it("restores controlValue to box.config.json on rollback (AC4 — rollback target state)", async () => {
    const boxCfg = await readBoxConfig(tmpDir);
    assert.equal(boxCfg.runtime.workerTimeoutMinutes, 30,
      "box.config.json must be reverted to controlValue=30");
  });

  it("ledger entry is marked rolled_back with explicit reason (AC10)", async () => {
    const ledger = await loadLedger(tmpDir);
    const entry  = ledger.experiments.find(e => e.canaryId === canaryId);
    assert.equal(entry.status, CANARY_STATUS.ROLLED_BACK);
    assert.ok(entry.statusReason, "statusReason must be non-null when rolled back");
  });

  it("CANARY_ROLLED_BACK audit event is written (AC1 / AC14)", async () => {
    const lines = await readAuditLog(tmpDir);
    const evt   = lines.find(l => l.event === CANARY_AUDIT_EVENT.CANARY_ROLLED_BACK);
    assert.ok(evt, "CANARY_ROLLED_BACK audit event must be written");
    assert.equal(evt.experimentId, "exp-rollback-001");
  });
});

// ── AC4: rollback on low taskSuccessRate (second failure signal) ──────────────

describe("evaluateAndAdvance — rollback on low taskSuccessRate (AC4 / AC7)", () => {
  let tmpDir;
  let canaryId;

  before(async () => {
    tmpDir = await makeTmpDir();
    await writeBoxConfig(tmpDir);
    const config = makeConfig(tmpDir, { minCyclesToObserve: 2, defaultRatio: 1.0 });
    const result = await startCanary(config, "systemGuardian.staleWorkerMinutes", 20, 40, null);
    canaryId = result.canaryId;
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("triggers rollback when taskSuccessRate is too low (AC7 — negative path)", async () => {
    const config     = makeConfig(tmpDir, { minCyclesToObserve: 2, defaultRatio: 1.0 });
    const badMetrics = { taskSuccessRate: 0.3, errorRate: 0.05, workerTimeoutRate: 0.0 };

    await recordMetricSnapshot(tmpDir, canaryId, badMetrics, "low-success-cycle");
    const result = await evaluateAndAdvance(config, canaryId);

    assert.equal(result.action, "rollback");
    assert.ok(result.reason.includes("ROLLBACK_SUCCESS_RATE_TOO_LOW"), `reason: ${result.reason}`);
  });
});

// ── AC3: rollback when promotion thresholds not met after observation window ──

describe("evaluateAndAdvance — rollback on insufficient metrics after window (AC3)", () => {
  let tmpDir;
  let canaryId;

  before(async () => {
    tmpDir = await makeTmpDir();
    await writeBoxConfig(tmpDir);
    const config = makeConfig(tmpDir, { minCyclesToObserve: 2, defaultRatio: 1.0 });
    const result = await startCanary(config, "systemGuardian.cooldownMinutes", 30, 25, "exp-below-thresh");
    canaryId = result.canaryId;
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("rolls back after observation window when averaged metrics are below promotion threshold", async () => {
    const config      = makeConfig(tmpDir, { minCyclesToObserve: 2, defaultRatio: 1.0 });
    // Mediocre metrics: errorRate within rollback threshold but below promotion threshold
    const medioMetrics = { taskSuccessRate: 0.70, errorRate: 0.12, workerTimeoutRate: 0.0 };

    await recordMetricSnapshot(tmpDir, canaryId, medioMetrics, "c1");
    await recordMetricSnapshot(tmpDir, canaryId, medioMetrics, "c2");

    const result = await evaluateAndAdvance(config, canaryId);
    assert.equal(result.action, "rollback", `expected rollback, got ${result.action}: ${result.reason}`);
  });
});

// ── AC2: processRunningCanaries integrates metrics from outcomes ───────────────

describe("processRunningCanaries (AC2 / AC3 / AC4)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await makeTmpDir();
    await writeBoxConfig(tmpDir);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns empty array when canary is disabled", async () => {
    const config   = makeConfig(tmpDir, { enabled: false });
    const outcomes = makeOutcomes({ totalPlans: 5, completedCount: 4 });
    const results  = await processRunningCanaries(config, outcomes, "c0");
    assert.deepEqual(results, []);
  });

  it("returns empty array when no experiments are running", async () => {
    const config   = makeConfig(tmpDir);
    const outcomes = makeOutcomes();
    const results  = await processRunningCanaries(config, outcomes, "c1");
    assert.deepEqual(results, []);
  });

  it("processes running canaries and returns action results", async () => {
    const dir2   = await makeTmpDir();
    await writeBoxConfig(dir2);
    const config = makeConfig(dir2, { minCyclesToObserve: 2, defaultRatio: 1.0 });

    // Start a canary
    await startCanary(config, "runtime.workerTimeoutMinutes", 30, 35, "exp-process-test");

    // processRunningCanaries with good outcomes → snapshot + continue (only 1 snapshot)
    const goodOutcomes = makeOutcomes({ totalPlans: 10, completedCount: 9, failures: 0 });
    const results      = await processRunningCanaries(config, goodOutcomes, "test-cycle");

    assert.equal(results.length, 1, "one running canary → one result");
    assert.equal(typeof results[0].canaryId, "string");
    assert.ok(["continue", "promote", "rollback"].includes(results[0].action),
      `action must be a valid state: ${results[0].action}`);

    await fs.rm(dir2, { recursive: true, force: true });
  });
});

// ── AC10: NOT_FOUND and NOT_RUNNING return explicit status (no silent failure) ─

describe("recordMetricSnapshot error handling (AC10)", () => {
  let tmpDir;

  before(async () => { tmpDir = await makeTmpDir(); });
  after(async  () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns ok=false with status=NOT_FOUND for unknown canaryId", async () => {
    const result = await recordMetricSnapshot(tmpDir, "canary-nonexistent", {}, null);
    assert.equal(result.ok,     false);
    assert.equal(result.status, "NOT_FOUND");
  });

  it("returns ok=false with status=NOT_RUNNING when entry is not in running state", async () => {
    // Manually insert a promoted entry
    const ledger = await loadLedger(tmpDir);
    ledger.experiments.push({
      canaryId: "canary-promoted-test", experimentId: null, configPath: "x.y",
      controlValue: 1, canaryValue: 2, canaryRatio: 0.2, status: CANARY_STATUS.PROMOTED,
      statusReason: null, metricSnapshots: [], createdAt: new Date().toISOString(),
      promotedAt: new Date().toISOString(), rolledBackAt: null
    });
    await saveLedger(tmpDir, ledger);

    const result = await recordMetricSnapshot(tmpDir, "canary-promoted-test", {}, null);
    assert.equal(result.ok,     false);
    assert.equal(result.status, "NOT_RUNNING");
  });
});

describe("promoteCanary / rollbackCanary — NOT_FOUND handling (AC10)", () => {
  let tmpDir;

  before(async () => { tmpDir = await makeTmpDir(); });
  after(async  () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("promoteCanary returns ok=false / NOT_FOUND for unknown canaryId", async () => {
    const config = makeConfig(tmpDir);
    const result = await promoteCanary(config, "canary-unknown-xyz");
    assert.equal(result.ok,     false);
    assert.equal(result.status, "NOT_FOUND");
  });

  it("rollbackCanary returns ok=false / NOT_FOUND for unknown canaryId", async () => {
    const config = makeConfig(tmpDir);
    const result = await rollbackCanary(config, "canary-unknown-xyz");
    assert.equal(result.ok,     false);
    assert.equal(result.status, "NOT_FOUND");
  });
});
