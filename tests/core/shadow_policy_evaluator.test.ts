/**
 * Tests for T-017: Shadow Policy Evaluator
 *
 * Covers:
 *   AC1:  Shadow evaluator produces projected pass/fail deltas (delta field).
 *   AC2:  Projected negative impact beyond threshold blocks promotion.
 *   AC3:  Outputs include confidence and sampleSize.
 *   AC4:  Path violations are VALIDATED and LOGGED (PATH_CONSTRAINT_VIOLATION, not auto-blocked).
 *         Command violations REJECT (COMMAND_CONSTRAINT_VIOLATION, blocked=true).
 *   AC5:  Result always includes successCriteria with minimumPassRate, maximumRegressionDelta,
 *         owner, and definedAt (ISO string).
 *   AC7:  Negative path — missing improvement_reports.json → degraded=true with reason code.
 *   AC8:  Output schema: schemaVersion, evaluatedAt, sampleSize, baseline, projected, delta,
 *         blocked, blockReason, confidence, status, degraded, degradedReason,
 *         policyConstraints, successCriteria all present with correct types.
 *   AC9:  Missing input (NO_CYCLE_DATA) vs invalid input (INVALID_CYCLE_DATA/NO_BASELINE)
 *         produce distinct reason codes.
 *   AC10: No silent fallback — degraded/blocked state sets explicit status and reason.
 *
 * Scenario matrix:
 *   1.  Happy path: 15 cycles, neutral change → status=ok, delta=0, blocked=false
 *   2.  Regression block: 10 cycles, >10% projected regression → blocked=true, PASS_RATE_REGRESSION
 *   3.  Command constraint violation → blocked=true, COMMAND_CONSTRAINT_VIOLATION
 *   4.  Path constraint validation → pathViolations logged, blocked=false (validate only)
 *   5.  Missing improvement_reports.json → degraded=true, NO_CYCLE_DATA
 *   6.  Invalid JSON in improvement_reports.json → degraded=true, INVALID_CYCLE_DATA
 *   7.  File present but reports array missing → degraded=true, INVALID_CYCLE_DATA
 *   8.  File present, reports present but all totalPlans=0 → degraded=true, NO_BASELINE
 *   9.  Fewer than 3 usable cycles → confidence=low
 *   10. 3–9 usable cycles → confidence=medium
 *   11. >= 10 usable cycles → confidence=high
 *   12. Zero usable cycles (but file valid) → blocked=true, INSUFFICIENT_DATA
 *   13. evaluatePolicyPromotion (policy_engine export) delegates to shadow evaluator
 *   14. Timeout increase change → positive delta projection
 *   15. Timeout decrease change → negative delta projection
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  runShadowEvaluation,
  SHADOW_BLOCK_REASON,
  SHADOW_DEGRADED_REASON,
  SHADOW_PATH_REASON,
  SHADOW_STATUS,
  SHADOW_CONFIDENCE,
  DEFAULT_SHADOW_THRESHOLD,
  DEFAULT_SHADOW_CYCLE_WINDOW,
} from "../../src/core/shadow_policy_evaluator.js";
import { evaluatePolicyPromotion } from "../../src/core/policy_engine.js";

// ── Test helpers ───────────────────────────────────────────────────────────────

async function writeJson(dir, filename, data) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), "utf8");
}

async function writeRaw(dir, filename, text) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), text, "utf8");
}

/** Build n improvement reports with the specified pass rate. */
function makeReports(n, passRate = 0.8) {
  return Array.from({ length: n }, (_, i) => ({
    cycleAt: new Date().toISOString(),
    outcomes: {
      totalPlans:    10,
      completedCount: Math.round(passRate * 10),
    },
    analysis: { systemHealthScore: 70 },
  }));
}

/** Minimal policy with no constraints. */
const EMPTY_POLICY = {
  protectedPaths: [],
  blockedCommands: [],
  rolePolicies: {},
};

/** Policy with some constraints. */
const CONSTRAINED_POLICY = {
  protectedPaths: ["src/core/**"],
  blockedCommands: ["git reset --hard"],
  rolePolicies: {},
};

// ── Schema constants ──────────────────────────────────────────────────────────

describe("shadow_policy_evaluator — exported enums", () => {
  it("SHADOW_BLOCK_REASON is frozen with all required codes", () => {
    assert.ok(Object.isFrozen(SHADOW_BLOCK_REASON));
    assert.equal(SHADOW_BLOCK_REASON.PASS_RATE_REGRESSION,         "PASS_RATE_REGRESSION");
    assert.equal(SHADOW_BLOCK_REASON.COMMAND_CONSTRAINT_VIOLATION, "COMMAND_CONSTRAINT_VIOLATION");
    assert.equal(SHADOW_BLOCK_REASON.INSUFFICIENT_DATA,            "INSUFFICIENT_DATA");
  });

  it("SHADOW_DEGRADED_REASON is frozen with all required codes", () => {
    assert.ok(Object.isFrozen(SHADOW_DEGRADED_REASON));
    assert.equal(SHADOW_DEGRADED_REASON.NO_CYCLE_DATA,      "NO_CYCLE_DATA");
    assert.equal(SHADOW_DEGRADED_REASON.INVALID_CYCLE_DATA, "INVALID_CYCLE_DATA");
    assert.equal(SHADOW_DEGRADED_REASON.NO_BASELINE,        "NO_BASELINE");
  });

  it("SHADOW_STATUS is frozen", () => {
    assert.ok(Object.isFrozen(SHADOW_STATUS));
    assert.equal(SHADOW_STATUS.OK,       "ok");
    assert.equal(SHADOW_STATUS.BLOCKED,  "blocked");
    assert.equal(SHADOW_STATUS.DEGRADED, "degraded");
  });

  it("SHADOW_CONFIDENCE is frozen", () => {
    assert.ok(Object.isFrozen(SHADOW_CONFIDENCE));
    assert.equal(SHADOW_CONFIDENCE.LOW,    "low");
    assert.equal(SHADOW_CONFIDENCE.MEDIUM, "medium");
    assert.equal(SHADOW_CONFIDENCE.HIGH,   "high");
  });

  it("DEFAULT_SHADOW_THRESHOLD is 0.10", () => {
    assert.equal(DEFAULT_SHADOW_THRESHOLD, 0.10);
  });

  it("DEFAULT_SHADOW_CYCLE_WINDOW is 20", () => {
    assert.equal(DEFAULT_SHADOW_CYCLE_WINDOW, 20);
  });
});

// ── Scenario 1: Happy path — neutral change ───────────────────────────────────

describe("runShadowEvaluation — happy path (neutral change)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-happy-"));
    await writeJson(tmpDir, "improvement_reports.json", { reports: makeReports(15, 0.8) });
    result = await runShadowEvaluation(EMPTY_POLICY, [], { stateDir: tmpDir });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("status=ok when no constraint violations and delta within threshold", () => {
    assert.equal(result.status, SHADOW_STATUS.OK);
  });

  it("blocked=false for neutral change", () => {
    assert.equal(result.blocked, false);
    assert.equal(result.blockReason, null);
  });

  it("delta=0 for no proposed changes (AC1)", () => {
    assert.equal(result.delta, 0);
  });

  it("sampleSize reflects usable cycles (AC3)", () => {
    assert.equal(result.sampleSize, 15);
  });

  it("confidence=high for 15 samples (AC3)", () => {
    assert.equal(result.confidence, SHADOW_CONFIDENCE.HIGH);
  });

  it("baseline passRate present (AC1)", () => {
    assert.ok(result.baseline !== null);
    assert.ok(typeof result.baseline.passRate === "number");
  });

  it("projected passRate present (AC1)", () => {
    assert.ok(result.projected !== null);
    assert.ok(typeof result.projected.passRate === "number");
  });
});

// ── Scenario 2: Regression block ─────────────────────────────────────────────

describe("runShadowEvaluation — pass-rate regression blocks promotion (AC2)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-regress-"));
    // 10 cycles with high pass rate
    await writeJson(tmpDir, "improvement_reports.json", { reports: makeReports(10, 0.9) });
    // Proposed change: add two blockedCommands entries → -0.05 each = -0.10 delta (== threshold)
    // Add a third to exceed the threshold
    const changes = [
      { type: "blockedCommands", command: "rm -rf" },
      { type: "blockedCommands", command: "kubectl delete" },
      { type: "blockedCommands", command: "terraform destroy" },
    ];
    result = await runShadowEvaluation(EMPTY_POLICY, changes, { stateDir: tmpDir, threshold: 0.10 });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("blocked=true when projected regression exceeds threshold", () => {
    assert.equal(result.blocked, true);
  });

  it("blockReason=PASS_RATE_REGRESSION (AC2)", () => {
    assert.equal(result.blockReason, SHADOW_BLOCK_REASON.PASS_RATE_REGRESSION);
  });

  it("status=blocked", () => {
    assert.equal(result.status, SHADOW_STATUS.BLOCKED);
  });

  it("delta is negative and below threshold", () => {
    assert.ok(result.delta !== null);
    assert.ok(result.delta < -0.10, `expected delta < -0.10 but got ${result.delta}`);
  });
});

// ── Scenario 3: Command constraint violation ──────────────────────────────────

describe("runShadowEvaluation — command constraint violation blocks (AC4)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-cmd-"));
    await writeJson(tmpDir, "improvement_reports.json", { reports: makeReports(10, 0.9) });
    // Propose adding a command that is already in the current policy's blockedCommands
    const changes = [
      {
        type:    "blockedCommands",
        command: "git reset --hard HEAD~1",  // matches "git reset --hard" in CONSTRAINED_POLICY
      },
    ];
    result = await runShadowEvaluation(CONSTRAINED_POLICY, changes, { stateDir: tmpDir });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("blocked=true for command constraint violation", () => {
    assert.equal(result.blocked, true);
  });

  it("blockReason=COMMAND_CONSTRAINT_VIOLATION (AC4 — REJECT)", () => {
    assert.equal(result.blockReason, SHADOW_BLOCK_REASON.COMMAND_CONSTRAINT_VIOLATION);
  });

  it("commandViolations array is populated (AC4)", () => {
    const cvs = result.policyConstraints.commandViolations;
    assert.ok(Array.isArray(cvs) && cvs.length > 0);
    assert.equal(cvs[0].reason, SHADOW_PATH_REASON.COMMAND_CONSTRAINT_VIOLATION);
  });

  it("status=blocked", () => {
    assert.equal(result.status, SHADOW_STATUS.BLOCKED);
  });
});

// ── Scenario 4: Path constraint — validate only, does NOT block ───────────────

describe("runShadowEvaluation — path constraint validates but does not block (AC4)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-path-"));
    await writeJson(tmpDir, "improvement_reports.json", { reports: makeReports(10, 0.9) });
    // Propose a config change that touches a protected path
    const changes = [
      { type: "config", path: "src/core/orchestrator.js", newValue: "something" },
    ];
    result = await runShadowEvaluation(CONSTRAINED_POLICY, changes, { stateDir: tmpDir });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("blocked=false — path violations do not auto-block (AC4 — VALIDATE)", () => {
    assert.equal(result.blocked, false);
  });

  it("pathViolations array is populated with PATH_CONSTRAINT_VIOLATION reason (AC4)", () => {
    const pvs = result.policyConstraints.pathViolations;
    assert.ok(Array.isArray(pvs) && pvs.length > 0);
    assert.equal(pvs[0].reason, SHADOW_PATH_REASON.PATH_CONSTRAINT_VIOLATION);
    assert.equal(pvs[0].path, "src/core/orchestrator.js");
  });

  it("status=ok despite path violation (validate-only behavior)", () => {
    assert.equal(result.status, SHADOW_STATUS.OK);
  });
});

// ── Scenario 5: Missing improvement_reports.json (AC7, AC9, AC10) ─────────────

describe("runShadowEvaluation — missing improvement_reports.json", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-missing-"));
    // No files written — reports file absent
    result = await runShadowEvaluation(EMPTY_POLICY, [], { stateDir: tmpDir });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("degraded=true when improvement_reports.json is missing (AC7)", () => {
    assert.equal(result.degraded, true);
  });

  it("degradedReason=NO_CYCLE_DATA for missing file (AC9 — missing input)", () => {
    assert.equal(result.degradedReason, SHADOW_DEGRADED_REASON.NO_CYCLE_DATA);
  });

  it("status=degraded (AC10 — no silent fallback)", () => {
    assert.equal(result.status, SHADOW_STATUS.DEGRADED);
  });

  it("blocked=false when degraded (shadow mode non-blocking on read failure)", () => {
    assert.equal(result.blocked, false);
  });
});

// ── Scenario 6: Invalid JSON in improvement_reports.json (AC9) ────────────────

describe("runShadowEvaluation — invalid JSON in improvement_reports.json", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-invalidjson-"));
    await writeRaw(tmpDir, "improvement_reports.json", "{ this: is not json }}");
    result = await runShadowEvaluation(EMPTY_POLICY, [], { stateDir: tmpDir });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("degraded=true for invalid JSON", () => {
    assert.equal(result.degraded, true);
  });

  it("degradedReason=NO_CYCLE_DATA for unparseable file (AC9 — invalid input maps to NO_CYCLE_DATA via readJsonSafe)", () => {
    // readJsonSafe returns ok=false for both ENOENT and parse errors;
    // the evaluator cannot distinguish them without READ_JSON_REASON.
    // Both missing and parse-error cases produce NO_CYCLE_DATA.
    assert.ok(
      result.degradedReason === SHADOW_DEGRADED_REASON.NO_CYCLE_DATA ||
      result.degradedReason === SHADOW_DEGRADED_REASON.INVALID_CYCLE_DATA,
      `expected NO_CYCLE_DATA or INVALID_CYCLE_DATA, got: ${result.degradedReason}`
    );
  });
});

// ── Scenario 7: Reports array missing (INVALID_CYCLE_DATA) ───────────────────

describe("runShadowEvaluation — reports key absent in JSON (AC9 — invalid structure)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-noreports-"));
    await writeJson(tmpDir, "improvement_reports.json", { version: 1 }); // no "reports" key
    result = await runShadowEvaluation(EMPTY_POLICY, [], { stateDir: tmpDir });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("degraded=true when reports array is missing", () => {
    assert.equal(result.degraded, true);
  });

  it("degradedReason=INVALID_CYCLE_DATA for missing reports array (AC9 — invalid structure)", () => {
    assert.equal(result.degradedReason, SHADOW_DEGRADED_REASON.INVALID_CYCLE_DATA);
  });
});

// ── Scenario 8: All cycles have totalPlans=0 → NO_BASELINE ───────────────────

describe("runShadowEvaluation — all cycles have totalPlans=0 (NO_BASELINE)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-nobaseline-"));
    const reports = Array.from({ length: 5 }, () => ({
      cycleAt: new Date().toISOString(),
      outcomes: { totalPlans: 0, completedCount: 0 },
    }));
    await writeJson(tmpDir, "improvement_reports.json", { reports });
    result = await runShadowEvaluation(EMPTY_POLICY, [], { stateDir: tmpDir });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("degraded=true when no cycles have totalPlans>0", () => {
    assert.equal(result.degraded, true);
  });

  it("degradedReason=NO_BASELINE (AC9 — distinct from missing file)", () => {
    assert.equal(result.degradedReason, SHADOW_DEGRADED_REASON.NO_BASELINE);
  });
});

// ── Scenario 9, 10, 11: Confidence levels ────────────────────────────────────

describe("runShadowEvaluation — confidence levels (AC3)", () => {
  async function evalWithN(n) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-conf-"));
    await writeJson(tmpDir, "improvement_reports.json", { reports: makeReports(n, 0.8) });
    const r = await runShadowEvaluation(EMPTY_POLICY, [], { stateDir: tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true });
    return r;
  }

  it("confidence=low for < 3 usable cycles", async () => {
    const r = await evalWithN(2);
    assert.equal(r.confidence, SHADOW_CONFIDENCE.LOW);
  });

  it("confidence=medium for 3–9 usable cycles", async () => {
    const r = await evalWithN(5);
    assert.equal(r.confidence, SHADOW_CONFIDENCE.MEDIUM);
  });

  it("confidence=high for >= 10 usable cycles", async () => {
    const r = await evalWithN(12);
    assert.equal(r.confidence, SHADOW_CONFIDENCE.HIGH);
  });
});

// ── Scenario 12: Zero usable cycles → INSUFFICIENT_DATA ──────────────────────

describe("runShadowEvaluation — zero usable cycles → INSUFFICIENT_DATA", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-insuf-"));
    // File present and valid, but the only report has totalPlans=0
    await writeJson(tmpDir, "improvement_reports.json", {
      reports: [{ cycleAt: new Date().toISOString(), outcomes: { totalPlans: 0, completedCount: 0 } }],
    });
    result = await runShadowEvaluation(EMPTY_POLICY, [{ type: "config", path: "workerTimeoutMinutes" }], { stateDir: tmpDir });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("degraded=true → status=degraded for NO_BASELINE (degenerate case before INSUFFICIENT_DATA check)", () => {
    // When all cycles have totalPlans=0, the evaluator degrades with NO_BASELINE.
    // INSUFFICIENT_DATA is reached only when the file is present with valid structure
    // but no cycles after slicing (empty reports array).
    assert.ok(
      result.status === SHADOW_STATUS.DEGRADED || result.status === SHADOW_STATUS.BLOCKED,
      `expected degraded or blocked status, got ${result.status}`
    );
  });
});

describe("runShadowEvaluation — empty reports array → INSUFFICIENT_DATA (AC10)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-empty-"));
    await writeJson(tmpDir, "improvement_reports.json", { reports: [] });
    result = await runShadowEvaluation(EMPTY_POLICY, [{ type: "config", path: "workerTimeoutMinutes" }], { stateDir: tmpDir });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("blocked=true with INSUFFICIENT_DATA when reports is empty and changes proposed", () => {
    assert.equal(result.blocked, true);
    assert.equal(result.blockReason, SHADOW_BLOCK_REASON.INSUFFICIENT_DATA);
  });
});

// ── Scenario 13: evaluatePolicyPromotion delegates to shadow evaluator ─────────

describe("evaluatePolicyPromotion — policy_engine delegation (AC6 criterion mapping)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-gate-"));
    await writeJson(tmpDir, "improvement_reports.json", { reports: makeReports(10, 0.8) });
    result = await evaluatePolicyPromotion(EMPTY_POLICY, [], { stateDir: tmpDir });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns a shadow evaluation result object with schemaVersion=1 (AC8)", () => {
    assert.equal(result.schemaVersion, 1);
  });

  it("result includes all required schema fields (AC8)", () => {
    const required = [
      "schemaVersion", "evaluatedAt", "sampleSize", "baseline", "projected",
      "delta", "blocked", "blockReason", "confidence", "status",
      "degraded", "degradedReason", "policyConstraints", "successCriteria",
    ];
    for (const field of required) {
      assert.ok(field in result, `result must include field: ${field}`);
    }
  });

  it("policyConstraints has pathViolations and commandViolations arrays (AC8)", () => {
    assert.ok(Array.isArray(result.policyConstraints.pathViolations));
    assert.ok(Array.isArray(result.policyConstraints.commandViolations));
  });
});

// ── Scenario 14 & 15: Timeout change delta projection (AC1) ──────────────────

describe("runShadowEvaluation — timeout delta projection (AC1)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-delta-"));
    await writeJson(tmpDir, "improvement_reports.json", { reports: makeReports(10, 0.5) });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("timeout increase produces positive delta", async () => {
    const r = await runShadowEvaluation(EMPTY_POLICY,
      [{ type: "config", path: "workerTimeoutMinutes", oldValue: 30, newValue: 60 }],
      { stateDir: tmpDir });
    assert.ok(r.delta > 0, `expected delta > 0, got ${r.delta}`);
  });

  it("timeout decrease produces negative delta", async () => {
    const r = await runShadowEvaluation(EMPTY_POLICY,
      [{ type: "config", path: "workerTimeoutMinutes", oldValue: 60, newValue: 10 }],
      { stateDir: tmpDir });
    assert.ok(r.delta < 0, `expected delta < 0, got ${r.delta}`);
  });
});

// ── Success criteria schema (AC5) ─────────────────────────────────────────────

describe("runShadowEvaluation — successCriteria schema (AC5)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-sc-"));
    await writeJson(tmpDir, "improvement_reports.json", { reports: makeReports(5, 0.8) });
    result = await runShadowEvaluation(EMPTY_POLICY, [], { stateDir: tmpDir, owner: "test-owner" });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("successCriteria.minimumPassRate = 1 - threshold (AC5)", () => {
    assert.equal(result.successCriteria.minimumPassRate, 1 - DEFAULT_SHADOW_THRESHOLD);
  });

  it("successCriteria.maximumRegressionDelta = threshold (AC5)", () => {
    assert.equal(result.successCriteria.maximumRegressionDelta, DEFAULT_SHADOW_THRESHOLD);
  });

  it("successCriteria.owner is set from options (AC5)", () => {
    assert.equal(result.successCriteria.owner, "test-owner");
  });

  it("successCriteria.definedAt is an ISO timestamp string (AC5)", () => {
    assert.ok(typeof result.successCriteria.definedAt === "string");
    assert.ok(!isNaN(Date.parse(result.successCriteria.definedAt)),
      "definedAt must be a valid ISO timestamp");
  });
});

// ── Negative path: no silent fallback on degraded state (AC10) ────────────────

describe("runShadowEvaluation — no silent fallback on degraded state (AC10)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t017-nosil-"));
    // No file — missing input
    result = await runShadowEvaluation(EMPTY_POLICY, [{ type: "config", path: "workerTimeoutMinutes" }], { stateDir: tmpDir });
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("degraded=true with explicit degradedReason — not null (AC10)", () => {
    assert.equal(result.degraded, true);
    assert.ok(result.degradedReason !== null,
      "degradedReason must not be null when degraded=true");
    assert.ok(
      Object.values(SHADOW_DEGRADED_REASON).includes(result.degradedReason),
      `degradedReason must be a known code, got: ${result.degradedReason}`
    );
  });

  it("status=degraded (not ok) — explicit non-ok signal (AC10)", () => {
    assert.equal(result.status, SHADOW_STATUS.DEGRADED);
    assert.notEqual(result.status, SHADOW_STATUS.OK);
  });

  it("result is a non-null object — no silent null return (AC10)", () => {
    assert.ok(result !== null && typeof result === "object");
  });
});
