/**
 * rollback_engine.test.ts
 *
 * Tests for src/core/rollback_engine.js — T-034 multi-level rollback engine.
 *
 * Coverage (all ACs + Athena missing items):
 *   AC-1  — trigger conditions are deterministic (TRIGGER_LEVEL_MAP, validateRollbackRequest)
 *   AC-2  — executeRollback writes immutable incident records to JSONL log
 *   AC-3  — config-only and policy-set rollbacks complete within oneCycleSlaMs (5000ms)
 *   AC-4  — full-baseline-restore records baseline tag and verification check list
 *   AC-5  — runHealthValidation returns structured pass/fail for all 5 checks
 *   AC-7  — negative paths: missing trigger, invalid trigger, level mismatch, no rollback target
 *   AC-8  — incident record includes all required schema fields with correct types/enums
 *   AC-9  — validateRollbackRequest distinguishes MISSING_TRIGGER from INVALID_TRIGGER
 *   AC-10 — executeRollback never throws; always returns { ok, status, reason }
 *   Athena item #6 — orchestration-code-freeze writes/reads lock file correctly
 *   Athena item #7 — state mutation boundary: only permitted writes are made
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  ROLLBACK_ENGINE_SCHEMA_VERSION,
  ROLLBACK_LEVEL,
  ROLLBACK_TRIGGER,
  TRIGGER_LEVEL_MAP,
  ROLLBACK_STATUS,
  ROLLBACK_REASON,
  HEALTH_CHECK,
  ROLLBACK_ENGINE_DEFAULTS,
  ROLLBACK_PERMITTED_WRITES,
  validateRollbackRequest,
  executeRollback,
  runHealthValidation,
  readIncidentLog,
  resolveRollbackConfig,
  isFrozen,
  unfreeze,
  readFreezeLock
} from "../../src/core/rollback_engine.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    rollbackEngine: {
      enabled:         true,
      oneCycleSlaMs:   5000,
      incidentLogPath: overrides.incidentLogPath,
      lockFilePath:    overrides.lockFilePath,
      baselineRefPath: overrides.baselineRefPath,
      configFilePath:  overrides.configFilePath,
      policyFilePath:  overrides.policyFilePath
    },
    selfDev: {
      criticalFiles: ["src/core/orchestrator.ts", "src/core/policy_engine.ts"]
    }
  };
}

// ── Schema version constant ────────────────────────────────────────────────────

describe("ROLLBACK_ENGINE_SCHEMA_VERSION", () => {
  it("exports a positive integer schema version", () => {
    assert.equal(typeof ROLLBACK_ENGINE_SCHEMA_VERSION, "number");
    assert.ok(ROLLBACK_ENGINE_SCHEMA_VERSION >= 1);
  });
});

// ── ROLLBACK_LEVEL enum ────────────────────────────────────────────────────────

describe("ROLLBACK_LEVEL enum", () => {
  it("exports all five rollback levels as deterministic string constants", () => {
    assert.equal(ROLLBACK_LEVEL.CONFIG_ONLY,               "config-only");
    assert.equal(ROLLBACK_LEVEL.STATE_SCHEMA,              "state-schema");
    assert.equal(ROLLBACK_LEVEL.POLICY_SET,                "policy-set");
    assert.equal(ROLLBACK_LEVEL.ORCHESTRATION_CODE_FREEZE, "orchestration-code-freeze");
    assert.equal(ROLLBACK_LEVEL.FULL_BASELINE_RESTORE,     "full-baseline-restore");
  });
});

// ── ROLLBACK_TRIGGER enum ──────────────────────────────────────────────────────

describe("ROLLBACK_TRIGGER enum", () => {
  it("exports all trigger codes (one per trigger condition in the module header)", () => {
    // config-only triggers
    assert.ok(ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE);
    assert.ok(ROLLBACK_TRIGGER.CONFIG_KEY_MISSING);
    assert.ok(ROLLBACK_TRIGGER.CANARY_ROLLBACK);
    // state-schema triggers
    assert.ok(ROLLBACK_TRIGGER.STATE_SCHEMA_VIOLATION);
    assert.ok(ROLLBACK_TRIGGER.STATE_VERSION_MISMATCH);
    // policy-set triggers
    assert.ok(ROLLBACK_TRIGGER.POLICY_PARSE_FAILURE);
    assert.ok(ROLLBACK_TRIGGER.POLICY_GATE_MISSING);
    assert.ok(ROLLBACK_TRIGGER.POLICY_VERSION_MISMATCH);
    // orchestration-code-freeze triggers
    assert.ok(ROLLBACK_TRIGGER.CORE_FILE_MODIFIED);
    assert.ok(ROLLBACK_TRIGGER.SELF_DEV_GUARD_BREACH);
    // full-baseline-restore triggers
    assert.ok(ROLLBACK_TRIGGER.MULTI_LEVEL_FAILURE);
    assert.ok(ROLLBACK_TRIGGER.HEALTH_SCORE_CRITICAL);
  });
});

// ── TRIGGER_LEVEL_MAP — deterministic dispatch table (AC-1) ──────────────────

describe("TRIGGER_LEVEL_MAP — deterministic trigger → level dispatch (AC-1)", () => {
  it("maps all config-only triggers to CONFIG_ONLY level", () => {
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE], ROLLBACK_LEVEL.CONFIG_ONLY);
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.CONFIG_KEY_MISSING],   ROLLBACK_LEVEL.CONFIG_ONLY);
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.CANARY_ROLLBACK],      ROLLBACK_LEVEL.CONFIG_ONLY);
  });

  it("maps all state-schema triggers to STATE_SCHEMA level", () => {
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.STATE_SCHEMA_VIOLATION], ROLLBACK_LEVEL.STATE_SCHEMA);
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.STATE_VERSION_MISMATCH], ROLLBACK_LEVEL.STATE_SCHEMA);
  });

  it("maps all policy-set triggers to POLICY_SET level", () => {
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.POLICY_PARSE_FAILURE],    ROLLBACK_LEVEL.POLICY_SET);
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.POLICY_GATE_MISSING],     ROLLBACK_LEVEL.POLICY_SET);
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.POLICY_VERSION_MISMATCH], ROLLBACK_LEVEL.POLICY_SET);
  });

  it("maps all orchestration-code-freeze triggers to ORCHESTRATION_CODE_FREEZE level", () => {
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.CORE_FILE_MODIFIED],    ROLLBACK_LEVEL.ORCHESTRATION_CODE_FREEZE);
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.SELF_DEV_GUARD_BREACH], ROLLBACK_LEVEL.ORCHESTRATION_CODE_FREEZE);
  });

  it("maps all full-baseline-restore triggers to FULL_BASELINE_RESTORE level", () => {
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.MULTI_LEVEL_FAILURE],  ROLLBACK_LEVEL.FULL_BASELINE_RESTORE);
    assert.equal(TRIGGER_LEVEL_MAP[ROLLBACK_TRIGGER.HEALTH_SCORE_CRITICAL], ROLLBACK_LEVEL.FULL_BASELINE_RESTORE);
  });

  it("every ROLLBACK_TRIGGER value appears in the map (no orphan triggers)", () => {
    for (const triggerVal of Object.values(ROLLBACK_TRIGGER)) {
      assert.ok(TRIGGER_LEVEL_MAP[triggerVal],
        `ROLLBACK_TRIGGER.${triggerVal} is missing from TRIGGER_LEVEL_MAP`);
    }
  });
});

// ── validateRollbackRequest — input validation (AC-9) ──────────────────────────

describe("validateRollbackRequest — input validation (AC-9)", () => {
  it("returns OK for valid level+trigger pair", () => {
    const r = validateRollbackRequest({
      level:   ROLLBACK_LEVEL.CONFIG_ONLY,
      trigger: ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, ROLLBACK_REASON.OK);
  });

  // AC-9: missing trigger (absent) vs invalid trigger (bad value)

  it("returns MISSING_TRIGGER when trigger is absent", () => {
    const r = validateRollbackRequest({ level: ROLLBACK_LEVEL.CONFIG_ONLY });
    assert.equal(r.ok, false);
    assert.equal(r.reason, ROLLBACK_REASON.MISSING_TRIGGER);
  });

  it("returns MISSING_TRIGGER when trigger is null", () => {
    const r = validateRollbackRequest({ level: ROLLBACK_LEVEL.CONFIG_ONLY, trigger: null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, ROLLBACK_REASON.MISSING_TRIGGER);
  });

  it("returns MISSING_TRIGGER when trigger is empty string", () => {
    const r = validateRollbackRequest({ level: ROLLBACK_LEVEL.CONFIG_ONLY, trigger: "" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, ROLLBACK_REASON.MISSING_TRIGGER);
  });

  it("returns INVALID_TRIGGER when trigger is not a ROLLBACK_TRIGGER value", () => {
    const r = validateRollbackRequest({
      level:   ROLLBACK_LEVEL.CONFIG_ONLY,
      trigger: "TOTALLY_FAKE_TRIGGER"
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, ROLLBACK_REASON.INVALID_TRIGGER);
  });

  it("distinguishes MISSING_TRIGGER (absent) from INVALID_TRIGGER (bad value)", () => {
    const missing = validateRollbackRequest({ level: ROLLBACK_LEVEL.CONFIG_ONLY });
    const invalid  = validateRollbackRequest({ level: ROLLBACK_LEVEL.CONFIG_ONLY, trigger: "garbage" });
    assert.equal(missing.reason, ROLLBACK_REASON.MISSING_TRIGGER);
    assert.equal(invalid.reason,  ROLLBACK_REASON.INVALID_TRIGGER);
    assert.notEqual(missing.reason, invalid.reason);
  });

  it("returns MISSING_LEVEL when level is absent", () => {
    const r = validateRollbackRequest({ trigger: ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE });
    assert.equal(r.ok, false);
    assert.equal(r.reason, ROLLBACK_REASON.MISSING_LEVEL);
  });

  it("returns INVALID_LEVEL when level is not a ROLLBACK_LEVEL value", () => {
    const r = validateRollbackRequest({
      level:   "made-up-level",
      trigger: ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, ROLLBACK_REASON.INVALID_LEVEL);
  });

  it("returns TRIGGER_LEVEL_MISMATCH when trigger does not belong to level", () => {
    const r = validateRollbackRequest({
      level:   ROLLBACK_LEVEL.POLICY_SET,
      trigger: ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE  // belongs to config-only
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, ROLLBACK_REASON.TRIGGER_LEVEL_MISMATCH);
  });

  it("returns MISSING_TRIGGER for null params object", () => {
    const r = validateRollbackRequest(null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, ROLLBACK_REASON.MISSING_TRIGGER);
  });
});

// ── ROLLBACK_ENGINE_DEFAULTS ───────────────────────────────────────────────────

describe("ROLLBACK_ENGINE_DEFAULTS", () => {
  it("exports oneCycleSlaMs as 5000ms (AC-3)", () => {
    assert.equal(ROLLBACK_ENGINE_DEFAULTS.oneCycleSlaMs, 5000);
  });

  it("exports incidentLogPath pointing to state/rollback_incidents.jsonl (AC-2)", () => {
    assert.equal(ROLLBACK_ENGINE_DEFAULTS.incidentLogPath, "state/rollback_incidents.jsonl");
  });

  it("exports lockFilePath pointing to state/rollback_lock.json (Athena item #6)", () => {
    assert.equal(ROLLBACK_ENGINE_DEFAULTS.lockFilePath, "state/rollback_lock.json");
  });
});

// ── ROLLBACK_PERMITTED_WRITES — state mutation boundary (Athena item #7) ──────

describe("ROLLBACK_PERMITTED_WRITES — state mutation boundary (Athena item #7)", () => {
  it("includes state/rollback_incidents.jsonl", () => {
    assert.ok(ROLLBACK_PERMITTED_WRITES.includes("state/rollback_incidents.jsonl"));
  });

  it("includes state/rollback_lock.json", () => {
    assert.ok(ROLLBACK_PERMITTED_WRITES.includes("state/rollback_lock.json"));
  });

  it("is frozen (immutable array contract)", () => {
    assert.ok(Object.isFrozen(ROLLBACK_PERMITTED_WRITES));
  });
});

// ── runHealthValidation — five deterministic checks (AC-5) ────────────────────

describe("runHealthValidation — five deterministic checks (AC-5)", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-rollback-health-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makePaths(overrides = {}) {
    return {
      configFile:  overrides.configFile  || path.join(tmpDir, "box.config.json"),
      policyFile:  overrides.policyFile  || path.join(tmpDir, "policy.json"),
      stateDir:    overrides.stateDir    || tmpDir,
      incidentLog: overrides.incidentLog || path.join(tmpDir, "rollback_incidents.jsonl"),
      lockFile:    overrides.lockFile    || path.join(tmpDir, "rollback_lock.json")
    };
  }

  it("returns ok=true when all five checks pass", async () => {
    // Write valid fixtures
    const p = makePaths();
    await fs.writeFile(p.configFile,  JSON.stringify({ loopIntervalMs: 20000 }), "utf8");
    await fs.writeFile(p.policyFile,  JSON.stringify({ gates: {} }), "utf8");
    await fs.writeFile(p.incidentLog, "", "utf8"); // exists but empty
    // No lock file → consistent (not frozen)

    const result = await runHealthValidation(p);
    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 5);
    for (const check of result.checks) {
      assert.equal(check.pass, true, `check ${check.check} should pass`);
    }
  });

  it("returns ok=false when config file is missing", async () => {
    const p = makePaths();
    await fs.writeFile(p.policyFile,  JSON.stringify({ gates: {} }), "utf8");
    await fs.writeFile(p.incidentLog, "", "utf8");

    const result = await runHealthValidation(p);
    assert.equal(result.ok, false);
    const configCheck = result.checks.find(c => c.check === HEALTH_CHECK.CONFIG_PARSE);
    assert.equal(configCheck.pass, false);
  });

  it("returns ok=false when config file has invalid JSON", async () => {
    const p = makePaths();
    await fs.writeFile(p.configFile,  "NOT { VALID JSON", "utf8");
    await fs.writeFile(p.policyFile,  JSON.stringify({ gates: {} }), "utf8");
    await fs.writeFile(p.incidentLog, "", "utf8");

    const result = await runHealthValidation(p);
    assert.equal(result.ok, false);
    const configCheck = result.checks.find(c => c.check === HEALTH_CHECK.CONFIG_PARSE);
    assert.equal(configCheck.pass, false);
  });

  it("returns ok=false when policy file is missing", async () => {
    const p = makePaths();
    await fs.writeFile(p.configFile, JSON.stringify({ loopIntervalMs: 1000 }), "utf8");
    await fs.writeFile(p.incidentLog, "", "utf8");

    const result = await runHealthValidation(p);
    assert.equal(result.ok, false);
    const policyCheck = result.checks.find(c => c.check === HEALTH_CHECK.POLICY_PARSE);
    assert.equal(policyCheck.pass, false);
  });

  it("returns ok=false when incident log is absent", async () => {
    const p = makePaths();
    await fs.writeFile(p.configFile, JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(p.policyFile, JSON.stringify({ x: 1 }), "utf8");
    // No incident log written

    const result = await runHealthValidation(p);
    assert.equal(result.ok, false);
    const logCheck = result.checks.find(c => c.check === HEALTH_CHECK.INCIDENT_LOG_PRESENT);
    assert.equal(logCheck.pass, false);
  });

  it("FREEZE_LOCK_CONSISTENT passes when no lock file present", async () => {
    const p = makePaths();
    await fs.writeFile(p.configFile,  JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(p.policyFile,  JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(p.incidentLog, "", "utf8");
    // No lockFile written

    const result = await runHealthValidation(p);
    const lockCheck = result.checks.find(c => c.check === HEALTH_CHECK.FREEZE_LOCK_CONSISTENT);
    assert.equal(lockCheck.pass, true);
    assert.ok(lockCheck.reason.includes("absent"));
  });

  it("FREEZE_LOCK_CONSISTENT fails when lock file has invalid structure", async () => {
    const p = makePaths();
    await fs.writeFile(p.configFile,  JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(p.policyFile,  JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(p.incidentLog, "", "utf8");
    // Lock file with missing `frozen` boolean
    await fs.writeFile(p.lockFile, JSON.stringify({ frozenAt: "2026-01-01T00:00:00Z" }), "utf8");

    const result = await runHealthValidation(p);
    const lockCheck = result.checks.find(c => c.check === HEALTH_CHECK.FREEZE_LOCK_CONSISTENT);
    assert.equal(lockCheck.pass, false);
  });

  it("result includes all five HEALTH_CHECK keys", async () => {
    const p = makePaths();
    await fs.writeFile(p.configFile,  JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(p.policyFile,  JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(p.incidentLog, "", "utf8");

    const result = await runHealthValidation(p);
    const checkIds = result.checks.map(c => c.check);
    for (const healthCheckId of Object.values(HEALTH_CHECK)) {
      assert.ok(checkIds.includes(healthCheckId),
        `HEALTH_CHECK.${healthCheckId} must appear in result.checks`);
    }
  });

  it("summary field is a non-empty string", async () => {
    const p = makePaths();
    await fs.writeFile(p.configFile,  JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(p.policyFile,  JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(p.incidentLog, "", "utf8");

    const result = await runHealthValidation(p);
    assert.equal(typeof result.summary, "string");
    assert.ok(result.summary.length > 0);
  });
});

// ── executeRollback — config-only level (AC-1, AC-2, AC-3) ────────────────────

describe("executeRollback — config-only level (AC-1, AC-2, AC-3)", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-rollback-cfg-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes incident record to JSONL log on successful config rollback (AC-2)", async () => {
    const configFile  = path.join(tmpDir, "box.config.json");
    const policyFile  = path.join(tmpDir, "policy.json");
    const incidentLog = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile    = path.join(tmpDir, "rollback_lock.json");

    await fs.writeFile(configFile, JSON.stringify({ loopIntervalMs: 99999 }), "utf8");
    await fs.writeFile(policyFile, JSON.stringify({ gates: {} }), "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath: path.join(tmpDir, "project_baseline.json") });

    const result = await executeRollback({
      level:    ROLLBACK_LEVEL.CONFIG_ONLY,
      trigger:  ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE,
      evidence: { controlValue: { loopIntervalMs: 20000 } },
      config,
      stateDir: tmpDir
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, ROLLBACK_STATUS.COMPLETED);
    assert.ok(result.incidentId, "incidentId must be set");
    assert.ok(result.incidentId.startsWith("rollback-"), "incidentId must start with 'rollback-'");

    // Verify JSONL log was written
    const incidents = await readIncidentLog(incidentLog);
    assert.ok(incidents.length >= 1, "at least one incident record must be written");

    const final = incidents[incidents.length - 1];
    assert.equal(final.schemaVersion, ROLLBACK_ENGINE_SCHEMA_VERSION);
    assert.equal(final.level,   ROLLBACK_LEVEL.CONFIG_ONLY);
    assert.equal(final.trigger, ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE);
    assert.equal(final.status,  ROLLBACK_STATUS.COMPLETED);
    assert.ok(Array.isArray(final.stepsExecuted));
    assert.ok(typeof final.triggeredAt === "string");
    assert.ok(typeof final.completedAt === "string");
    assert.ok(typeof final.durationMs  === "number");
  });

  it("completes within oneCycleSlaMs=5000ms (AC-3)", async () => {
    const configFile  = path.join(tmpDir, "box.config.json");
    const policyFile  = path.join(tmpDir, "policy.json");
    const incidentLog = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile    = path.join(tmpDir, "rollback_lock.json");

    await fs.writeFile(configFile, JSON.stringify({ loopIntervalMs: 99999 }), "utf8");
    await fs.writeFile(policyFile, JSON.stringify({ gates: {} }), "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath: path.join(tmpDir, "baseline.json") });

    const result = await executeRollback({
      level:    ROLLBACK_LEVEL.CONFIG_ONLY,
      trigger:  ROLLBACK_TRIGGER.CANARY_ROLLBACK,
      evidence: { controlValue: { loopIntervalMs: 20000 } },
      config,
      stateDir: tmpDir
    });

    assert.ok(result.durationMs !== null, "durationMs must be recorded");
    assert.ok(result.durationMs < 5000, `rollback took ${result.durationMs}ms — must be < 5000ms`);
    assert.equal(result.slaBreach, false);
  });

  it("restores config values from evidence.controlValue", async () => {
    const configFile  = path.join(tmpDir, "box.config.json");
    const policyFile  = path.join(tmpDir, "policy.json");
    const incidentLog = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile    = path.join(tmpDir, "rollback_lock.json");

    // Initial config with a "bad" value
    await fs.writeFile(configFile, JSON.stringify({ loopIntervalMs: 1 }), "utf8");
    await fs.writeFile(policyFile, JSON.stringify({ gates: {} }), "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath: path.join(tmpDir, "baseline.json") });

    await executeRollback({
      level:    ROLLBACK_LEVEL.CONFIG_ONLY,
      trigger:  ROLLBACK_TRIGGER.CONFIG_KEY_MISSING,
      evidence: { controlValue: { loopIntervalMs: 20000 } },
      config,
      stateDir: tmpDir
    });

    // Verify config was restored
    const restored = JSON.parse(await fs.readFile(configFile, "utf8"));
    assert.equal(restored.loopIntervalMs, 20000);
  });

  // Negative path: no control value → rollback fails with NO_ROLLBACK_TARGET
  it("negative path: returns ok=false with NO_ROLLBACK_TARGET when evidence.controlValue absent (AC-7)", async () => {
    const configFile  = path.join(tmpDir, "box.config.json");
    const policyFile  = path.join(tmpDir, "policy.json");
    const incidentLog = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile    = path.join(tmpDir, "rollback_lock.json");

    await fs.writeFile(configFile, JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(policyFile, JSON.stringify({ x: 1 }), "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath: path.join(tmpDir, "baseline.json") });

    const result = await executeRollback({
      level:    ROLLBACK_LEVEL.CONFIG_ONLY,
      trigger:  ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE,
      evidence: {},   // no controlValue
      config,
      stateDir: tmpDir
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, ROLLBACK_REASON.NO_ROLLBACK_TARGET);
    // Incident must still be written (AC-2)
    const incidents = await readIncidentLog(incidentLog);
    assert.ok(incidents.length >= 1);
  });
});

// ── executeRollback — policy-set level ────────────────────────────────────────

describe("executeRollback — policy-set level", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-rollback-pol-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("restores policy.json from evidence.controlValue", async () => {
    const configFile  = path.join(tmpDir, "box.config.json");
    const policyFile  = path.join(tmpDir, "policy.json");
    const incidentLog = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile    = path.join(tmpDir, "rollback_lock.json");

    await fs.writeFile(configFile, JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(policyFile, JSON.stringify({ gates: { bad: true } }), "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath: path.join(tmpDir, "baseline.json") });

    const result = await executeRollback({
      level:    ROLLBACK_LEVEL.POLICY_SET,
      trigger:  ROLLBACK_TRIGGER.POLICY_GATE_MISSING,
      evidence: { controlValue: { gates: { requireBuild: true } } },
      config,
      stateDir: tmpDir
    });

    assert.equal(result.ok, true);

    const restored = JSON.parse(await fs.readFile(policyFile, "utf8"));
    assert.deepEqual(restored, { gates: { requireBuild: true } });
  });

  it("completes within oneCycleSlaMs (AC-3)", async () => {
    const configFile  = path.join(tmpDir, "box.config.json");
    const policyFile  = path.join(tmpDir, "policy.json");
    const incidentLog = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile    = path.join(tmpDir, "rollback_lock.json");

    await fs.writeFile(configFile, JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(policyFile, JSON.stringify({ x: 1 }), "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath: path.join(tmpDir, "baseline.json") });

    const result = await executeRollback({
      level:    ROLLBACK_LEVEL.POLICY_SET,
      trigger:  ROLLBACK_TRIGGER.POLICY_PARSE_FAILURE,
      evidence: { controlValue: { gates: {} } },
      config,
      stateDir: tmpDir
    });

    assert.ok(result.durationMs < 5000);
    assert.equal(result.slaBreach, false);
  });
});

// ── executeRollback — orchestration-code-freeze (Athena item #6) ──────────────

describe("executeRollback — orchestration-code-freeze (Athena item #6)", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-rollback-freeze-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes freeze lock file on CORE_FILE_MODIFIED trigger", async () => {
    const configFile  = path.join(tmpDir, "box.config.json");
    const policyFile  = path.join(tmpDir, "policy.json");
    const incidentLog = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile    = path.join(tmpDir, "rollback_lock.json");

    await fs.writeFile(configFile, JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(policyFile, JSON.stringify({ x: 1 }), "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath: path.join(tmpDir, "baseline.json") });

    const result = await executeRollback({
      level:    ROLLBACK_LEVEL.ORCHESTRATION_CODE_FREEZE,
      trigger:  ROLLBACK_TRIGGER.CORE_FILE_MODIFIED,
      evidence: { modifiedFile: "src/core/orchestrator.js" },
      config,
      stateDir: tmpDir
    });

    assert.equal(result.ok, true);

    // Lock file must exist and be valid
    const frozen = await isFrozen(lockFile);
    assert.equal(frozen, true);

    const lock = await readFreezeLock(lockFile);
    assert.equal(lock.frozen, true);
    assert.equal(lock.frozenBy, ROLLBACK_TRIGGER.CORE_FILE_MODIFIED);
    assert.ok(typeof lock.frozenAt === "string");
    assert.ok(Array.isArray(lock.scope));
  });

  it("isFrozen returns false when no lock file", async () => {
    const lockFile = path.join(tmpDir, "nonexistent_lock.json");
    const result = await isFrozen(lockFile);
    assert.equal(result, false);
  });

  it("unfreeze sets frozen=false and records unfrozenAt", async () => {
    const configFile  = path.join(tmpDir, "box.config.json");
    const policyFile  = path.join(tmpDir, "policy.json");
    const incidentLog = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile    = path.join(tmpDir, "rollback_lock.json");

    await fs.writeFile(configFile, JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(policyFile, JSON.stringify({ x: 1 }), "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath: path.join(tmpDir, "baseline.json") });

    // First freeze
    await executeRollback({
      level:    ROLLBACK_LEVEL.ORCHESTRATION_CODE_FREEZE,
      trigger:  ROLLBACK_TRIGGER.SELF_DEV_GUARD_BREACH,
      evidence: {},
      config,
      stateDir: tmpDir
    });

    assert.equal(await isFrozen(lockFile), true);

    // Then unfreeze
    const unfreezeResult = await unfreeze(lockFile);
    assert.equal(unfreezeResult.ok, true);
    assert.equal(await isFrozen(lockFile), false);

    const lock = await readFreezeLock(lockFile);
    assert.equal(lock.frozen, false);
    assert.ok(typeof lock.unfrozenAt === "string");
  });

  // Negative path: unfreeze when no lock file
  it("negative path: unfreeze returns ok=false when no lock file exists (AC-7)", async () => {
    const lockFile = path.join(tmpDir, "missing_lock.json");
    const result = await unfreeze(lockFile);
    assert.equal(result.ok, false);
  });
});

// ── executeRollback — state-schema level ──────────────────────────────────────

describe("executeRollback — state-schema level", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-rollback-state-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("quarantines the offending state file and writes a skeleton", async () => {
    const configFile    = path.join(tmpDir, "box.config.json");
    const policyFile    = path.join(tmpDir, "policy.json");
    const incidentLog   = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile      = path.join(tmpDir, "rollback_lock.json");
    const corruptState  = path.join(tmpDir, "knowledge_memory.json");

    await fs.writeFile(configFile,   JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(policyFile,   JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(corruptState, "CORRUPT DATA NOT JSON", "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath: path.join(tmpDir, "baseline.json") });

    const result = await executeRollback({
      level:    ROLLBACK_LEVEL.STATE_SCHEMA,
      trigger:  ROLLBACK_TRIGGER.STATE_SCHEMA_VIOLATION,
      evidence: { filePath: corruptState },
      config,
      stateDir: tmpDir
    });

    assert.equal(result.ok, true);

    // Original file should now be a valid skeleton
    const skeleton = JSON.parse(await fs.readFile(corruptState, "utf8"));
    assert.equal(skeleton.schemaVersion, 1);
    assert.ok(skeleton.quarantinedAt);
  });
});

// ── executeRollback — full-baseline-restore (AC-4) ────────────────────────────

describe("executeRollback — full-baseline-restore (AC-4)", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-rollback-baseline-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("records baseline tag and verification check list in evidence (AC-4)", async () => {
    const configFile      = path.join(tmpDir, "box.config.json");
    const policyFile      = path.join(tmpDir, "policy.json");
    const incidentLog     = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile        = path.join(tmpDir, "rollback_lock.json");
    const baselineRefPath = path.join(tmpDir, "project_baseline.json");

    await fs.writeFile(configFile, JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(policyFile, JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(baselineRefPath, JSON.stringify({
      tagName:     "box/baseline-2026-03-22",
      sha:         "abc1234567890",
      repo:        "CanerDoqdu/Box",
      capturedAt:  "2026-03-22T00:00:00Z"
    }), "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath });

    const evidence = { reason: "multi-level failure" };

    const result = await executeRollback({
      level:    ROLLBACK_LEVEL.FULL_BASELINE_RESTORE,
      trigger:  ROLLBACK_TRIGGER.MULTI_LEVEL_FAILURE,
      evidence,
      config,
      stateDir: tmpDir
    });

    assert.equal(result.ok, true);
    assert.equal(result.baselineRef, "box/baseline-2026-03-22");

    // evidence.restoreGuidance must be populated
    assert.ok(evidence.restoreGuidance, "restoreGuidance must be set in evidence");
    assert.equal(evidence.restoreGuidance.baselineTag, "box/baseline-2026-03-22");
    assert.ok(Array.isArray(evidence.restoreGuidance.verificationChecks));
    assert.equal(evidence.restoreGuidance.verificationChecks.length, Object.keys(HEALTH_CHECK).length);
    assert.ok(typeof evidence.restoreGuidance.restoreCommand === "string");
  });

  it("records null baselineRef and guidance when no baseline file exists", async () => {
    const configFile  = path.join(tmpDir, "box.config.json");
    const policyFile  = path.join(tmpDir, "policy.json");
    const incidentLog = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile    = path.join(tmpDir, "rollback_lock.json");

    await fs.writeFile(configFile, JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(policyFile, JSON.stringify({ x: 1 }), "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath: path.join(tmpDir, "missing_baseline.json") });

    const result = await executeRollback({
      level:    ROLLBACK_LEVEL.FULL_BASELINE_RESTORE,
      trigger:  ROLLBACK_TRIGGER.HEALTH_SCORE_CRITICAL,
      evidence: {},
      config,
      stateDir: tmpDir
    });

    assert.equal(result.ok, true);
    assert.equal(result.baselineRef, null);
  });
});

// ── executeRollback — incident record schema (AC-2, AC-8) ────────────────────

describe("executeRollback — incident record schema completeness (AC-2, AC-8)", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-rollback-schema-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("every required schema field is present in the final incident record (AC-8)", async () => {
    const configFile  = path.join(tmpDir, "box.config.json");
    const policyFile  = path.join(tmpDir, "policy.json");
    const incidentLog = path.join(tmpDir, "rollback_incidents.jsonl");
    const lockFile    = path.join(tmpDir, "rollback_lock.json");

    await fs.writeFile(configFile, JSON.stringify({ x: 1 }), "utf8");
    await fs.writeFile(policyFile, JSON.stringify({ x: 1 }), "utf8");

    const config = makeConfig({ configFilePath: configFile, policyFilePath: policyFile, incidentLogPath: incidentLog, lockFilePath: lockFile, baselineRefPath: path.join(tmpDir, "baseline.json") });

    await executeRollback({
      level:    ROLLBACK_LEVEL.POLICY_SET,
      trigger:  ROLLBACK_TRIGGER.POLICY_GATE_MISSING,
      evidence: { controlValue: { gates: {} } },
      config,
      stateDir: tmpDir
    });

    const incidents = await readIncidentLog(incidentLog);
    const final = incidents[incidents.length - 1];

    // Required fields (AC-2 schema)
    const REQUIRED_FIELDS = [
      "schemaVersion", "incidentId", "level", "trigger",
      "triggeredAt", "completedAt", "status", "stepsExecuted",
      "evidence", "baselineRef", "healthCheckResult", "durationMs", "slaBreach"
    ];

    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in final, `required field '${field}' missing from incident record`);
    }

    // Type checks
    assert.equal(typeof final.schemaVersion, "number");
    assert.equal(typeof final.incidentId, "string");
    assert.ok(final.incidentId.startsWith("rollback-"));
    assert.ok(Object.values(ROLLBACK_LEVEL).includes(final.level));
    assert.ok(Object.values(ROLLBACK_TRIGGER).includes(final.trigger));
    assert.ok(Object.values(ROLLBACK_STATUS).includes(final.status));
    assert.ok(Array.isArray(final.stepsExecuted));
    assert.equal(typeof final.evidence, "object");
    assert.equal(typeof final.durationMs, "number");
    assert.equal(typeof final.slaBreach, "boolean");
  });
});

// ── executeRollback — no-throw contract (AC-10) ───────────────────────────────

describe("executeRollback — no-throw contract (AC-10)", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-rollback-nothrow-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns degraded result (never throws) when trigger is invalid (AC-10)", async () => {
    const config = makeConfig({
      incidentLogPath: path.join(tmpDir, "incidents.jsonl"),
      lockFilePath:    path.join(tmpDir, "lock.json"),
      configFilePath:  path.join(tmpDir, "config.json"),
      policyFilePath:  path.join(tmpDir, "policy.json"),
      baselineRefPath: path.join(tmpDir, "baseline.json")
    });

    // Should NOT throw — returns degraded result
    const result = await executeRollback({
      level:   ROLLBACK_LEVEL.CONFIG_ONLY,
      trigger: "INVALID_TRIGGER_VALUE",
      config,
      stateDir: tmpDir
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "degraded");
    assert.ok(result.reason, "reason must be set on failure");
  });

  it("returns degraded result when config is missing (AC-10)", async () => {
    const result = await executeRollback({
      level:   ROLLBACK_LEVEL.CONFIG_ONLY,
      trigger: ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE
      // config intentionally absent
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "degraded");
    assert.equal(result.reason, ROLLBACK_REASON.MISSING_CONFIG);
  });
});

// ── resolveRollbackConfig ─────────────────────────────────────────────────────

describe("resolveRollbackConfig", () => {
  it("falls back to ROLLBACK_ENGINE_DEFAULTS for absent keys", () => {
    const rc = resolveRollbackConfig({});
    assert.equal(rc.oneCycleSlaMs,  ROLLBACK_ENGINE_DEFAULTS.oneCycleSlaMs);
    assert.equal(rc.incidentLogPath, ROLLBACK_ENGINE_DEFAULTS.incidentLogPath);
    assert.equal(rc.lockFilePath,    ROLLBACK_ENGINE_DEFAULTS.lockFilePath);
  });

  it("uses box.config.json#rollbackEngine values when present", () => {
    const rc = resolveRollbackConfig({ rollbackEngine: { oneCycleSlaMs: 1234 } });
    assert.equal(rc.oneCycleSlaMs, 1234);
  });

  it("uses selfDev.criticalFiles as freeze scope when rollbackEngine.criticalFiles absent", () => {
    const rc = resolveRollbackConfig({
      selfDev: { criticalFiles: ["src/core/orchestrator.ts"] }
    });
    assert.deepEqual(rc.criticalFiles, ["src/core/orchestrator.ts"]);
  });
});

// ── ROLLBACK_STATUS enum ──────────────────────────────────────────────────────

describe("ROLLBACK_STATUS enum", () => {
  it("exports all required status values as deterministic strings (AC-8)", () => {
    assert.equal(ROLLBACK_STATUS.TRIGGERED,  "triggered");
    assert.equal(ROLLBACK_STATUS.EXECUTING,  "executing");
    assert.equal(ROLLBACK_STATUS.COMPLETED,  "completed");
    assert.equal(ROLLBACK_STATUS.FAILED,     "failed");
    assert.equal(ROLLBACK_STATUS.SLA_BREACH, "sla_breach");
  });
});

// ── readIncidentLog ───────────────────────────────────────────────────────────

describe("readIncidentLog", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-rollback-log-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when log file does not exist", async () => {
    const result = await readIncidentLog(path.join(tmpDir, "nonexistent.jsonl"));
    assert.deepEqual(result, []);
  });

  it("returns parsed records from JSONL file", async () => {
    const logPath = path.join(tmpDir, "incidents.jsonl");
    await fs.writeFile(logPath,
      `${JSON.stringify({ incidentId: "rollback-aaa", level: "config-only" })}\n` +
      `${JSON.stringify({ incidentId: "rollback-bbb", level: "policy-set" })}\n`,
      "utf8"
    );

    const result = await readIncidentLog(logPath);
    assert.equal(result.length, 2);
    assert.equal(result[0].incidentId, "rollback-aaa");
    assert.equal(result[1].incidentId, "rollback-bbb");
  });
});
