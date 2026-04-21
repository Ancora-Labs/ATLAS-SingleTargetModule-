/**
 * guardrail_integration.test.ts
 *
 * Integration tests for T-033: Automated guardrail enforcement in the runtime.
 *
 * These tests exercise the integration between catastrophe detection, guardrail
 * execution, and runtime enforcement in self_improvement.js.
 *
 * Coverage:
 *   AC1  — Catastrophe classes map to guardrail actions that are executed automatically
 *   AC2  — Guardrail state files are written with reason codes when enforced
 *   AC3  — Dry-run isolation: passing dryRun=true prevents state writes
 *   AC5  — executeGuardrailsForDetections returns withinSla=true (measurable latency)
 *   AC7  — Negative path: FREEZE_SELF_IMPROVEMENT inactive → cycle proceeds normally
 *   AC10 — Degraded: when guardrail executor receives invalid input, status=degraded
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  executeGuardrailsForDetections,
  isGuardrailActive,
  executeGuardrailAction,
  GUARDRAIL_REASON_CODE,
  GUARDRAIL_LATENCY_SLA_MS,
} from "../../src/core/guardrail_executor.js";

import {
  detectCatastrophes,
  GUARDRAIL_ACTION,
  CATASTROPHE_SCENARIO,
  CATASTROPHE_DEFAULTS,
} from "../../src/core/catastrophe_detector.js";

import {
  runSelfImprovementCycle,
} from "../../src/core/self_improvement.js";

// ── Test helpers ───────────────────────────────────────────────────────────────

let tmpDir;

function cfg(overrides = {}) {
  return {
    paths:           {
      stateDir:     tmpDir,
      progressFile: path.join(tmpDir, "progress.txt"),
    },
    selfImprovement: { enabled: true },
    systemGuardian:  { enabled: true },
    ...overrides,
  };
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "guardrail-int-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── AC1 — Automated execution when catastrophes are detected ──────────────────

describe("Automated guardrail execution from catastrophe detections (AC1)", () => {
  it("executeGuardrailsForDetections writes guardrail state files for real detections", async () => {
    await cleanDir();

    // Trigger RUNAWAY_RETRIES
    const ctx = {
      retryCount: CATASTROPHE_DEFAULTS.runawayRetryThreshold,
      totalTasks: 3, blockedTasks: 0,
      janusDirectiveAgeMs: 300_000, prometheusAnalysisAgeMs: 300_000,
      parseFailureCount: 0, consecutiveBudgetBreaches: 0, consecutiveSloBreaches: 0,
    };
    const detected = detectCatastrophes(ctx);
    assert.ok(detected.ok);
    assert.ok(detected.detections.length > 0, "Expected at least one detection");

    const result = await executeGuardrailsForDetections(cfg(), detected.detections);
    assert.ok(result.ok, `Expected ok=true, got reason: ${JSON.stringify(result.results.filter(r => !r.ok))}`);
    assert.ok(result.results.length > 0, "Expected at least one guardrail result");

    // Verify at least one state file was written (RUNAWAY_RETRIES triggers RESET_RETRY_COUNTER, etc.)
    const files = await fs.readdir(tmpDir);
    const guardrailFiles = files.filter(f => f.startsWith("guardrail_") && f !== "guardrail_audit_log.json");
    assert.ok(guardrailFiles.length > 0, `Expected guardrail state files, got: ${files.join(", ")}`);
  });

  it("guardrails for MASS_BLOCKED_TASKS include PAUSE_WORKERS action", async () => {
    await cleanDir();

    const ctx = {
      retryCount: 0, totalTasks: 4, blockedTasks: 3,
      janusDirectiveAgeMs: 300_000, prometheusAnalysisAgeMs: 300_000,
      parseFailureCount: 0, consecutiveBudgetBreaches: 0, consecutiveSloBreaches: 0,
    };
    const detected = detectCatastrophes(ctx);
    assert.ok(detected.ok);

    const massBlocked = detected.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS);
    assert.ok(massBlocked, "MASS_BLOCKED_TASKS should be detected");

    const actions = massBlocked.guardrails.map(g => g.action);
    assert.ok(actions.includes(GUARDRAIL_ACTION.PAUSE_WORKERS),
      `Expected PAUSE_WORKERS in guardrails, got: ${actions.join(", ")}`);
  });

  it("guardrails for BUDGET_EXHAUSTION_SPIRAL include FREEZE_SELF_IMPROVEMENT action", async () => {
    await cleanDir();

    const ctx = {
      retryCount: 0, totalTasks: 3, blockedTasks: 0,
      janusDirectiveAgeMs: 300_000, prometheusAnalysisAgeMs: 300_000,
      parseFailureCount: 0,
      consecutiveBudgetBreaches: CATASTROPHE_DEFAULTS.budgetExhaustionConsecutive,
      consecutiveSloBreaches: 0,
    };
    const detected = detectCatastrophes(ctx);
    assert.ok(detected.ok);

    const budgetSpiral = detected.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.BUDGET_EXHAUSTION_SPIRAL);
    assert.ok(budgetSpiral, "BUDGET_EXHAUSTION_SPIRAL should be detected");

    const actions = budgetSpiral.guardrails.map(g => g.action);
    assert.ok(actions.includes(GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT),
      `Expected FREEZE_SELF_IMPROVEMENT in guardrails, got: ${actions.join(", ")}`);
  });
});

// ── AC3 — Dry-run isolation ───────────────────────────────────────────────────

describe("Dry-run isolation (AC3) — no state files written in dry-run mode", () => {
  it("executeGuardrailsForDetections dry-run writes NO guardrail state files", async () => {
    await cleanDir();

    const ctx = {
      retryCount: CATASTROPHE_DEFAULTS.runawayRetryThreshold,
      totalTasks: 3, blockedTasks: 0,
      janusDirectiveAgeMs: 300_000, prometheusAnalysisAgeMs: 300_000,
      parseFailureCount: 0, consecutiveBudgetBreaches: 0, consecutiveSloBreaches: 0,
    };
    const detected = detectCatastrophes(ctx);
    assert.ok(detected.ok);
    assert.ok(detected.detections.length > 0);

    await executeGuardrailsForDetections(cfg(), detected.detections, { dryRun: true });

    const files = await fs.readdir(tmpDir);
    const guardrailStateFiles = files.filter(f => f.startsWith("guardrail_") && f !== "guardrail_audit_log.json");
    assert.equal(guardrailStateFiles.length, 0,
      `Dry-run should write NO guardrail state files; found: ${guardrailStateFiles.join(", ")}`);
  });
});

// ── AC5 — Latency SLA ─────────────────────────────────────────────────────────

describe("Latency SLA (AC5) — guardrail execution returns withinSla", () => {
  it(`executeGuardrailsForDetections completes within GUARDRAIL_LATENCY_SLA_MS (${GUARDRAIL_LATENCY_SLA_MS}ms)`, async () => {
    await cleanDir();

    // All 6 scenarios at once
    const ctx = {
      retryCount: 100, totalTasks: 10, blockedTasks: 8,
      janusDirectiveAgeMs: 10_000_000, prometheusAnalysisAgeMs: 10_000_000,
      parseFailureCount: 10,
      consecutiveBudgetBreaches: 5,
      consecutiveSloBreaches: 5,
    };
    const detected = detectCatastrophes(ctx);
    assert.ok(detected.ok);
    assert.equal(detected.detections.length, 6, "Expected all 6 scenarios to fire");

    const result = await executeGuardrailsForDetections(cfg(), detected.detections);
    assert.ok(result.withinSla,
      `withinSla=false: latencyMs=${result.latencyMs} > SLA=${GUARDRAIL_LATENCY_SLA_MS}`);
    assert.ok(result.latencyMs < GUARDRAIL_LATENCY_SLA_MS,
      `latencyMs ${result.latencyMs}ms exceeds SLA ${GUARDRAIL_LATENCY_SLA_MS}ms`);
  });
});

// ── FREEZE_SELF_IMPROVEMENT enforcement in runSelfImprovementCycle ────────────

describe("FREEZE_SELF_IMPROVEMENT enforcement in self_improvement (AC1/AC7)", () => {
  it("runSelfImprovementCycle returns null when FREEZE_SELF_IMPROVEMENT guardrail is active", async () => {
    await cleanDir();

    // Write the freeze guardrail state file directly
    await executeGuardrailAction(
      cfg(),
      GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT,
      CATASTROPHE_SCENARIO.RUNAWAY_RETRIES,
      GUARDRAIL_REASON_CODE.AUTO_APPLIED
    );

    // Verify guardrail is active
    assert.ok(await isGuardrailActive(cfg(), GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT),
      "FREEZE_SELF_IMPROVEMENT guardrail should be active");

    // runSelfImprovementCycle should return null without proceeding
    const result = await runSelfImprovementCycle(cfg());
    assert.equal(result, null, "Expected null when FREEZE_SELF_IMPROVEMENT guardrail is active");
  });

  // AC7 — negative path: guardrail NOT active → function proceeds past the guardrail gate
  it("runSelfImprovementCycle proceeds past guardrail gate when FREEZE_SELF_IMPROVEMENT is NOT active (negative path)", async () => {
    await cleanDir();

    // No freeze guardrail written — should be inactive
    assert.equal(
      await isGuardrailActive(cfg(), GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT),
      false,
      "FREEZE_SELF_IMPROVEMENT guardrail should NOT be active"
    );

    // runSelfImprovementCycle will proceed past the guardrail check.
    // With no state files it will hit the "No plans or progress found" early return.
    // The important assertion is that it does NOT return null due to the guardrail.
    // We verify by checking the progress log for the correct early-return reason.
    // (Function returns null at "No plans" — not the guardrail gate.)
    const result = await runSelfImprovementCycle(cfg());
    // It should return null due to empty state, not the freeze guardrail
    // (The guardrail gate logs "[SELF-IMPROVEMENT] Skipped: FREEZE..." which we must NOT see)
    const progressFile = path.join(tmpDir, "progress.txt");
    const progressExists = await fs.access(progressFile).then(() => true, () => false);
    if (progressExists) {
      const progressContent = await fs.readFile(progressFile, "utf8");
      assert.ok(
        !progressContent.includes("FREEZE_SELF_IMPROVEMENT guardrail is active"),
        "Progress log must not contain FREEZE guardrail message when guardrail is inactive"
      );
    }
    // Result is null because no plans exist (not because of guardrail)
    assert.equal(result, null);
  });

  it("systemGuardian.enabled=false bypasses guardrail check (rollback path)", async () => {
    await cleanDir();

    // Write the freeze guardrail state file
    await executeGuardrailAction(
      cfg(),
      GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT,
      CATASTROPHE_SCENARIO.BUDGET_EXHAUSTION_SPIRAL,
      GUARDRAIL_REASON_CODE.AUTO_APPLIED
    );

    // With systemGuardian.enabled=false, guardrail check is skipped
    const rollbackConfig = {
      paths: {
        stateDir:     tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
      },
      selfImprovement: { enabled: true },
      systemGuardian:  { enabled: false },
    };
    // Function should proceed (will hit "No plans" and return null, not the guardrail gate)
    const result = await runSelfImprovementCycle(rollbackConfig);

    // Verify no freeze message logged (guardrail not checked)
    const progressFile = path.join(tmpDir, "progress.txt");
    const progressExists = await fs.access(progressFile).then(() => true, () => false);
    if (progressExists) {
      const progressContent = await fs.readFile(progressFile, "utf8");
      assert.ok(
        !progressContent.includes("FREEZE_SELF_IMPROVEMENT guardrail is active"),
        "Progress log must not contain FREEZE guardrail message when systemGuardian.enabled=false"
      );
    }
    assert.equal(result, null, "Function should return null (no plans), not be blocked by guardrail");
  });
});

// ── AC2 — Reversibility: guardrail state has reasonCode (AC2) ─────────────────

describe("Guardrail state file has reasonCode (AC2)", () => {
  it("executed guardrail state file includes reasonCode and scenarioId", async () => {
    await cleanDir();

    await executeGuardrailAction(
      cfg(),
      GUARDRAIL_ACTION.PAUSE_WORKERS,
      CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS,
      GUARDRAIL_REASON_CODE.AUTO_APPLIED
    );

    const stateFile = path.join(tmpDir, "guardrail_pause_workers.json");
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));

    assert.equal(state.reasonCode, GUARDRAIL_REASON_CODE.AUTO_APPLIED);
    assert.equal(state.scenarioId, CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS);
    assert.equal(state.action, GUARDRAIL_ACTION.PAUSE_WORKERS);
    assert.equal(state.enabled, true);
  });
});

// ── AC10 — No silent fallback ──────────────────────────────────────────────────

describe("No silent fallback (AC10) — invalid inputs return explicit status=degraded", () => {
  it("executeGuardrailsForDetections with null returns ok=false, status=degraded, and reason", async () => {
    const r = await executeGuardrailsForDetections(cfg(), null);
    assert.equal(r.ok, false);
    assert.equal(r.status, "degraded");
    assert.ok(typeof r.reason === "string" && r.reason.length > 0, "reason must be a non-empty string");
    assert.ok(r.reason.includes("MISSING_DETECTIONS"), `reason must include MISSING_DETECTIONS, got: ${r.reason}`);
  });

  it("executeGuardrailsForDetections with non-array returns ok=false, status=degraded", async () => {
    const r = await executeGuardrailsForDetections(cfg(), "invalid");
    assert.equal(r.ok, false);
    assert.equal(r.status, "degraded");
    assert.ok(r.reason.includes("INVALID_DETECTIONS"), `reason must include INVALID_DETECTIONS, got: ${r.reason}`);
  });
});

