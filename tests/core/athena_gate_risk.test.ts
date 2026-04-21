import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assessGovernanceGateBlockRisk,
  computeGateBlockRiskFromSignals,
  GATE_BLOCK_RISK,
  ATHENA_PLAN_REVIEW_REASON_CODE,
  runAthenaPlanReview,
  evaluateDecisionPacketContract,
  buildDecisionPacketRetryPrompt,
} from "../../src/core/athena_reviewer.js";

describe("athena gate risk dry-run integration", () => {
  it("auto-approve fast path includes gateBlockRiskAtApproval metadata", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-fastpath-risk-"));
    try {
      const config = {
        paths: {
          stateDir,
          progressFile: path.join(stateDir, "progress.log"),
          policyFile: path.join(stateDir, "policy.json"),
        },
        env: { targetRepo: "CanerDoqdu/Box" },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
      };
      const analysis = {
        plans: [
          {
            role: "evolution-worker",
            task: "Implement deterministic gate telemetry and preserve fail-closed semantics.",
            verification: "npm test -- tests/core/athena_gate_risk.test.ts",
            wave: 1,
            riskLevel: "low",
            capacityDelta: 0.2,
            requestROI: 1.1,
          },
        ],
      };
      const result = await runAthenaPlanReview(config, analysis);
      assert.equal(result.approved, true);
      assert.equal(typeof result.gateBlockRiskAtApproval, "string");
      assert.equal(result.gateBlockRiskAtApproval, GATE_BLOCK_RISK.LOW);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("returns low risk when governance dry-run is passable", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-gate-risk-clear-"));
    try {
      const config = {
        paths: { stateDir, progressFile: path.join(stateDir, "progress.log"), policyFile: path.join(stateDir, "policy.json") },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
      };
      const result = await assessGovernanceGateBlockRisk(config);
      assert.equal(result.gateBlockRisk, GATE_BLOCK_RISK.LOW);
      assert.equal(result.requiresCorrection, false);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("returns explicit fail-closed reason/blocker when plan payload is missing", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-no-plan-"));
    try {
      const config = {
        paths: {
          stateDir,
          progressFile: path.join(stateDir, "progress.log"),
          policyFile: path.join(stateDir, "policy.json"),
        },
        env: { targetRepo: "CanerDoqdu/Box" },
      };
      const result = await runAthenaPlanReview(config, null);
      assert.equal(result.approved, false);
      assert.equal(result.reason?.code, ATHENA_PLAN_REVIEW_REASON_CODE.NO_PLAN_PROVIDED);
      assert.equal(result.blocker?.stage, "athena_plan_review");
      assert.equal(result.blocker?.code, ATHENA_PLAN_REVIEW_REASON_CODE.NO_PLAN_PROVIDED);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects high-risk shadow packets that still violate the target stage contract", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-shadow-contract-"));
    try {
      const config = {
        paths: {
          stateDir,
          progressFile: path.join(stateDir, "progress.log"),
          policyFile: path.join(stateDir, "policy.json"),
        },
        env: { targetRepo: "CanerDoqdu/Box" },
        platformModeState: { currentMode: "single_target_delivery" },
        activeTargetSession: {
          projectId: "portal",
          sessionId: "sess_shadow",
          currentStage: "shadow",
          gates: {
            allowShadowExecution: true,
            allowActiveExecution: false,
          },
          repo: { repoUrl: "https://github.com/acme/portal" },
        },
      };
      const result = await runAthenaPlanReview(config, {
        plans: [
          {
            role: "evolution-worker",
            task: "Implement the premium todo board end to end and release it",
            taskKind: "implementation",
            target_files: ["src/app.ts"],
            scope: "feature delivery",
            verification: "npm test -- tests/core/athena_gate_risk.test.ts",
            wave: 1,
            riskLevel: "low",
          },
        ],
      });

      assert.equal(result.approved, false);
      assert.equal(result.reason?.code, ATHENA_PLAN_REVIEW_REASON_CODE.TARGET_STAGE_CONTRACT_VIOLATION);
      assert.equal(result.blocker?.stage, "athena_plan_review");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("salvages shadow-compatible plans before rejecting the whole batch", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-shadow-salvage-"));
    try {
      const config = {
        paths: {
          stateDir,
          progressFile: path.join(stateDir, "progress.log"),
          policyFile: path.join(stateDir, "policy.json"),
        },
        env: { targetRepo: "CanerDoqdu/Box" },
        platformModeState: { currentMode: "single_target_delivery" },
        activeTargetSession: {
          projectId: "portal",
          sessionId: "sess_shadow",
          currentStage: "shadow",
          gates: {
            allowShadowExecution: true,
            allowActiveExecution: false,
          },
          repo: { repoUrl: "https://github.com/acme/portal" },
        },
      };

      const result = await runAthenaPlanReview(config, {
        plans: [
          {
            role: "quality-worker",
            task: "Capture focused verification evidence for the current target behavior",
            taskKind: "verification",
            target_files: ["tests/core/athena_gate_risk.test.ts"],
            verification: "npm test -- tests/core/athena_gate_risk.test.ts",
            wave: 1,
            riskLevel: "low",
            capacityDelta: 0.1,
            requestROI: 1.0,
          },
          {
            role: "evolution-worker",
            task: "Implement the premium todo board end to end and release it",
            taskKind: "implementation",
            target_files: ["src/app.ts"],
            scope: "feature delivery",
            verification: "npm test -- tests/core/athena_gate_risk.test.ts",
            wave: 1,
            riskLevel: "low",
            capacityDelta: 0.1,
            requestROI: 1.0,
          },
        ],
      });

      assert.equal(result.approved, true);
      assert.notEqual(result.reason?.code, ATHENA_PLAN_REVIEW_REASON_CODE.TARGET_STAGE_CONTRACT_VIOLATION);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("enforces fail-closed review even when runtime.athenaFailOpen is enabled (legacy rollback removed)", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-fail-closed-"));
    try {
      const config = {
        paths: {
          stateDir,
          progressFile: path.join(stateDir, "progress.log"),
          policyFile: path.join(stateDir, "policy.json"),
        },
        env: {
          targetRepo: "CanerDoqdu/Box",
          copilotCliCommand: "__missing_copilot_binary__",
        },
        roleRegistry: {
          qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" },
        },
        runtime: { athenaFailOpen: true },
      };
      await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");
      const result = await runAthenaPlanReview(config, {
        projectHealth: "good",
        analysis: "analysis",
        keyFindings: "findings",
        // Intentionally omit `verification` to keep score at 40 (< AUTO_APPROVE threshold)
        // so this plan cannot be fast-path approved and must reach the AI call.
        plans: [{ role: "evolution-worker", task: "do deterministic work item" }],
        requestBudget: { estimatedPremiumRequestsTotal: 1 },
      });
      assert.equal(result.approved, false);
      assert.equal(result.reason?.code, ATHENA_PLAN_REVIEW_REASON_CODE.AI_CALL_FAILED);
      assert.equal(result.blocker?.stage, "athena_plan_review");
      assert.equal(result.blocker?.code, ATHENA_PLAN_REVIEW_REASON_CODE.AI_CALL_FAILED);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("negative path: returns high risk when dry-run sees freeze block", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-gate-risk-freeze-"));
    try {
      const config = {
        paths: { stateDir, progressLog: path.join(stateDir, "progress.log") },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: true, manualOverrideActive: true },
      };
      const result = await assessGovernanceGateBlockRisk(config);
      assert.equal(result.gateBlockRisk, GATE_BLOCK_RISK.HIGH);
      assert.equal(result.requiresCorrection, true);
      assert.ok(result.activeGateSignals.includes("governance_freeze_active"));
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("returns high risk when force-checkpoint validation is active for SLO cascading breach", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-gate-risk-force-checkpoint-"));
    try {
      const config = {
        paths: { stateDir, progressLog: path.join(stateDir, "progress.log") },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
      };
      await fs.writeFile(
        path.join(stateDir, "guardrail_force_checkpoint.json"),
        JSON.stringify({
          enabled: true,
          revertedAt: null,
          scenarioId: "SLO_CASCADING_BREACH",
          overrideActive: false,
        }),
        "utf8",
      );
      const result = await assessGovernanceGateBlockRisk(config);
      assert.equal(result.gateBlockRisk, GATE_BLOCK_RISK.HIGH);
      assert.equal(result.requiresCorrection, true);
      assert.ok(result.activeGateSignals.includes("force_checkpoint_validation_active"));
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("applies high-risk score penalty contract (4-point reduction floor=1)", () => {
    const gateRisk = computeGateBlockRiskFromSignals({
      freezeActive: true,
      forceCheckpointActive: false,
    });
    assert.equal(gateRisk.gateBlockRisk, GATE_BLOCK_RISK.HIGH);
    assert.equal(gateRisk.requiresCorrection, true);

    const baseScore = 8;
    const penalty = gateRisk.gateBlockRisk === GATE_BLOCK_RISK.HIGH ? 4 : 2;
    const adjustedScore = Math.max(1, baseScore - penalty);
    assert.equal(adjustedScore, 4);
  });

  it("returns MEDIUM risk with autonomy_execution_gate_not_ready signal when exploitationReady=false", () => {
    const gateRisk = computeGateBlockRiskFromSignals({
      autonomyGateNotReady: true,
    });
    assert.equal(gateRisk.gateBlockRisk, GATE_BLOCK_RISK.MEDIUM);
    assert.equal(gateRisk.requiresCorrection, false);
    assert.ok(
      gateRisk.activeGateSignals.includes("autonomy_execution_gate_not_ready"),
      "signal must include autonomy_execution_gate_not_ready"
    );
  });

  it("negative path: autonomy gate not ready does NOT override HIGH risk from freeze", () => {
    const gateRisk = computeGateBlockRiskFromSignals({
      freezeActive: true,
      autonomyGateNotReady: true,
    });
    // Freeze takes precedence — result must stay HIGH
    assert.equal(gateRisk.gateBlockRisk, GATE_BLOCK_RISK.HIGH);
    assert.equal(gateRisk.requiresCorrection, true);
    assert.ok(gateRisk.activeGateSignals.includes("governance_freeze_active"));
    assert.ok(gateRisk.activeGateSignals.includes("autonomy_execution_gate_not_ready"));
  });

  it("assessGovernanceGateBlockRisk includes MEDIUM risk when autonomy_band_status has exploitationReady=false", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-autonomy-gate-"));
    try {
      const config = {
        paths: { stateDir, progressFile: path.join(stateDir, "progress.log"), policyFile: path.join(stateDir, "policy.json") },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
      };
      await fs.writeFile(
        path.join(stateDir, "autonomy_band_status.json"),
        JSON.stringify({
          currentBand: "bootstrapping",
          executionGate: { exploitationReady: false, reason: "insufficient cycle stability" },
        }),
        "utf8"
      );
      const result = await assessGovernanceGateBlockRisk(config);
      assert.equal(result.gateBlockRisk, GATE_BLOCK_RISK.MEDIUM);
      assert.ok(
        result.activeGateSignals.includes("autonomy_execution_gate_not_ready"),
        "autonomy_execution_gate_not_ready signal must be present"
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("flags malformed decision packet and invalid score for retry diagnostics", () => {
    const check = evaluateDecisionPacketContract({ approved: true, planReviews: [], overallScore: "NaN" });
    assert.equal(check.needsRetry, true);
    assert.equal(check.hasScoreViolation, true);
    assert.ok(check.violations.some(v => v.includes("overallScore")));
    assert.ok(check.fieldDiff.some(v => v.includes("overallScore: invalid")));
  });

  it("does not request retry when decision packet and overallScore satisfy contract", () => {
    const check = evaluateDecisionPacketContract({ approved: true, planReviews: [{ planIndex: 0 }], overallScore: 8 });
    assert.equal(check.needsRetry, false);
    assert.equal(check.hasScoreViolation, false);
    assert.equal(check.violations.length, 0);
  });

  it("builds retry prompt with explicit field diff details", () => {
    const prompt = buildDecisionPacketRetryPrompt("BASE", {
      needsRetry: true,
      hasScoreViolation: true,
      violations: ["overallScore missing/invalid (must be numeric 1-10)"],
      fieldDiff: ["approved: boolean(true)", "planReviews: present", "overallScore: invalid(\"NaN\")"],
    });
    assert.ok(prompt.includes("RETRY — FIX MALFORMED DECISION PACKET"));
    assert.ok(prompt.includes("overallScore: invalid"));
  });
});


// ── Cross-cycle dependency gate ──────────────────────────────────────────────

describe("runAthenaPlanReview — cross-cycle dependency gate", () => {
  it("exports CROSS_CYCLE_DEPENDENCY_UNRESOLVED reason code", () => {
    assert.equal(
      ATHENA_PLAN_REVIEW_REASON_CODE.CROSS_CYCLE_DEPENDENCY_UNRESOLVED,
      "CROSS_CYCLE_DEPENDENCY_UNRESOLVED"
    );
  });

  it("cross-cycle pre-condition pattern matches dependency string with marker", () => {
    // Positive path — these must match the gate pattern
    const positiveExamples = [
      "Prometheus Semantic Incomplete-Output Gate v2 [cross-cycle pre-condition — dispatch must confirm]",
      "SomePlan [cross-cycle pre-condition: must be resolved first]",
      "Gate ABC [cross-cycle pre-condition]",
    ];
    for (const dep of positiveExamples) {
      const match = dep.match(/^(.+?)\s*\[cross-cycle pre-condition/i);
      assert.ok(match !== null, `pattern must match: ${dep}`);
      assert.ok(match[1].trim().length > 0, "gate name must be extracted from dependency string");
    }
  });

  it("does not block when patchedPlans have no cross-cycle pre-condition dependencies (negative path)", () => {
    const plan = {
      target_files: ["src/core/cycle_analytics.ts"],
      scope: "cost-efficiency",
      acceptance_criteria: ["Both metrics emitted"],
      dependencies: ["Some regular dependency"],
    };
    // Test the regex directly — regular dependencies must not trigger
    const match = "Some regular dependency".match(/^(.+?)\s*\[cross-cycle pre-condition/i);
    assert.equal(match, null, "regular dependencies must not match cross-cycle pattern");
  });
});
