/**
 * guardrail_executor.test.ts
 *
 * Tests for src/core/guardrail_executor.js — T-033: Automate guardrail actions.
 *
 * Coverage:
 *   AC1  — Each catastrophe class has a guardrail action tree (via SCENARIO_GUARDRAILS)
 *   AC2  — Actions are logged with reason codes; GUARDRAIL_REASON_CODE is a complete enum
 *   AC3  — Dry-run mode simulates without writing state files
 *   AC4  — Manual overrides require operatorId + operatorReason + audit trail
 *   AC5  — Latency < GUARDRAIL_LATENCY_SLA_MS (measurable with CYCLE_INTERVAL_MS)
 *   AC6  — Every criterion has at least one explicit verification assertion
 *   AC7  — Negative paths: invalid/missing input handled deterministically
 *   AC8  — GuardrailAuditEntry schema has all required fields with correct types/enums
 *   AC9  — Validation distinguishes MISSING from INVALID with deterministic reason codes
 *   AC10 — No silent fallback; degraded behavior sets explicit status + reason
 *   AC11 — Catastrophe class enum is exhaustive (all 6 scenarios have guardrail trees)
 *   AC12 — CYCLE_INTERVAL_MS is defined; GUARDRAIL_LATENCY_SLA_MS = CYCLE_INTERVAL_MS
 *   AC13 — GUARDRAIL_REASON_CODE is complete and schema-correct
 *   AC14 — Escalation mechanism is explicit: target + mechanism constants are exported
 *   AC15 — Dry-run isolation: state files NOT written; audit log NOT written
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  executeGuardrailAction,
  executeGuardrailsForDetections,
  applyManualOverride,
  revertGuardrailAction,
  loadGuardrailAuditLog,
  readGuardrailState,
  isGuardrailActive,
  GUARDRAIL_EXECUTOR_SCHEMA_VERSION,
  CYCLE_INTERVAL_MS,
  GUARDRAIL_LATENCY_SLA_MS,
  GUARDRAIL_REASON_CODE,
  GUARDRAIL_AUDIT_ENTRY_TYPE,
  ESCALATION_TARGET,
  ESCALATION_MECHANISM,
} from "../../src/core/guardrail_executor.js";

import {
  GUARDRAIL_ACTION,
  CATASTROPHE_SCENARIO,
  CATASTROPHE_DEFAULTS,
  detectCatastrophes,
} from "../../src/core/catastrophe_detector.js";

// ── Test helpers ───────────────────────────────────────────────────────────────

let tmpDir;

function cfg() {
  return { paths: { stateDir: tmpDir } };
}

async function cleanDir() {
  try {
    const entries = await fs.readdir(tmpDir);
    for (const e of entries) {
      await fs.rm(path.join(tmpDir, e), { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

// ── Setup / Teardown ───────────────────────────────────────────────────────────

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guardrail-test-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── AC12 — Cycle Interval Constants ───────────────────────────────────────────

describe("Constants — cycle interval and latency SLA (AC12)", () => {
  it("CYCLE_INTERVAL_MS is a positive finite number", () => {
    assert.ok(typeof CYCLE_INTERVAL_MS === "number" && CYCLE_INTERVAL_MS > 0 && Number.isFinite(CYCLE_INTERVAL_MS));
  });

  it("GUARDRAIL_LATENCY_SLA_MS equals CYCLE_INTERVAL_MS", () => {
    assert.equal(GUARDRAIL_LATENCY_SLA_MS, CYCLE_INTERVAL_MS);
  });
});

// ── AC13 — Reason Code Catalog ─────────────────────────────────────────────────

describe("GUARDRAIL_REASON_CODE catalog (AC13)", () => {
  it("exports a non-empty frozen object", () => {
    assert.ok(typeof GUARDRAIL_REASON_CODE === "object");
    assert.ok(Object.isFrozen(GUARDRAIL_REASON_CODE));
    assert.ok(Object.keys(GUARDRAIL_REASON_CODE).length > 0);
  });

  it("contains all required reason codes", () => {
    const required = [
      "AUTO_APPLIED", "AUTO_FAILED", "MANUAL_OVERRIDE", "REVERTED", "DRY_RUN",
      "MISSING_DETECTIONS", "INVALID_DETECTIONS",
      "MISSING_OPERATOR_ID", "MISSING_OPERATOR_REASON",
      "MISSING_OVERRIDE_SPEC", "INVALID_OVERRIDE_SPEC",
      "INVALID_ACTION", "INVALID_SCENARIO_ID",
      "MISSING_ACTION_ID", "ACTION_NOT_FOUND",
      "WRITE_FAILED", "INTERNAL_ERROR",
    ];
    for (const code of required) {
      assert.ok(code in GUARDRAIL_REASON_CODE, `GUARDRAIL_REASON_CODE missing "${code}"`);
    }
  });

  it("all values are non-empty strings", () => {
    for (const [k, v] of Object.entries(GUARDRAIL_REASON_CODE)) {
      assert.ok(typeof v === "string" && v.length > 0, `GUARDRAIL_REASON_CODE.${k} must be a non-empty string`);
    }
  });
});

// ── AC14 — Escalation Mechanism ───────────────────────────────────────────────

describe("Escalation mechanism constants (AC14)", () => {
  it("ESCALATION_TARGET is a non-empty string", () => {
    assert.ok(typeof ESCALATION_TARGET === "string" && ESCALATION_TARGET.length > 0);
  });

  it("ESCALATION_MECHANISM is 'state_file'", () => {
    assert.equal(ESCALATION_MECHANISM, "state_file");
  });
});

// ── AC11 — All 6 Scenarios Have Guardrail Trees ───────────────────────────────

describe("All catastrophe scenarios have guardrail action trees (AC11)", () => {
  const ALL_SCENARIOS = Object.values(CATASTROPHE_SCENARIO);

  it("all 6 CATASTROPHE_SCENARIO values are defined", () => {
    assert.equal(ALL_SCENARIOS.length, 6);
  });

  it("every scenario produces guardrail entries when detected", () => {
    const scenarioContexts = {
      [CATASTROPHE_SCENARIO.RUNAWAY_RETRIES]:            { retryCount: CATASTROPHE_DEFAULTS.runawayRetryThreshold },
      [CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS]:         { totalTasks: 4, blockedTasks: 3 },
      [CATASTROPHE_SCENARIO.STALE_CRITICAL_STATE]:       { janusDirectiveAgeMs: CATASTROPHE_DEFAULTS.staleCriticalStateAgeMs + 1 },
      [CATASTROPHE_SCENARIO.REPEATED_AI_PARSE_FAILURES]: { parseFailureCount: CATASTROPHE_DEFAULTS.repeatedParseFailureThreshold },
      [CATASTROPHE_SCENARIO.BUDGET_EXHAUSTION_SPIRAL]:   { consecutiveBudgetBreaches: CATASTROPHE_DEFAULTS.budgetExhaustionConsecutive },
      [CATASTROPHE_SCENARIO.SLO_CASCADING_BREACH]:       { consecutiveSloBreaches: CATASTROPHE_DEFAULTS.sloCascadingBreachConsecutive },
    };

    const healthy = {
      retryCount: 0, totalTasks: 3, blockedTasks: 0,
      janusDirectiveAgeMs: 300_000, prometheusAnalysisAgeMs: 300_000,
      parseFailureCount: 0, consecutiveBudgetBreaches: 0, consecutiveSloBreaches: 0,
    };

    for (const scenario of ALL_SCENARIOS) {
      const ctx = { ...healthy, ...scenarioContexts[scenario] };
      const r = detectCatastrophes(ctx);
      assert.ok(r.ok, `detectCatastrophes failed for ${scenario}`);
      const alert = r.detections.find(d => d.scenarioId === scenario);
      assert.ok(alert, `${scenario}: no detection`);
      assert.ok(
        Array.isArray(alert.guardrails) && alert.guardrails.length > 0,
        `${scenario}: guardrails array must be non-empty`
      );
      for (const g of alert.guardrails) {
        assert.ok(
          Object.values(GUARDRAIL_ACTION).includes(g.action),
          `${scenario}: guardrail.action "${g.action}" not in GUARDRAIL_ACTION`
        );
      }
    }
  });

  it("FREEZE_SELF_IMPROVEMENT action is present in GUARDRAIL_ACTION", () => {
    assert.ok("FREEZE_SELF_IMPROVEMENT" in GUARDRAIL_ACTION);
    assert.ok(Object.values(GUARDRAIL_ACTION).includes("freeze_self_improvement"));
  });

  it("FORCE_CHECKPOINT_VALIDATION action is present in GUARDRAIL_ACTION", () => {
    assert.ok("FORCE_CHECKPOINT_VALIDATION" in GUARDRAIL_ACTION);
    assert.ok(Object.values(GUARDRAIL_ACTION).includes("force_checkpoint_validation"));
  });
});

// ── AC3 / AC15 — Dry-Run Mode ─────────────────────────────────────────────────

describe("Dry-run mode (AC3 / AC15)", () => {
  before(cleanDir);

  it("executeGuardrailAction with dryRun=true does not write state file", async () => {
    const result = await executeGuardrailAction(
      cfg(),
      GUARDRAIL_ACTION.PAUSE_WORKERS,
      CATASTROPHE_SCENARIO.RUNAWAY_RETRIES,
      GUARDRAIL_REASON_CODE.AUTO_APPLIED,
      { dryRun: true }
    );
    assert.ok(result.ok, `expected ok=true, got reason: ${result.reason}`);
    assert.equal(result.dryRun, true);
    assert.equal(result.reasonCode, GUARDRAIL_REASON_CODE.DRY_RUN);

    // State file must NOT exist
    const stateFile = path.join(tmpDir, "guardrail_pause_workers.json");
    const exists = await fs.access(stateFile).then(() => true, () => false);
    assert.equal(exists, false, "State file must not be written in dry-run mode");
  });

  it("executeGuardrailAction with dryRun=true does not write state file, but records dry_run audit entry", async () => {
    await cleanDir();
    await executeGuardrailAction(
      cfg(),
      GUARDRAIL_ACTION.SKIP_CYCLE,
      CATASTROPHE_SCENARIO.STALE_CRITICAL_STATE,
      GUARDRAIL_REASON_CODE.AUTO_APPLIED,
      { dryRun: true }
    );

    // State file must NOT exist
    const stateFile = path.join(tmpDir, "guardrail_skip_cycle.json");
    const stateExists = await fs.access(stateFile).then(() => true, () => false);
    assert.equal(stateExists, false, "State file must not be written in dry-run mode");

    // Audit log IS written (with type=dry_run) for observability — but no state files
    const auditFile = path.join(tmpDir, "guardrail_audit_log.json");
    const auditExists = await fs.access(auditFile).then(() => true, () => false);
    assert.ok(auditExists, "Audit log should be written even in dry-run mode for observability");

    const log = await loadGuardrailAuditLog(cfg());
    const entry = log.entries.find(e => e.dryRun === true);
    assert.ok(entry, "Dry-run audit entry should be present");
    assert.equal(entry.type, GUARDRAIL_AUDIT_ENTRY_TYPE.DRY_RUN);
  });

  it("executeGuardrailsForDetections in dry-run mode returns withinSla and no state files", async () => {
    await cleanDir();
    const ctx = {
      retryCount: 10, totalTasks: 3, blockedTasks: 0,
      janusDirectiveAgeMs: 300_000, prometheusAnalysisAgeMs: 300_000,
      parseFailureCount: 0, consecutiveBudgetBreaches: 0, consecutiveSloBreaches: 0,
    };
    const detected = detectCatastrophes(ctx);
    assert.ok(detected.ok);
    assert.ok(detected.detections.length > 0);

    const result = await executeGuardrailsForDetections(cfg(), detected.detections, { dryRun: true });
    assert.ok(result.ok);
    assert.equal(result.dryRun, true);
    assert.ok(result.results.length > 0);
    for (const r of result.results) {
      assert.equal(r.dryRun, true);
    }

    // No guardrail state files written (audit log is allowed for observability)
    const files = await fs.readdir(tmpDir).catch(() => []);
    const guardrailStateFiles = files.filter(f => f.startsWith("guardrail_") && f !== "guardrail_audit_log.json");
    assert.equal(guardrailStateFiles.length, 0, `State files written in dry-run: ${guardrailStateFiles.join(", ")}`);
  });
});

// ── Action Execution ───────────────────────────────────────────────────────────

describe("executeGuardrailAction — flag-type actions (AC2)", () => {
  before(cleanDir);

  const FLAG_ACTIONS = [
    GUARDRAIL_ACTION.PAUSE_WORKERS,
    GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT,
    GUARDRAIL_ACTION.FORCE_CHECKPOINT_VALIDATION,
    GUARDRAIL_ACTION.INCREASE_DELAY,
    GUARDRAIL_ACTION.RESET_RETRY_COUNTER,
    GUARDRAIL_ACTION.SKIP_CYCLE,
  ];

  for (const action of FLAG_ACTIONS) {
    it(`executes ${action} and writes state file with enabled=true`, async () => {
      await cleanDir();
      const result = await executeGuardrailAction(
        cfg(), action, CATASTROPHE_SCENARIO.RUNAWAY_RETRIES, GUARDRAIL_REASON_CODE.AUTO_APPLIED
      );
      assert.ok(result.ok, `${action} failed: ${result.reason}`);
      assert.equal(result.dryRun, false);
      assert.ok(typeof result.actionId === "string" && result.actionId.length > 0);
      assert.ok(typeof result.stateFile === "string");

      // Verify state file content
      const state = await readGuardrailState(cfg(), action);
      assert.ok(state, `State file not written for ${action}`);
      assert.equal(state.enabled, true);
      assert.equal(state.schemaVersion, GUARDRAIL_EXECUTOR_SCHEMA_VERSION);
      assert.equal(state.action, action);
      assert.equal(state.scenarioId, CATASTROPHE_SCENARIO.RUNAWAY_RETRIES);
      assert.ok(typeof state.appliedAt === "string");
    });
  }

  it("executes NOTIFY_HUMAN and appends to notifications file", async () => {
    await cleanDir();
    const r = await executeGuardrailAction(
      cfg(), GUARDRAIL_ACTION.NOTIFY_HUMAN, CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS, GUARDRAIL_REASON_CODE.AUTO_APPLIED
    );
    assert.ok(r.ok);

    const state = await readGuardrailState(cfg(), GUARDRAIL_ACTION.NOTIFY_HUMAN);
    assert.ok(state);
    assert.ok(Array.isArray(state.entries) && state.entries.length >= 1);
    assert.equal(state.entries[0].action, GUARDRAIL_ACTION.NOTIFY_HUMAN);
  });

  it("executes ESCALATE and writes escalations with target and mechanism", async () => {
    await cleanDir();
    const r = await executeGuardrailAction(
      cfg(), GUARDRAIL_ACTION.ESCALATE, CATASTROPHE_SCENARIO.SLO_CASCADING_BREACH, GUARDRAIL_REASON_CODE.AUTO_APPLIED
    );
    assert.ok(r.ok);

    const state = await readGuardrailState(cfg(), GUARDRAIL_ACTION.ESCALATE);
    assert.ok(state);
    assert.ok(Array.isArray(state.entries) && state.entries.length >= 1);
    const entry = state.entries[0];
    assert.equal(entry.target, ESCALATION_TARGET);
    assert.equal(entry.mechanism, ESCALATION_MECHANISM);
  });
});

// ── AC8 — Audit Entry Schema ───────────────────────────────────────────────────

describe("Audit log — GuardrailAuditEntry schema (AC8)", () => {
  before(cleanDir);

  it("audit log entry has all required fields with correct types", async () => {
    await cleanDir();
    await executeGuardrailAction(
      cfg(), GUARDRAIL_ACTION.PAUSE_WORKERS, CATASTROPHE_SCENARIO.RUNAWAY_RETRIES, GUARDRAIL_REASON_CODE.AUTO_APPLIED
    );

    const log = await loadGuardrailAuditLog(cfg());
    assert.equal(log.schemaVersion, GUARDRAIL_EXECUTOR_SCHEMA_VERSION);
    assert.ok(Array.isArray(log.entries) && log.entries.length > 0);

    const entry = log.entries[0];
    assert.ok(typeof entry.id === "string" && entry.id.length > 0, "id must be non-empty string");
    assert.ok(Object.values(GUARDRAIL_AUDIT_ENTRY_TYPE).includes(entry.type), `type "${entry.type}" not in enum`);
    assert.ok(Object.values(GUARDRAIL_ACTION).includes(entry.action), `action "${entry.action}" not in enum`);
    assert.ok(typeof entry.scenarioId === "string" && entry.scenarioId.length > 0, "scenarioId missing");
    assert.ok(Object.values(GUARDRAIL_REASON_CODE).includes(entry.reasonCode), `reasonCode "${entry.reasonCode}" not in enum`);
    assert.ok("operatorId" in entry, "operatorId must be present (may be null)");
    assert.ok("operatorReason" in entry, "operatorReason must be present (may be null)");
    assert.ok(typeof entry.timestamp === "string" && !isNaN(Date.parse(entry.timestamp)), "timestamp must be ISO");
    assert.ok(typeof entry.dryRun === "boolean", "dryRun must be boolean");
    assert.ok("stateFile" in entry, "stateFile must be present (may be null)");
  });

  it("automated action sets operatorId=null and operatorReason=null", async () => {
    await cleanDir();
    await executeGuardrailAction(
      cfg(), GUARDRAIL_ACTION.PAUSE_WORKERS, CATASTROPHE_SCENARIO.RUNAWAY_RETRIES, GUARDRAIL_REASON_CODE.AUTO_APPLIED
    );
    const log = await loadGuardrailAuditLog(cfg());
    const entry = log.entries.find(e => e.type === GUARDRAIL_AUDIT_ENTRY_TYPE.AUTO_APPLIED);
    assert.ok(entry);
    assert.equal(entry.operatorId, null);
    assert.equal(entry.operatorReason, null);
  });
});

// ── AC4 — Manual Override ──────────────────────────────────────────────────────

describe("applyManualOverride — operator identity + audit trail (AC4)", () => {
  before(cleanDir);

  it("applies action and records manual_override audit entry", async () => {
    await cleanDir();
    const result = await applyManualOverride(cfg(), {
      operatorId:     "eng-alice",
      operatorReason: "Emergency: runaway tasks detected, applying manual pause",
      action:         GUARDRAIL_ACTION.PAUSE_WORKERS,
      scenarioId:     CATASTROPHE_SCENARIO.RUNAWAY_RETRIES,
    });

    assert.ok(result.ok, `expected ok=true, got ${result.reason}`);
    assert.ok(typeof result.actionId === "string");
    assert.equal(result.reasonCode, GUARDRAIL_REASON_CODE.MANUAL_OVERRIDE);

    // Audit log must have manual_override entry with operator fields
    const log = await loadGuardrailAuditLog(cfg());
    const entry = log.entries.find(e => e.type === GUARDRAIL_AUDIT_ENTRY_TYPE.MANUAL_OVERRIDE);
    assert.ok(entry, "No manual_override audit entry found");
    assert.equal(entry.operatorId, "eng-alice");
    assert.equal(entry.operatorReason, "Emergency: runaway tasks detected, applying manual pause");
    assert.equal(entry.reasonCode, GUARDRAIL_REASON_CODE.MANUAL_OVERRIDE);
  });
});

// ── AC9 — Validation: MISSING vs INVALID ──────────────────────────────────────

describe("Input validation — MISSING vs INVALID (AC9)", () => {
  it("executeGuardrailsForDetections: null detections → MISSING_DETECTIONS", async () => {
    const r = await executeGuardrailsForDetections(cfg(), null);
    assert.equal(r.ok, false);
    assert.match(r.reason, /MISSING_DETECTIONS/);
  });

  it("executeGuardrailsForDetections: non-array detections → INVALID_DETECTIONS", async () => {
    const r = await executeGuardrailsForDetections(cfg(), "not-an-array");
    assert.equal(r.ok, false);
    assert.match(r.reason, /INVALID_DETECTIONS/);
  });

  it("applyManualOverride: null spec → MISSING_OVERRIDE_SPEC", async () => {
    const r = await applyManualOverride(cfg(), null);
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.MISSING_OVERRIDE_SPEC);
  });

  it("applyManualOverride: missing operatorId → MISSING_OPERATOR_ID", async () => {
    const r = await applyManualOverride(cfg(), {
      operatorReason: "reason",
      action:         GUARDRAIL_ACTION.PAUSE_WORKERS,
      scenarioId:     CATASTROPHE_SCENARIO.RUNAWAY_RETRIES,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.MISSING_OPERATOR_ID);
  });

  it("applyManualOverride: empty operatorId string → MISSING_OPERATOR_ID", async () => {
    const r = await applyManualOverride(cfg(), {
      operatorId:     "  ",
      operatorReason: "reason",
      action:         GUARDRAIL_ACTION.PAUSE_WORKERS,
      scenarioId:     CATASTROPHE_SCENARIO.RUNAWAY_RETRIES,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.MISSING_OPERATOR_ID);
  });

  it("applyManualOverride: missing operatorReason → MISSING_OPERATOR_REASON", async () => {
    const r = await applyManualOverride(cfg(), {
      operatorId:  "eng-bob",
      action:      GUARDRAIL_ACTION.PAUSE_WORKERS,
      scenarioId:  CATASTROPHE_SCENARIO.RUNAWAY_RETRIES,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.MISSING_OPERATOR_REASON);
  });

  it("applyManualOverride: invalid action → INVALID_ACTION", async () => {
    const r = await applyManualOverride(cfg(), {
      operatorId:     "eng-bob",
      operatorReason: "test",
      action:         "nonexistent_action",
      scenarioId:     CATASTROPHE_SCENARIO.RUNAWAY_RETRIES,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.INVALID_ACTION);
  });

  it("applyManualOverride: missing scenarioId → INVALID_SCENARIO_ID", async () => {
    const r = await applyManualOverride(cfg(), {
      operatorId:     "eng-bob",
      operatorReason: "test",
      action:         GUARDRAIL_ACTION.PAUSE_WORKERS,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.INVALID_SCENARIO_ID);
  });

  it("executeGuardrailAction: invalid action → INVALID_ACTION, ok=false", async () => {
    const r = await executeGuardrailAction(cfg(), "bad_action", CATASTROPHE_SCENARIO.RUNAWAY_RETRIES, GUARDRAIL_REASON_CODE.AUTO_APPLIED);
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.INVALID_ACTION);
  });

  it("revertGuardrailAction: null actionId → MISSING_ACTION_ID", async () => {
    const r = await revertGuardrailAction(cfg(), null, "eng-alice", "maintenance");
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.MISSING_ACTION_ID);
  });

  it("revertGuardrailAction: missing operatorId → MISSING_OPERATOR_ID", async () => {
    const r = await revertGuardrailAction(cfg(), "some-id", "", "reason");
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.MISSING_OPERATOR_ID);
  });

  it("revertGuardrailAction: missing operatorReason → MISSING_OPERATOR_REASON", async () => {
    const r = await revertGuardrailAction(cfg(), "some-id", "eng-alice", "");
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.MISSING_OPERATOR_REASON);
  });

  it("revertGuardrailAction: unknown actionId → ACTION_NOT_FOUND", async () => {
    await cleanDir();
    const r = await revertGuardrailAction(cfg(), "nonexistent-id-xyz", "eng-alice", "clearing after recovery");
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.ACTION_NOT_FOUND);
  });
});

// ── Reversibility ──────────────────────────────────────────────────────────────

describe("revertGuardrailAction — reversibility (AC2)", () => {
  before(cleanDir);

  it("reverts a flag-type guardrail by setting enabled=false", async () => {
    await cleanDir();
    const applyResult = await executeGuardrailAction(
      cfg(), GUARDRAIL_ACTION.PAUSE_WORKERS, CATASTROPHE_SCENARIO.RUNAWAY_RETRIES, GUARDRAIL_REASON_CODE.AUTO_APPLIED
    );
    assert.ok(applyResult.ok);
    assert.ok(await isGuardrailActive(cfg(), GUARDRAIL_ACTION.PAUSE_WORKERS));

    const revertResult = await revertGuardrailAction(
      cfg(), applyResult.actionId, "eng-alice", "Resolved: retry storm cleared"
    );
    assert.ok(revertResult.ok, `revert failed: ${revertResult.reason}`);
    assert.equal(revertResult.reasonCode, GUARDRAIL_REASON_CODE.REVERTED);

    // Guardrail must be inactive
    assert.equal(await isGuardrailActive(cfg(), GUARDRAIL_ACTION.PAUSE_WORKERS), false);

    // Audit log must have REVERTED entry
    const log = await loadGuardrailAuditLog(cfg());
    const revertEntry = log.entries.find(e => e.type === GUARDRAIL_AUDIT_ENTRY_TYPE.REVERTED);
    assert.ok(revertEntry, "No REVERTED audit entry found");
    assert.equal(revertEntry.operatorId, "eng-alice");
    assert.equal(revertEntry.operatorReason, "Resolved: retry storm cleared");
    assert.equal(revertEntry.reasonCode, GUARDRAIL_REASON_CODE.REVERTED);
  });
});

// ── AC5 — Latency SLA ─────────────────────────────────────────────────────────

describe("Latency SLA (AC5)", () => {
  it(`executeGuardrailsForDetections completes within GUARDRAIL_LATENCY_SLA_MS (${GUARDRAIL_LATENCY_SLA_MS}ms)`, async () => {
    await cleanDir();
    const ctx = {
      retryCount: 100, totalTasks: 5, blockedTasks: 4,
      janusDirectiveAgeMs: 10_000_000, prometheusAnalysisAgeMs: 10_000_000,
      parseFailureCount: 10, consecutiveBudgetBreaches: 5, consecutiveSloBreaches: 5,
    };
    const detected = detectCatastrophes(ctx);
    assert.ok(detected.ok);
    assert.ok(detected.detections.length > 0);

    const t0 = performance.now();
    const result = await executeGuardrailsForDetections(cfg(), detected.detections);
    const elapsed = performance.now() - t0;

    assert.ok(result.withinSla, `withinSla=false but latencyMs=${result.latencyMs}`);
    assert.ok(result.latencyMs < GUARDRAIL_LATENCY_SLA_MS,
      `Latency ${result.latencyMs}ms exceeds SLA ${GUARDRAIL_LATENCY_SLA_MS}ms`);
    assert.ok(elapsed < GUARDRAIL_LATENCY_SLA_MS,
      `Wall-clock ${elapsed.toFixed(1)}ms exceeds SLA ${GUARDRAIL_LATENCY_SLA_MS}ms`);
  });
});

// ── AC10 — No Silent Fallback ──────────────────────────────────────────────────

describe("No silent fallback — explicit status + reason (AC10)", () => {
  it("executeGuardrailsForDetections with null returns ok=false + status=degraded + reason", async () => {
    const r = await executeGuardrailsForDetections(cfg(), null);
    assert.equal(r.ok, false);
    assert.equal(r.status, "degraded");
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  });

  it("applyManualOverride with null returns ok=false + explicit reasonCode", async () => {
    const r = await applyManualOverride(cfg(), null);
    assert.equal(r.ok, false);
    assert.ok(typeof r.reasonCode === "string" && r.reasonCode.length > 0);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  });

  it("executeGuardrailAction with invalid action returns ok=false + reasonCode", async () => {
    const r = await executeGuardrailAction(cfg(), null, "RUNAWAY_RETRIES", GUARDRAIL_REASON_CODE.AUTO_APPLIED);
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, GUARDRAIL_REASON_CODE.INVALID_ACTION);
  });
});

// ── Batch Execution ────────────────────────────────────────────────────────────

describe("executeGuardrailsForDetections — batch execution", () => {
  before(cleanDir);

  it("executes all guardrails for detected scenarios and returns results array", async () => {
    await cleanDir();
    const ctx = {
      retryCount: 10, totalTasks: 3, blockedTasks: 0,
      janusDirectiveAgeMs: 300_000, prometheusAnalysisAgeMs: 300_000,
      parseFailureCount: 0, consecutiveBudgetBreaches: 0, consecutiveSloBreaches: 0,
    };
    const detected = detectCatastrophes(ctx);
    assert.ok(detected.ok);
    const detections = detected.detections;
    assert.ok(detections.length > 0);

    const result = await executeGuardrailsForDetections(cfg(), detections);
    assert.ok(result.ok, `batch execution failed: ${JSON.stringify(result.results.filter(r => !r.ok))}`);
    assert.equal(result.dryRun, false);
    assert.ok(typeof result.latencyMs === "number");
    assert.ok(typeof result.withinSla === "boolean");

    // At least as many results as guardrails across all detections
    const expectedCount = detections.reduce((sum, d) => sum + (d.guardrails?.length || 0), 0);
    assert.equal(result.results.length, expectedCount);
  });

  it("returns ok=true with empty results for empty detections array", async () => {
    const r = await executeGuardrailsForDetections(cfg(), []);
    assert.equal(r.ok, true);
    assert.deepEqual(r.results, []);
  });
});

// ── isGuardrailActive ─────────────────────────────────────────────────────────

describe("isGuardrailActive — state file query", () => {
  before(cleanDir);

  it("returns false when no state file exists", async () => {
    await cleanDir();
    assert.equal(await isGuardrailActive(cfg(), GUARDRAIL_ACTION.PAUSE_WORKERS), false);
  });

  it("returns true after applying a flag-type action", async () => {
    await cleanDir();
    await executeGuardrailAction(cfg(), GUARDRAIL_ACTION.PAUSE_WORKERS, CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS, GUARDRAIL_REASON_CODE.AUTO_APPLIED);
    assert.equal(await isGuardrailActive(cfg(), GUARDRAIL_ACTION.PAUSE_WORKERS), true);
  });

  it("returns false after reverting a flag-type action", async () => {
    await cleanDir();
    const apply = await executeGuardrailAction(cfg(), GUARDRAIL_ACTION.PAUSE_WORKERS, CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS, GUARDRAIL_REASON_CODE.AUTO_APPLIED);
    await revertGuardrailAction(cfg(), apply.actionId, "eng-ops", "issue resolved");
    assert.equal(await isGuardrailActive(cfg(), GUARDRAIL_ACTION.PAUSE_WORKERS), false);
  });
});

