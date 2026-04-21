import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluatePreDispatchGovernanceGate,
  BLOCK_REASON,
  GATE_PRECEDENCE,
  resolveAthenaCorrectionDispatchBlockReason,
} from "../../src/core/orchestrator.js";

describe("orchestrator governance gate dry-run parity", () => {
  it("returns non-blocked gate decision in clear-state dry-run", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-dryrun-"));
    try {
      const config = {
        paths: { stateDir },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
      };
      const result = await evaluatePreDispatchGovernanceGate(config, [], "dry-run-clear");
      assert.equal(result.blocked, false);
      assert.equal(result.reason, null);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("negative path: reports freeze block in dry-run", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-dryrun-freeze-"));
    try {
      const config = {
        paths: { stateDir },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: true, manualOverrideActive: true },
      };
      const result = await evaluatePreDispatchGovernanceGate(config, [], "dry-run-freeze");
      assert.equal(result.blocked, true);
      assert.ok(String(result.reason || "").startsWith(BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE));
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("blocks dispatch when FORCE_CHECKPOINT_VALIDATION is active for SLO_CASCADING_BREACH", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-force-checkpoint-"));
    try {
      await fs.writeFile(
        path.join(stateDir, "guardrail_force_checkpoint.json"),
        JSON.stringify({
          schemaVersion: 1,
          enabled: true,
          action: "force_checkpoint_validation",
          actionId: "act-1",
          scenarioId: "SLO_CASCADING_BREACH",
          reasonCode: "AUTO_APPLIED",
          appliedAt: new Date().toISOString(),
          revertedAt: null,
        }),
        "utf8",
      );
      const config = {
        paths: { stateDir },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
      };
      const result = await evaluatePreDispatchGovernanceGate(config, [], "force-checkpoint-block");
      assert.equal(result.blocked, true);
      assert.ok(String(result.reason || "").startsWith(`${BLOCK_REASON.GUARDRAIL_FORCE_CHECKPOINT_ACTIVE}:`));
      assert.equal(result.gateIndex, GATE_PRECEDENCE.FORCE_CHECKPOINT);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("blocks dispatch on the canonical autonomy execution gate when exploitationReady=false", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-autonomy-"));
    try {
      await fs.writeFile(
        path.join(stateDir, "autonomy_band_status.json"),
        JSON.stringify({
          currentBand: "bootstrapping",
          executionGate: {
            exploitationReady: false,
            reason: "insufficient_exploitation_window",
          },
        }),
        "utf8",
      );
      const config = {
        paths: { stateDir },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
      };
      const result = await evaluatePreDispatchGovernanceGate(config, [], "autonomy-execution-block");
      assert.equal(result.blocked, true);
      assert.equal(result.gateIndex, GATE_PRECEDENCE.AUTONOMY_EXECUTION);
      assert.equal(result.dispatchBlockReason, `${BLOCK_REASON.AUTONOMY_EXECUTION_GATE_NOT_READY}:insufficient_exploitation_window`);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("override path: allows dispatch and records override audit when force-checkpoint override is active", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-force-checkpoint-override-"));
    try {
      await fs.writeFile(
        path.join(stateDir, "guardrail_force_checkpoint.json"),
        JSON.stringify({
          schemaVersion: 1,
          enabled: true,
          action: "force_checkpoint_validation",
          actionId: "act-2",
          scenarioId: "SLO_CASCADING_BREACH",
          reasonCode: "AUTO_APPLIED",
          appliedAt: new Date().toISOString(),
          revertedAt: null,
          overrideActive: true,
          overrideReason: "incident approved",
          overrideBy: "ops-user",
        }),
        "utf8",
      );
      const config = {
        paths: { stateDir },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
      };
      const result = await evaluatePreDispatchGovernanceGate(config, [], "force-checkpoint-override");
      assert.equal(result.blocked, false);
      assert.equal(result.reason, null);

      const auditLog = await fs.readFile(path.join(stateDir, "governance_gate_audit.jsonl"), "utf8");
      assert.ok(auditLog.includes("\"kind\":\"force_checkpoint_override\""));
      assert.ok(auditLog.includes("\"scenarioId\":\"SLO_CASCADING_BREACH\""));
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("orchestrator governance gate — specialization admission", () => {
  it("does not block when no plans are provided (gate skipped)", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-spec-"));
    try {
      const config = {
        paths: { stateDir },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
      };
      const result = await evaluatePreDispatchGovernanceGate(config, [], "spec-no-plans");
      assert.equal(result.blocked, false);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses bounded fallback and does not block when consecutiveBlockCycles meets max", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-spec-bypass-"));
    try {
      // Write gate state at max to trigger bounded fallback.
      const { SPECIALIZATION_ADMISSION_MAX_BLOCK_CYCLES } = await import("../../src/core/capability_pool.js");
      await fs.writeFile(
        path.join(stateDir, "specialization_gate_state.json"),
        JSON.stringify({ consecutiveBlockCycles: SPECIALIZATION_ADMISSION_MAX_BLOCK_CYCLES }),
        "utf8"
      );
      const config = {
        paths: { stateDir },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
        // Set target requiring 100% specialists — no plan can meet this, but bounded fallback should allow.
        workerPool: { specializationTargets: { minSpecializedShare: 1.0 } },
      };
      // Provide a plan that would normally trigger the specialization gate.
      const plans = [{
        id: "T-spec-bypass",
        task: "fix-bug",
        role: "Evolution Worker",
        files: [],
        verification_commands: ["npm test"],
        acceptance_criteria: ["bug is fixed"],
        dependsOn: [],
      }];
      const result = await evaluatePreDispatchGovernanceGate(config, plans, "spec-bypass-test");
      // Should be non-blocked due to bounded fallback.
      assert.equal(result.blocked, false);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not block when a serialized same-lane batch already bypassed lane diversity", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-spec-serialized-"));
    try {
      const config = {
        paths: { stateDir },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
        workerPool: {
          // This scenario validates specialization-admission bypass behavior; keep
          // lane-diversity gate disabled so it does not mask the specialization result.
          minLanes: 1,
          specializationTargets: { minSpecializedShare: 0.5 },
        },
      };
      const plans = [
        {
          id: "P-serialized-1",
          task: "Fix packet densification backfill",
          role: "evolution-worker",
          target_files: ["src/core/prometheus.ts"],
          verification_commands: ["npm test -- tests/core/prometheus_density_gate.test.ts"],
          acceptance_criteria: ["token floors clamp correctly"],
          dependsOn: [],
        },
        {
          id: "P-serialized-2",
          task: "Preserve CI-first dispatch under lane-diversity constraints",
          role: "evolution-worker",
          target_files: ["src/core/prometheus.ts"],
          verification_commands: ["npm test -- tests/core/orchestrator_pipeline_progress.test.ts"],
          acceptance_criteria: ["dispatch continuity remains intact"],
          dependsOn: [],
        },
      ];

      const result = await evaluatePreDispatchGovernanceGate(config, plans, "spec-serialized-topology");
      assert.equal(result.blocked, false);
      assert.equal(result.reason, null);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not block on oversized packet when an Athena batch can be deterministically rebatched under the cap", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-oversized-rebatch-"));
    try {
      const config = {
        paths: { stateDir, progressFile: path.join(stateDir, "progress.txt") },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
        workerPool: {
          minLanes: 2,
          specializationTargets: { minSpecializedShare: 0 },
        },
        planner: { maxActionableStepsPerPacket: 9 },
      };
      const plans = [
        {
          id: "P-over-1",
          task: "Fix packet densification backfill",
          role: "evolution-worker",
          _batchIndex: 1,
          _batchWorkerRole: "evolution-worker",
          _batchWave: 1,
          target_files: ["src/core/prometheus.ts"],
          verification_commands: ["npm test -- tests/core/prometheus_density_gate.test.ts"],
          acceptance_criteria: ["a1", "a2", "a3", "a4"],
          dependsOn: [],
        },
        {
          id: "P-over-2",
          task: "Preserve CI-first dispatch under lane-diversity constraints",
          role: "evolution-worker",
          _batchIndex: 1,
          _batchWorkerRole: "evolution-worker",
          _batchWave: 1,
          target_files: ["src/core/prometheus.ts"],
          verification_commands: ["npm test -- tests/core/orchestrator_pipeline_progress.test.ts"],
          acceptance_criteria: ["b1", "b2", "b3"],
          dependsOn: [],
        },
        {
          id: "P-over-3",
          task: "Sanitize strategic fields and enforce requestBudget shape integrity",
          role: "evolution-worker",
          _batchIndex: 1,
          _batchWorkerRole: "evolution-worker",
          _batchWave: 1,
          target_files: ["src/core/prometheus.ts"],
          verification_commands: ["npm test -- tests/core/prometheus_parse.test.ts"],
          acceptance_criteria: ["c1", "c2", "c3", "c4"],
          dependsOn: [],
        },
        {
          id: "P-over-4",
          task: "Add parser failureKind taxonomy and strictness coupling",
          role: "observation-worker",
          _batchIndex: 2,
          _batchWorkerRole: "observation-worker",
          _batchWave: 3,
          target_files: ["src/core/prometheus.ts"],
          verification_commands: ["npm test -- tests/core/prometheus_parse.test.ts"],
          acceptance_criteria: ["q1"],
          dependsOn: [],
        },
      ];

      const result = await evaluatePreDispatchGovernanceGate(config, plans, "oversized-rebatch-pass");
      assert.equal(result.blocked, false);
      assert.deepEqual(plans.map((plan) => plan._batchIndex), [1, 1, 2, 3]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("BLOCK_REASON.SPECIALIZATION_ADMISSION_GATE is a stable non-empty string", () => {
    assert.equal(typeof BLOCK_REASON.SPECIALIZATION_ADMISSION_GATE, "string");
    assert.ok((BLOCK_REASON.SPECIALIZATION_ADMISSION_GATE as string).length > 0);
  });

  it("GATE_PRECEDENCE.SPECIALIZATION_ADMISSION is greater than ROLLING_COMPLETION_YIELD", () => {
    assert.ok(GATE_PRECEDENCE.SPECIALIZATION_ADMISSION > GATE_PRECEDENCE.ROLLING_COMPLETION_YIELD);
  });
});

describe("orchestrator governance correction token mapping", () => {
  it("maps Athena governance correction token to canonical dispatchBlockReason", () => {
    const reason = resolveAthenaCorrectionDispatchBlockReason([
      "Pre-dispatch governance state infeasible (governance_freeze_active, critical_debt_overdue) — resolve active gate before dispatch",
    ]);
    assert.equal(
      reason,
      `${BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE}:athena_correction_token=${BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE}`,
    );
  });

  it("negative path: returns null when correction text has no governance token", () => {
    const reason = resolveAthenaCorrectionDispatchBlockReason([
      "verification command should be more specific",
    ]);
    assert.equal(reason, null);
  });

  it("maps cloud-agent governance policy token to canonical dispatchBlockReason", () => {
    const reason = resolveAthenaCorrectionDispatchBlockReason([
      "Pre-dispatch governance state infeasible (cloud_agent_governance_policy_violation) — resolve setup profile before dispatch",
    ]);
    assert.equal(
      reason,
      `${BLOCK_REASON.CLOUD_AGENT_GOVERNANCE_POLICY_VIOLATION}:athena_correction_token=${BLOCK_REASON.CLOUD_AGENT_GOVERNANCE_POLICY_VIOLATION}`,
    );
  });

  it("maps legacy lane_diversity_gate_blocked correction tokens to the canonical outward lane diversity reason", () => {
    const reason = resolveAthenaCorrectionDispatchBlockReason([
      "Pre-dispatch governance state infeasible (lane_diversity_gate_blocked) — diversify active lanes before dispatch",
    ]);
    assert.equal(
      reason,
      `${BLOCK_REASON.LANE_DIVERSITY_INSUFFICIENT}:athena_correction_token=lane_diversity_gate_blocked`,
    );
  });

  it("maps canonical lane_diversity_insufficient correction tokens to the same outward lane diversity reason", () => {
    const reason = resolveAthenaCorrectionDispatchBlockReason([
      "Pre-dispatch governance state infeasible (lane_diversity_insufficient) — diversify active lanes before dispatch",
    ]);
    assert.equal(
      reason,
      `${BLOCK_REASON.LANE_DIVERSITY_INSUFFICIENT}:athena_correction_token=lane_diversity_insufficient`,
    );
  });
});

describe("orchestrator governance gate — cloud-agent profile", () => {
  it("blocks dispatch when copilot setup workflow violates approval policy", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-cloud-agent-"));
    const workflowDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-cloud-agent-profile-"));
    const workflowPath = path.join(workflowDir, "copilot-setup-steps.yml");
    try {
      await fs.writeFile(
        workflowPath,
        [
          "name: Copilot Setup Steps",
          "on:",
          "  workflow_dispatch:",
          "jobs:",
          "  copilot-setup-steps:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - name: Install dependencies",
          "        run: npm ci",
        ].join("\n"),
        "utf8",
      );
      const config = {
        paths: { stateDir, copilotSetupWorkflowFile: workflowPath },
        env: { targetRepo: "CanerDoqdu/Box" },
        canary: { enabled: false },
        systemGuardian: { enabled: false },
        governanceFreeze: { enabled: false, manualOverrideActive: false },
      };
      const result = await evaluatePreDispatchGovernanceGate(config, [], "cloud-agent-approval-policy-block");
      assert.equal(result.blocked, true);
      assert.ok(String(result.reason || "").startsWith(`${BLOCK_REASON.CLOUD_AGENT_GOVERNANCE_POLICY_VIOLATION}:`));
      assert.equal(result.gateIndex, GATE_PRECEDENCE.CLOUD_AGENT_GOVERNANCE);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(workflowDir, { recursive: true, force: true });
    }
  });
});


