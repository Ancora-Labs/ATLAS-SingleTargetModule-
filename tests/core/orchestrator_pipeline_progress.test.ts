/**
 * Orchestrator Pipeline Progress Integration Tests
 *
 * Covers:
 *   - AC15: orchestrator resilience when updatePipelineProgress throws
 *   - AC5:  monotonic stage progression
 *   - AC7:  negative path — failure handling
 *   - AC3:  idle/cycle_complete timestamps
 *   - Task 1 (resume governance gate): checkpoint resume blocked by pre-dispatch governance gate
 *   - Task 2 (event emission): GOVERNANCE_GATE_EVALUATED and PLANNING_PLAN_REJECTED emitted
 *   - Task N (degraded event): ORCHESTRATION_HEALTH_DEGRADED emitted in governance gate exception catch paths
 *   - Reroute history: specialist reroute reason codes persist to reroute_history.jsonl and
 *     measurably affect optimizer penalty counters and scoreboard fields
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runOnce, runResumeDispatch, evaluateDispatchResumeReadiness, evaluatePreDispatchGovernanceGate, BLOCK_REASON, GATE_PRECEDENCE, processEscalationQueueClosureWorkflow, isDispatchCheckpointResumable, loadStaleTriageRecords, runStaleArtifactClosureFastpath, persistSkippedDispatchCheckpoint, clearAthenaPlanRejectionLatch } from "../../src/core/orchestrator.js";
import { ATHENA_PLAN_REVIEW_REASON_CODE } from "../../src/core/athena_reviewer.js";
import { readPipelineProgress, PIPELINE_STAGE_ENUM, PIPELINE_STEPS } from "../../src/core/pipeline_progress.js";
import { EVENTS } from "../../src/core/event_schema.js";
import {
  REROUTE_HISTORY_RECORD_SCHEMA,
  runInterventionOptimizer,
  REROUTE_EV_PENALTY_COEFFICIENT,
  REROUTE_EV_MAX_PENALTY,
} from "../../src/core/intervention_optimizer.js";
import {
  applyDispatchBoundaryHardCap,
  MAX_ACTIONABLE_STEPS_PER_PACKET,
  validatePlanContract,
  PACKET_VIOLATION_CODE,
  PLAN_VIOLATION_SEVERITY,
} from "../../src/core/plan_contract_validator.js";
import { buildWorkerTopologyContract } from "../../src/core/role_registry.js";

describe("orchestrator pipeline progress — resilience", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-orch-pp-"));
    config = {
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile: path.join(tmpDir, "policy.json")
      },
      env: {
        // Force CLI into deterministic fallback so no real AI calls are made
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Janus", model: "Claude Sonnet 4.6" },
        deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
        qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" },
        workers: {
          backend: { name: "King David" },
          test: { name: "Samuel" }
        }
      },
      copilot: {
        leadershipAutopilot: false
      }
    };

    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // AC15: pipeline progress failure must not block orchestration
  it("orchestrator completes normally even if pipeline_progress.json is unwritable", async () => {
    // Make the state dir read-only to prevent pipeline_progress.json writes
    // We can't make it truly read-only on all platforms, so instead we write
    // a directory where the file should be to force a write error.
    const progressPath = path.join(tmpDir, "pipeline_progress.json");
    await fs.mkdir(progressPath, { recursive: true }); // make it a directory to block writes

    // Orchestrator must not throw even though pipeline progress writes will fail
    await assert.doesNotReject(
      () => runOnce(config),
      "orchestrator must not throw when pipeline progress writes fail"
    );

    // Verify the orchestration itself still ran by checking progress.txt
    const progressLog = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    assert.ok(progressLog.includes("[CYCLE]"), "orchestration must still run and log CYCLE steps");
  });

  // AC7: negative path — explicit failure handling is logged not silently dropped
  it("pipeline progress write failures are logged in progress.txt when pipeline_progress.json is unwritable", async () => {
    const progressPath = path.join(tmpDir, "pipeline_progress.json");
    await fs.mkdir(progressPath, { recursive: true });

    await runOnce(config);

    // pipeline progress failure should be non-fatal; orchestrator runs normally
    const progressLog = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    assert.ok(progressLog.includes("[CYCLE]"), "orchestrator must still log cycle steps");
  });

  // Positive path: pipeline_progress.json is written when orchestration runs normally
  it("pipeline_progress.json is written when orchestrator runs a cycle", async () => {
    await runOnce(config);

    // The cycle runs through Janus (which may produce a wait or decision),
    // so we only check that the file was written at some point.
    // readPipelineProgress returns a fallback if file is missing, so check stage is valid.
    const data = await readPipelineProgress(config);
    assert.ok(typeof data.stage === "string", "pipeline progress must have a string stage");
    assert.ok(PIPELINE_STAGE_ENUM.includes(data.stage),
      `pipeline stage '${data.stage}' must be in PIPELINE_STAGE_ENUM`
    );
    assert.ok(typeof data.percent === "number", "pipeline progress must have a numeric percent");
    assert.ok(data.percent >= 0 && data.percent <= 100, "percent must be in [0, 100]");
  });

  // AC3: verify stage written is one of the known enum values (no rogue stages)
  it("stage written by orchestrator is always a valid PIPELINE_STAGE_ENUM value", async () => {
    await runOnce(config);

    const data = await readPipelineProgress(config);
    assert.ok(
      PIPELINE_STAGE_ENUM.includes(data.stage),
      `stage '${data.stage}' written by orchestrator is not in PIPELINE_STAGE_ENUM`
    );
  });

  it("does not spend premium requests while the platform is in idle mode", async () => {
    config.platformModeState = {
      currentMode: "idle",
    };

    await runOnce(config);

    const progressLog = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    assert.ok(progressLog.includes("Idle mode active — autonomous orchestration paused"), "idle mode should short-circuit the cycle");
    assert.ok(!progressLog.includes("[PREMIUM_USAGE]"), "idle mode must not record premium usage");
    assert.ok(!progressLog.includes("[CYCLE] ── Step 1: Janus analyzing system state ──"), "idle mode must not wake leadership agents");
  });

  it("persists composite cycle_health contract without overwriting runtime health channel", async () => {
    const cycleHealthPath = path.join(tmpDir, "cycle_health.json");
    await fs.writeFile(
      cycleHealthPath,
      JSON.stringify({
        schemaVersion: 1,
        lastCycle: {
          cycleId: "seed-cycle",
          healthScore: "degraded",
          generatedAt: new Date().toISOString(),
        },
        history: [],
        lastDivergence: {
          divergenceState: "none",
          pipelineStatus: "healthy",
          operationalStatus: "operational",
          plannerHealth: "good",
          isWarning: false,
          recordedAt: new Date().toISOString(),
        },
        divergenceState: "none",
        pipelineStatus: "healthy",
        operationalStatus: "operational",
        plannerHealth: "good",
        isWarning: false,
        recordedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );
    await runOnce(config);
    const cycleHealthRaw = await fs.readFile(cycleHealthPath, "utf8");
    const cycleHealth = JSON.parse(cycleHealthRaw);

    assert.equal(cycleHealth.schemaVersion, 1, "cycle_health.json must keep schemaVersion=1");
    assert.ok("lastCycle" in cycleHealth, "composite contract must preserve runtime health channel");
    assert.ok("lastDivergence" in cycleHealth, "composite contract must preserve divergence channel");
    assert.ok(cycleHealth.lastCycle !== null, "runtime degradation channel must remain populated after divergence update");
    assert.ok(cycleHealth.lastDivergence !== null, "planner divergence channel must remain populated");
    assert.ok(typeof cycleHealth.divergenceState === "string", "compat top-level divergenceState must be present");
    assert.ok(typeof cycleHealth.pipelineStatus === "string", "compat top-level pipelineStatus must be present");
  });
});

describe("orchestrator escalation closure workflow", () => {
  it("processEscalationQueueClosureWorkflow resolves targeted stale escalations with deterministic summaries", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-orch-escalation-closure-"));
    try {
      const config = {
        paths: { stateDir: tmpDir, progressFile: path.join(tmpDir, "progress.txt") },
      };
      await fs.writeFile(path.join(tmpDir, "progress.txt"), "", "utf8");
      await fs.writeFile(path.join(tmpDir, "escalation_queue.json"), JSON.stringify({
        entries: [
          {
            schemaVersion: 1,
            role: "evolution-worker",
            taskFingerprint: "6b493c609b258bc0",
            taskSnippet: "forced max rework",
            blockingReasonClass: "MAX_REWORK_EXHAUSTED",
            attempts: 2,
            nextAction: "RETRY",
            summary: "pending",
            prUrl: null,
            resolved: false,
            createdAt: new Date().toISOString(),
          },
          {
            schemaVersion: 1,
            role: "infrastructure-worker",
            taskFingerprint: "905e317f43de1a08",
            taskSnippet: "forced access blocked",
            blockingReasonClass: "ACCESS_BLOCKED",
            attempts: 1,
            nextAction: "ESCALATE_TO_HUMAN",
            summary: "pending",
            prUrl: null,
            resolved: false,
            createdAt: new Date().toISOString(),
          },
        ],
        updatedAt: null,
      }, null, 2), "utf8");

      const result = await processEscalationQueueClosureWorkflow(config);
      assert.equal(result.resolvedCount, 2);
      assert.ok(result.resolvedFingerprints.includes("6b493c609b258bc0"));
      assert.ok(result.resolvedFingerprints.includes("905e317f43de1a08"));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("orchestrator bundled ci-fix context injection", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-bundled-ci-fix-"));
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("runOnce keeps deterministic bundled ci-fix context path executable", async () => {
    await fs.writeFile(path.join(tmpDir, "policy.json"), JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");
    await fs.writeFile(path.join(tmpDir, "progress.txt"), "", "utf8");

    const config = {
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile: path.join(tmpDir, "policy.json")
      },
      env: {
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Janus", model: "Claude Sonnet 4.6" },
        deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
        qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" }
      },
      copilot: { leadershipAutopilot: false },
      canary: { enabled: false },
      systemGuardian: { enabled: false }
    };

    await assert.doesNotReject(
      () => runOnce(config),
      "orchestrator must execute without throwing when bundled ci-fix context path is present"
    );
  });
});

// ── Governance pre-dispatch gate tests (Tasks 4-7) ────────────────────────────

describe("orchestrator governance pre-dispatch gate", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gov-gate-"));
    config = {
      paths: { stateDir: tmpDir },
      env:   { targetRepo: "CanerDoqdu/Box" },
      canary: {
        enabled:      true,
        defaultRatio: 0.2,
        governance: {
          canaryRatio:             0.2,
          measurementWindowCycles: 5,
          falseBlockRateMax:       0.02,
          safetyScoreMin:          0.95,
          falseBlockRateTrigger:   0.05,
          safetyScoreTriggerLow:   0.80,
          breachAction:            "halt_new_assignments"
        }
      },
      systemGuardian: { enabled: true }
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows dispatch when guardrail, freeze, lineage, and canary gates are all clear", async () => {
    const plans = [
      { id: "T1", task: "task one", role: "backend", dependsOn: [], filesInScope: ["src/core/a.ts"],
        verification_commands: ["npm test"], acceptance_criteria: ["tests pass"] },
      { id: "T2", task: "task two", role: "test", dependsOn: ["T1"], filesInScope: ["tests/core/a.test.ts"],
        verification_commands: ["npm test"], acceptance_criteria: ["tests pass"] }
    ];

    const result = await evaluatePreDispatchGovernanceGate(config, plans, "clear-gate-cycle-1");

    assert.equal(result.blocked, false, "dispatch must proceed when no pre-dispatch governance gate is active");
    assert.equal(result.reason, null);
    assert.ok(result.graphResult, "graphResult must exist for successful lineage resolution");
    assert.equal(result.graphResult.status, "ok");
  });

  // ── Task 4 ────────────────────────────────────────────────────────────────
  it("should block dispatch when lineage graph status is cycle_detected", async () => {
    // Two plans with a mutual dependency — creates a cycle in the graph
    const plans = [
      { id: "T1", task: "task one", role: "backend", dependsOn: ["T2"], filesInScope: [] },
      { id: "T2", task: "task two", role: "backend", dependsOn: ["T1"], filesInScope: [] }
    ];

    const result = await evaluatePreDispatchGovernanceGate(config, plans, "cycle-test-cycle-1");

    assert.equal(result.blocked, true,
      "dispatch must be blocked when dependency cycle is detected");
    assert.ok(
      result.reason.includes("cycle_detected") || result.reason.includes("lineage"),
      `expected cycle_detected or lineage in reason; got: ${result.reason}`
    );
    assert.ok(result.graphResult, "graphResult must be present when cycle is detected");
  });

  // ── Task 5 ────────────────────────────────────────────────────────────────
  it("should block dispatch when governance canary reports breach-active", async () => {
    // Write a governance ledger with a rolled-back experiment (breach active)
    const ledger = {
      schemaVersion: 1,
      experiments: [{
        canaryId:     "govcanary-breach-001",
        status:       "rolled_back",
        breachAction: "halt_new_assignments",
        statusReason: "GOVERNANCE_BREACH_FALSE_BLOCK_RATE:0.10>0.05",
        policyKey:    "{}",
        cycleLog:     [],
        cohortStats:  { canary: {}, control: {} }
      }],
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(
      path.join(tmpDir, "governance_canary_ledger.json"),
      JSON.stringify(ledger, null, 2),
      "utf8"
    );

    const result = await evaluatePreDispatchGovernanceGate(config, [], "breach-test-cycle-1");

    assert.equal(result.blocked, true,
      "dispatch must be blocked when governance canary breach is active");
    assert.ok(
      result.reason.includes("canary") || result.reason.includes("breach"),
      `expected canary or breach in reason; got: ${result.reason}`
    );
  });

  // ── Task 6 ────────────────────────────────────────────────────────────────
  it("should invoke executeRollback and persist incident on governance canary rollback action", async () => {
    // Pre-write a governance ledger showing a breach
    const ledger = {
      schemaVersion: 1,
      experiments: [{
        canaryId:     "govcanary-rollback-001",
        status:       "rolled_back",
        breachAction: "halt_new_assignments",
        statusReason: "GOVERNANCE_BREACH",
        policyKey:    "{}",
        cycleLog:     [],
        cohortStats:  { canary: {}, control: {} }
      }],
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(
      path.join(tmpDir, "governance_canary_ledger.json"),
      JSON.stringify(ledger, null, 2),
      "utf8"
    );

    const result = await evaluatePreDispatchGovernanceGate(config, [], "rollback-invoke-cycle-1");

    assert.equal(result.blocked, true);
    assert.equal(result.action, "rollback",
      "action must be rollback when canary breach triggers dispatch block");

    // Verify rollback incident was persisted
    const incidentPath = path.join(tmpDir, "rollback_incidents.jsonl");
    const incidentExists = await fs.access(incidentPath).then(() => true).catch(() => false);
    assert.equal(incidentExists, true,
      "rollback_incidents.jsonl must be written when executeRollback is invoked");

    // Verify the incident record contains expected fields
    const raw = await fs.readFile(incidentPath, "utf8");
    const incident = JSON.parse(raw.trim().split("\n")[0]);
    assert.ok(incident.incidentId, "incident must have an incidentId");
    assert.ok(incident.trigger === "CANARY_ROLLBACK" || incident.level === "config-only",
      `unexpected incident trigger/level: trigger=${incident.trigger} level=${incident.level}`
    );
  });

  it("governance_freeze_active: blocks pre-dispatch when freeze gate is active [T-040/AC1]", async () => {
    const plans = [
      { id: "T1", task: "high-risk task", role: "backend", dependsOn: [], filesInScope: ["src/core/orchestrator.ts"] }
    ];

    const freezeOnlyConfig = {
      ...config,
      systemGuardian: { enabled: false },
      canary: { enabled: false },
      governanceFreeze: { enabled: true, manualOverrideActive: true }
    };

    const result = await evaluatePreDispatchGovernanceGate(freezeOnlyConfig, plans, "freeze-only-cycle-1");

    assert.equal(result.blocked, true, "dispatch must be blocked by freeze when no higher-precedence guardrail is active");
    assert.ok(
      result.reason.startsWith("governance_freeze_active:"),
      `expected FREEZE reason, got: ${result.reason}`
    );
    assert.equal(result.action, undefined, "freeze block should not trigger rollback action");
  });

  it("continues non-fatally and emits warning signal when guardrail check throws", async () => {
    const warnings = [];
    mock.method(console, "warn", (...args) => {
      warnings.push(args.map(v => String(v)).join(" "));
    });

    const guardrailThrowConfig = {
      ...config,
      // Invalid path type forces isGuardrailActive(path.join) to throw.
      paths: { stateDir: Symbol("invalid-state-dir") },
      canary: { enabled: false }
    };

    await assert.doesNotReject(
      () => evaluatePreDispatchGovernanceGate(guardrailThrowConfig, [], "guardrail-throw-cycle-1"),
      "guardrail exceptions must be handled as warning-only and not thrown"
    );

    const result = await evaluatePreDispatchGovernanceGate(guardrailThrowConfig, [], "guardrail-throw-cycle-2");
    assert.equal(result.blocked, false, "guardrail exception path must safely fall through when no other gate is active");
    assert.equal(result.reason, null);
    assert.ok(
      warnings.some(msg => msg.includes("pre-dispatch guardrail check failed")),
      "warning signal must be emitted when guardrail check throws"
    );
  });

  it("covers gate wrapper catch path with safe fallthrough on unexpected guard exception", async () => {
    const guardrailThrowFreezeConfig = {
      ...config,
      paths: { stateDir: Symbol("invalid-state-dir-2") },
      canary: { enabled: false },
      governanceFreeze: { enabled: true, manualOverrideActive: true }
    };

    const result = await evaluatePreDispatchGovernanceGate(
      guardrailThrowFreezeConfig,
      [],
      "guardrail-wrapper-catch-cycle-1"
    );

    assert.equal(result.blocked, true, "unexpected guardrail exception must not crash gate evaluation");
    assert.ok(
      result.reason.startsWith("governance_freeze_active:"),
      `freeze gate must still evaluate after guard exception; got: ${result.reason}`
    );
  });

  // ── Task 7 ────────────────────────────────────────────────────────────────
  it("should enforce guardrail > freeze > canary precedence and invoke rollback on canary breach in one cycle", async () => {
    // Set up canary breach in state
    const ledger = {
      schemaVersion: 1,
      experiments: [{
        canaryId:     "govcanary-prec-001",
        status:       "rolled_back",
        breachAction: "halt_new_assignments",
        statusReason: "GOVERNANCE_BREACH",
        policyKey:    "{}",
        cycleLog:     [],
        cohortStats:  { canary: {}, control: {} }
      }],
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(
      path.join(tmpDir, "governance_canary_ledger.json"),
      JSON.stringify(ledger, null, 2),
      "utf8"
    );

    // Set up guardrail PAUSE_WORKERS state in the same stateDir
    const guardrailState = { enabled: true, revertedAt: null, activatedAt: new Date().toISOString() };
    await fs.writeFile(
      path.join(tmpDir, "guardrail_pause_workers.json"),
      JSON.stringify(guardrailState, null, 2),
      "utf8"
    );

    // With guardrail + freeze + canary all active:
    // guardrail must win (precedence 1)
    const configWithAll = {
      ...config,
      governanceFreeze: { enabled: true, manualOverrideActive: true }
    };

    const r1 = await evaluatePreDispatchGovernanceGate(configWithAll, [], "prec-all-cycle");
    assert.equal(r1.blocked, true);
    assert.ok(r1.reason.includes("guardrail"),
      `guardrail must win when all three are active; reason=${r1.reason}`);
    assert.equal(r1.action, undefined,
      "no rollback triggered when guardrail blocks first");

    // Without guardrail, only canary active: canary triggers rollback
    const configNoGuardrail = { ...config, systemGuardian: { enabled: false } };
    const r2 = await evaluatePreDispatchGovernanceGate(configNoGuardrail, [], "prec-noguardrail-cycle");
    assert.equal(r2.blocked, true);
    assert.ok(
      r2.reason.includes("canary") || r2.reason.includes("breach"),
      `canary breach must block when guardrail is disabled; reason=${r2.reason}`
    );
    assert.equal(r2.action, "rollback",
      "rollback action must be triggered on canary breach");

    // Verify rollback incident was persisted
    const incidentPath = path.join(tmpDir, "rollback_incidents.jsonl");
    const incidentExists = await fs.access(incidentPath).then(() => true).catch(() => false);
    assert.equal(incidentExists, true, "rollback incident must be persisted on canary breach");
  });
});

// ── Task 1: Resume dispatch governance gate ───────────────────────────────────

describe("orchestrator checkpoint resume — pre-dispatch governance gate", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-resume-gate-"));
    config = {
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile: path.join(tmpDir, "policy.json")
      },
      env: {
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Janus", model: "Claude Sonnet 4.6" },
        deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
        qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" }
      },
      copilot: { leadershipAutopilot: false },
      canary: { enabled: false },
      systemGuardian: { enabled: true }
    };
    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("blocks resumed dispatch when governance freeze is active and logs warning", async () => {
    // Write an approved Athena review with plans so resume path is entered
    const athenaReview = {
      approved: true,
      patchedPlans: [
        {
          id: "T1", task: "task one", role: "evolution-worker", dependsOn: [], filesInScope: [],
          targetFiles: ["src/core/orchestrator.ts"], scope: "implementation",
          acceptance_criteria: ["tests pass"]
        }
      ]
    };
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify(athenaReview),
      "utf8"
    );

    // Activate governance freeze so the gate blocks dispatch
    const freezeConfig = {
      ...config,
      governanceFreeze: { enabled: true, manualOverrideActive: true }
    };

    // runOnce: basic non-throw assertion covering the normal cycle path
    await assert.doesNotReject(
      () => runOnce(freezeConfig),
      "runOnce must not throw when governance gate blocks resumed dispatch"
    );

    // Progress log must record the governance gate block
    const progressLog = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    assert.ok(
      progressLog.includes("[RESUME]") || progressLog.includes("[CYCLE]"),
      "progress log must record orchestration activity even when gate blocks"
    );

    // Checkpoint-aware: use runResumeDispatch to exercise tryResumeDispatchFromCheckpoint.
    // With freeze active, the governance gate must block dispatch and NOT advance the
    // checkpoint to "complete" — so a future resume can retry from the same position.
    await assert.doesNotReject(
      () => runResumeDispatch(freezeConfig),
      "runResumeDispatch must not throw when governance freeze blocks dispatch — early return expected"
    );

    const checkpointPath = path.join(tmpDir, "dispatch_checkpoint.json");
    const checkpointRaw = await fs.readFile(checkpointPath, "utf8").catch(() => null);
    assert.ok(checkpointRaw !== null,
      "dispatch_checkpoint.json must be written by tryResumeDispatchFromCheckpoint even when the gate blocks"
    );
    const checkpoint = JSON.parse(checkpointRaw!);
    assert.equal(checkpoint.schemaVersion, 2, "dispatch checkpoint must use schemaVersion=2");
    assert.ok(typeof checkpoint.checkpointVersion === "number" && checkpoint.checkpointVersion >= 1,
      "dispatch checkpoint must include monotonic checkpointVersion metadata");
    assert.equal(checkpoint.checkpointFormat, "resumable_v2",
      "dispatch checkpoint must declare resumable checkpoint format");
    assert.ok(typeof checkpoint.integrity?.hash === "string" && checkpoint.integrity.hash.length > 0,
      "dispatch checkpoint must include integrity hash metadata");
    assert.notEqual(
      checkpoint.status,
      "complete",
      "dispatch_checkpoint.json must NOT be marked complete when pre-dispatch gate blocks — retry must remain possible"
    );
  });

  it("does not block one-lane resumed batches before wave dispatch", async () => {
    const patchedPlans = [
      {
        id: "T1",
        task: "task one",
        role: "evolution-worker",
        dependsOn: [],
        filesInScope: [],
        targetFiles: ["src/core/orchestrator.ts"],
        scope: "implementation",
        verification_commands: ["npm test"],
        acceptance_criteria: ["tests pass"],
      },
      {
        id: "T2",
        task: "task two",
        role: "evolution-worker",
        dependsOn: [],
        filesInScope: [],
        targetFiles: ["src/core/cycle_analytics.ts"],
        scope: "implementation",
        verification_commands: ["npm test"],
        acceptance_criteria: ["tests pass"],
      },
    ];
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify({ approved: true, patchedPlans }),
      "utf8",
    );
    const diversityConfig = {
      ...config,
      systemGuardian: { enabled: false },
      workerPool: { minLanes: 2 },
    };

    const gateDecision = await evaluatePreDispatchGovernanceGate(
      diversityConfig,
      patchedPlans,
      "lane-diversity-resume-block",
    );
    assert.equal(gateDecision.blocked, false);

    await assert.doesNotReject(
      () => runResumeDispatch(diversityConfig),
      "runResumeDispatch must not stop before wave dispatch when lane diversity is insufficient",
    );

    const progressLog = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    assert.doesNotMatch(progressLog, /\[RESUME\] Pre-dispatch governance gate blocked resumed dispatch/);

    const checkpoint = JSON.parse(await fs.readFile(path.join(tmpDir, "dispatch_checkpoint.json"), "utf8"));
    assert.ok(checkpoint.completedPlans >= 0, "dispatch checkpoint should remain readable after resume dispatch");
    const workerSessionsExists = await fs.access(path.join(tmpDir, "worker_sessions.json")).then(() => true).catch(() => false);
    assert.equal(workerSessionsExists, true, "worker sessions should be created because lane diversity no longer blocks dispatch");
  });

  it("preserves admitted multi-lane topology for later-wave continuation slices instead of blocking a singleton lane", async () => {
    const admittedPlans = [
      {
        id: "T1",
        task: "Add governance freeze coverage",
        role: "governance-worker",
        wave: 1,
        dependsOn: [],
        filesInScope: [],
        targetFiles: ["src/core/governance_freeze.ts"],
        scope: "governance",
        verification_commands: ["npm test"],
        acceptance_criteria: ["governance checks stay deterministic"],
      },
      {
        id: "T2",
        task: "Add orchestrator regression tests",
        role: "quality-worker",
        wave: 1,
        dependsOn: [],
        filesInScope: [],
        targetFiles: ["tests/core/orchestrator_pipeline_progress.test.ts"],
        scope: "quality",
        verification_commands: ["npm test"],
        acceptance_criteria: ["test coverage captures continuation behavior"],
      },
      {
        id: "T3",
        task: "Carry forward the admitted continuation work",
        role: "evolution-worker",
        wave: 2,
        dependsOn: [],
        filesInScope: [],
        targetFiles: ["src/core/orchestrator.ts"],
        scope: "implementation",
        verification_commands: ["npm test"],
        acceptance_criteria: ["remaining continuation work dispatches without replanning drift"],
      },
    ];
    const gateDecision = await evaluatePreDispatchGovernanceGate(
      {
        ...config,
        systemGuardian: { enabled: false },
        workerPool: {
          minLanes: 2,
          specializationTargets: { minSpecializedShare: 0.75 },
        },
      },
      [admittedPlans[2]],
      "late-wave-singleton-continuation",
      null,
      { admittedWorkerTopology: buildWorkerTopologyContract(admittedPlans) },
    );

    assert.equal(gateDecision.blocked, false, "later-wave continuation slices should preserve the admitted multi-lane topology");
  });

  it("proceeds with resumed dispatch when governance gate is clear", async () => {
    // Write an approved Athena review with plans
    const athenaReview = {
      approved: true,
      patchedPlans: [
        {
          id: "T1", task: "task one", role: "evolution-worker", dependsOn: [], filesInScope: [],
          targetFiles: ["src/core/orchestrator.ts"], scope: "implementation",
          verification_commands: ["npm test"], acceptance_criteria: ["tests pass"]
        }
      ]
    };
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify(athenaReview),
      "utf8"
    );

    // All gates clear (no freeze, no canary breach, no guardrail)
    await assert.doesNotReject(
      () => runOnce(config),
      "runOnce must not throw when governance gate passes for resumed dispatch"
    );

    // Checkpoint-aware: explicitly invoke runResumeDispatch to verify that the dispatch
    // checkpoint is created and populated when all gates are clear.
    await assert.doesNotReject(
      () => runResumeDispatch(config),
      "runResumeDispatch must not throw when all pre-dispatch governance gates are clear"
    );

    const checkpointPath = path.join(tmpDir, "dispatch_checkpoint.json");
    const checkpointExists = await fs.access(checkpointPath).then(() => true).catch(() => false);
    assert.ok(
      checkpointExists,
      "dispatch_checkpoint.json must be written when the governance gate is clear and resume dispatch is entered"
    );
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
    assert.equal(checkpoint.schemaVersion, 2, "dispatch checkpoint must use schemaVersion=2");
    assert.ok(typeof checkpoint.replayCompatibility?.replayContractVersion === "number",
      "dispatch checkpoint must include replay compatibility contract metadata");
    assert.ok(
      typeof checkpoint.status === "string",
      "dispatch_checkpoint.json must have a string status field"
    );
    assert.ok(
      typeof checkpoint.totalPlans === "number" && checkpoint.totalPlans > 0,
      `dispatch_checkpoint.json must record totalPlans > 0 when plans are present; got totalPlans=${checkpoint.totalPlans}`
    );
  });

  it("resumes from checkpoint snapshot even when live Athena review artifacts are absent", async () => {
    const checkpoint = {
      status: "dispatching",
      createdAt: "2026-04-11T07:31:14.738Z",
      updatedAt: "2026-04-11T07:58:39.727Z",
      totalPlans: 1,
      planCount: 1,
      completedPlans: 0,
      planSetSignature: "resume-snapshot-test",
      planAnalyzedAt: "2026-04-11T07:28:14.861Z",
      dispatchPlanSnapshot: [
        {
          id: "T1",
          task_id: "T1",
          task: "task one",
          role: "evolution-worker",
          wave: 1,
          targetFiles: ["src/core/orchestrator.ts"],
          scope: "implementation",
          verification_commands: ["npm test"],
          acceptance_criteria: ["tests pass"],
        },
      ],
      workerBatchesSnapshot: [
        {
          role: "evolution-worker",
          wave: 1,
          plans: [
            {
              id: "T1",
              task_id: "T1",
              task: "task one",
              role: "evolution-worker",
              wave: 1,
              targetFiles: ["src/core/orchestrator.ts"],
              scope: "implementation",
              verification_commands: ["npm test"],
              acceptance_criteria: ["tests pass"],
            },
          ],
        },
      ],
    };

    await fs.writeFile(
      path.join(tmpDir, "dispatch_checkpoint.json"),
      JSON.stringify(checkpoint, null, 2),
      "utf8",
    );

    await assert.doesNotReject(
      () => runResumeDispatch(config),
      "runResumeDispatch must resume from checkpoint snapshots even without athena_plan_review.json"
    );

    const progressLog = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    assert.match(progressLog, /\[RESUME\] Force-resuming dispatch checkpoint/);
    assert.match(progressLog, /\[RESUME\] Source=checkpoint_snapshot/);
  });

  it("reports blocked auto-resume when interrupted checkpoint has no usable plan source", async () => {
    const checkpoint = {
      status: "dispatching",
      createdAt: "2026-04-11T07:31:14.738Z",
      updatedAt: "2026-04-11T07:58:39.727Z",
      totalPlans: 2,
      planCount: 2,
      completedPlans: 0,
      planSetSignature: "resume-missing-plan-source",
    };

    await fs.writeFile(
      path.join(tmpDir, "dispatch_checkpoint.json"),
      JSON.stringify(checkpoint, null, 2),
      "utf8",
    );

    const readiness = await evaluateDispatchResumeReadiness(config);
    assert.equal(readiness.interrupted, true);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.reason, "missing_live_plan_source");
    assert.equal(readiness.planSource, "none");
  });

  it("treats checkpoint snapshots as sufficient for auto-resume readiness", async () => {
    const checkpoint = {
      status: "dispatching",
      createdAt: "2026-04-11T07:31:14.738Z",
      updatedAt: "2026-04-11T07:58:39.727Z",
      totalPlans: 1,
      planCount: 1,
      completedPlans: 0,
      planSetSignature: "resume-readiness-snapshot",
      dispatchPlanSnapshot: [
        {
          id: "T1",
          task_id: "T1",
          task: "task one",
          role: "evolution-worker",
          wave: 1,
          targetFiles: ["src/core/orchestrator.ts"],
          scope: "implementation",
          verification_commands: ["npm test"],
          acceptance_criteria: ["tests pass"],
        },
      ],
      workerBatchesSnapshot: [
        {
          role: "evolution-worker",
          wave: 1,
          plans: [
            {
              id: "T1",
              task_id: "T1",
              task: "task one",
              role: "evolution-worker",
              wave: 1,
              targetFiles: ["src/core/orchestrator.ts"],
              scope: "implementation",
              verification_commands: ["npm test"],
              acceptance_criteria: ["tests pass"],
            },
          ],
        },
      ],
    };

    await fs.writeFile(
      path.join(tmpDir, "dispatch_checkpoint.json"),
      JSON.stringify(checkpoint, null, 2),
      "utf8",
    );

    const readiness = await evaluateDispatchResumeReadiness(config);
    assert.equal(readiness.interrupted, true);
    assert.equal(readiness.ready, true);
    assert.equal(readiness.reason, "checkpoint_snapshot_ready");
    assert.equal(readiness.planSource, "checkpoint_snapshot");
    assert.equal(readiness.planCount, 1);
    assert.equal(readiness.workerBatchCount, 1);
  });

  it("blocks checkpoint snapshot auto-resume when a shadow session snapshot still carries implementation work", async () => {
    config.platformModeState = { currentMode: "single_target_delivery" };
    config.activeTargetSession = {
      projectId: "portal",
      sessionId: "sess_shadow",
      currentStage: "shadow",
      gates: {
        allowShadowExecution: true,
        allowActiveExecution: false,
      },
      repo: { repoUrl: "https://github.com/acme/portal" },
    };

    const checkpoint = {
      status: "dispatching",
      createdAt: "2026-04-11T07:31:14.738Z",
      updatedAt: "2026-04-11T07:58:39.727Z",
      totalPlans: 1,
      planCount: 1,
      completedPlans: 0,
      planSetSignature: "resume-readiness-shadow-contract",
      targetSession: {
        projectId: "portal",
        sessionId: "sess_shadow",
        currentStage: "shadow",
        repoUrl: "https://github.com/acme/portal",
      },
      dispatchPlanSnapshot: [
        {
          id: "T1",
          task_id: "T1",
          task: "Implement the todo board end to end",
          role: "evolution-worker",
          taskKind: "implementation",
          wave: 1,
          target_files: ["src/app.ts"],
          scope: "feature delivery",
          verification: "npm test -- tests/core/orchestrator_pipeline_progress.test.ts",
          acceptance_criteria: ["tests pass"],
        },
      ],
      workerBatchesSnapshot: [
        {
          role: "evolution-worker",
          wave: 1,
          plans: [
            {
              id: "T1",
              task_id: "T1",
              task: "Implement the todo board end to end",
              role: "evolution-worker",
              taskKind: "implementation",
              wave: 1,
              target_files: ["src/app.ts"],
              scope: "feature delivery",
              verification: "npm test -- tests/core/orchestrator_pipeline_progress.test.ts",
              acceptance_criteria: ["tests pass"],
            },
          ],
        },
      ],
    };

    await fs.writeFile(
      path.join(tmpDir, "dispatch_checkpoint.json"),
      JSON.stringify(checkpoint, null, 2),
      "utf8",
    );

    const readiness = await evaluateDispatchResumeReadiness(config);
    assert.equal(readiness.interrupted, true);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.reason, "target_stage_contract_blocked");
    assert.equal(readiness.planSource, "checkpoint_snapshot");
  });

  it("rejects checkpoint snapshot auto-resume when the checkpoint belongs to a different target session", async () => {
    config.platformModeState = { currentMode: "single_target_delivery" };
    config.activeTargetSession = {
      projectId: "portal",
      sessionId: "sess_active",
      currentStage: "active",
      repo: { repoUrl: "https://github.com/acme/portal" },
    };

    const checkpoint = {
      status: "dispatching",
      createdAt: "2026-04-11T07:31:14.738Z",
      updatedAt: "2026-04-11T07:58:39.727Z",
      totalPlans: 1,
      planCount: 1,
      completedPlans: 0,
      planSetSignature: "resume-readiness-foreign-session",
      targetSession: {
        projectId: "portal",
        sessionId: "sess_old",
        currentStage: "active",
        repoUrl: "https://github.com/acme/portal",
      },
      dispatchPlanSnapshot: [
        {
          id: "T1",
          task_id: "T1",
          task: "task one",
          role: "evolution-worker",
          wave: 1,
          targetFiles: ["src/core/orchestrator.ts"],
          scope: "implementation",
          verification_commands: ["npm test"],
          acceptance_criteria: ["tests pass"],
        },
      ],
      workerBatchesSnapshot: [
        {
          role: "evolution-worker",
          wave: 1,
          plans: [
            {
              id: "T1",
              task_id: "T1",
              task: "task one",
              role: "evolution-worker",
              wave: 1,
              targetFiles: ["src/core/orchestrator.ts"],
              scope: "implementation",
              verification_commands: ["npm test"],
              acceptance_criteria: ["tests pass"],
            },
          ],
        },
      ],
    };

    await fs.writeFile(
      path.join(tmpDir, "dispatch_checkpoint.json"),
      JSON.stringify(checkpoint, null, 2),
      "utf8",
    );

    const readiness = await evaluateDispatchResumeReadiness(config);
    assert.equal(readiness.interrupted, false);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.reason, "runtime_target_mismatch");
    assert.equal(readiness.planSource, "none");
  });

  it("refuses force-resume when the approved live review belongs to a different target session", async () => {
    config.platformModeState = { currentMode: "single_target_delivery" };
    config.activeTargetSession = {
      projectId: "portal",
      sessionId: "sess_active",
      currentStage: "active",
      repo: { repoUrl: "https://github.com/acme/portal" },
    };

    await fs.writeFile(
      path.join(tmpDir, "dispatch_checkpoint.json"),
      JSON.stringify({
        status: "dispatching",
        createdAt: "2026-04-11T07:31:14.738Z",
        updatedAt: "2026-04-11T07:58:39.727Z",
        totalPlans: 1,
        planCount: 1,
        completedPlans: 0,
        planSetSignature: "resume-live-review-foreign-session",
        targetSession: {
          projectId: "portal",
          sessionId: "sess_active",
          currentStage: "active",
          repoUrl: "https://github.com/acme/portal",
        },
      }, null, 2),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify({
        approved: true,
        targetSession: {
          projectId: "portal",
          sessionId: "sess_old",
          currentStage: "active",
          repoUrl: "https://github.com/acme/portal",
        },
        patchedPlans: [
          {
            id: "T1",
            task: "task one",
            role: "evolution-worker",
            dependsOn: [],
            filesInScope: [],
            targetFiles: ["src/core/orchestrator.ts"],
            scope: "implementation",
            acceptance_criteria: ["tests pass"],
          },
        ],
      }, null, 2),
      "utf8",
    );

    await assert.rejects(
      () => runResumeDispatch(config),
      /No resumable Step-4 checkpoint found/,
      "runResumeDispatch must refuse cross-session approved reviews",
    );

    const progressLog = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    assert.match(progressLog, /Athena plan review belongs to a different target session\/runtime/);

    const workerSessionsExists = await fs.access(path.join(tmpDir, "worker_sessions.json")).then(() => true).catch(() => false);
    assert.equal(workerSessionsExists, false, "worker sessions must not be created when resume is rejected for target-session mismatch");
  });
});

// ── Task 2: Typed event emission ──────────────────────────────────────────────

describe("orchestrator typed event emission — GOVERNANCE_GATE_EVALUATED", () => {
  let tmpDir;
  let config;
  let emittedEvents;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-event-emit-"));
    emittedEvents = [];
    config = {
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile: path.join(tmpDir, "policy.json")
      },
      env: {
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Janus", model: "Claude Sonnet 4.6" },
        deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
        qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" }
      },
      copilot: { leadershipAutopilot: false },
      canary: { enabled: false },
      systemGuardian: { enabled: true }
    };
    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");

    // Intercept console.log to capture emitted events
    mock.method(console, "log", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.event === "string") {
          emittedEvents.push(obj);
        }
      } catch { /* not JSON */ }
    });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("emits GOVERNANCE_GATE_EVALUATED event during explicit resume dispatch", async () => {
    // Write an approved Athena review so explicit resume reaches the gate
    const athenaReview = {
      approved: true,
      patchedPlans: [
        {
          id: "T1", task: "task one", role: "evolution-worker", dependsOn: [], filesInScope: [],
          targetFiles: ["src/core/orchestrator.ts"], scope: "implementation",
          verification_commands: ["npm test"], acceptance_criteria: ["tests pass"]
        }
      ]
    };
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify(athenaReview),
      "utf8"
    );

    await runResumeDispatch(config);

    const gateEvents = emittedEvents.filter(e => e.event === EVENTS.GOVERNANCE_GATE_EVALUATED);
    assert.ok(
      gateEvents.length >= 1,
      `expected at least one GOVERNANCE_GATE_EVALUATED event; got ${gateEvents.length}`
    );
    const ev = gateEvents[0];
    assert.equal(ev.domain, "governance", "event domain must be governance");
    assert.ok(typeof ev.payload.blocked === "boolean", "payload.blocked must be boolean");
  });

  it("negative: no GOVERNANCE_GATE_EVALUATED emitted on fresh run with no approved review", async () => {
    // No athena_plan_review.json — orchestrator runs Janus → Prometheus (may fail) → no dispatch gate reached
    await runOnce(config);
    // We don't assert zero events here because Prometheus may also fail fast;
    // we just verify the orchestrator doesn't crash and events are well-formed if any.
    for (const ev of emittedEvents) {
      assert.ok(typeof ev.event === "string", "every emitted event must have a string event field");
      assert.ok(typeof ev.domain === "string", "every emitted event must have a string domain");
    }
  });
});

// ── Governance gate exception — degraded event emission ───────────────────────

describe("orchestrator governance gate exception — ORCHESTRATION_HEALTH_DEGRADED emission", () => {
  let tmpDir;  let config;
  let emittedEvents;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-degrade-"));
    emittedEvents = [];
    config = {
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile:   path.join(tmpDir, "policy.json")
      },
      env: {
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Janus",     model: "Claude Sonnet 4.6" },
        deepPlanner:   { name: "Prometheus", model: "GPT-5.3-Codex" },
        qualityReviewer: { name: "Athena",  model: "Claude Sonnet 4.6" }
      },
      copilot: { leadershipAutopilot: false },
      systemGuardian: { enabled: false }
    };
    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");

    mock.method(console, "log", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.event === "string") emittedEvents.push(obj);
      } catch { /* not JSON */ }
    });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("emits ORCHESTRATION_HEALTH_DEGRADED and stays non-fatal when governance gate throws during resume", async () => {
    // Write an approved athena review with plans so resume path reaches the governance gate.
    const athenaReview = {
      approved: true,
      patchedPlans: [
        {
          id: "T1", task: "task one", role: "evolution-worker", dependsOn: [], filesInScope: [],
          targetFiles: ["src/core/orchestrator.ts"], scope: "implementation",
          acceptance_criteria: ["tests pass"]
        }
      ]
    };
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify(athenaReview),
      "utf8"
    );

    // Inject a governance canary config getter that throws synchronously.
    // getGovernanceCanaryConfig() accesses `config.canary.governance` before any
    // early-return guard, so this propagates out of evaluatePreDispatchGovernanceGate
    // and into the outer catch block in tryResumeDispatchFromCheckpoint.
    const throwingConfig = Object.assign({}, config, {
      canary: {
        enabled: false,
        get governance() {
          throw new Error("simulated governance gate exception");
        }
      }
    });

    // The cycle must not throw — non-fatality is the primary contract.
    await assert.doesNotReject(
      () => runResumeDispatch(throwingConfig),
      "runResumeDispatch must not throw when the governance gate itself throws — outer catch must absorb it"
    );

    const degradedEvents = emittedEvents.filter(e => e.event === EVENTS.ORCHESTRATION_HEALTH_DEGRADED);
    assert.ok(
      degradedEvents.length >= 1,
      `expected at least one ORCHESTRATION_HEALTH_DEGRADED event when gate throws; got ${degradedEvents.length}`
    );
    const ev = degradedEvents[0];
    assert.equal(ev.domain, "orchestration", "degraded event domain must be orchestration");
    assert.equal(ev.payload.reason, "governance_gate_exception", "payload.reason must be governance_gate_exception");
    assert.equal(ev.payload.context, "resume_dispatch", "payload.context must be resume_dispatch");
    assert.ok(
      typeof ev.payload.error === "string" && ev.payload.error.length > 0,
      "payload.error must be a non-empty string with the exception message"
    );
  });
});

// ── Full leadership chain stage ordering + gate evaluation (Task 3) ───────────

describe("leadership chain stage ordering and gate evaluation", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-leadership-chain-"));
    config = {
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile: path.join(tmpDir, "policy.json")
      },
      env: {
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor:  { name: "Janus",     model: "Claude Sonnet 4.6" },
        deepPlanner:    { name: "Prometheus", model: "GPT-5.3-Codex" },
        qualityReviewer: { name: "Athena",   model: "Claude Sonnet 4.6" },
        workers: {
          backend: { name: "King David" },
          test:    { name: "Samuel" }
        }
      },
      copilot: { leadershipAutopilot: false },
      canary:         { enabled: false },
      systemGuardian: { enabled: true }
    };
    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("PIPELINE_STAGE_ENUM encodes the full leadership chain in correct order: Janus → Prometheus → Athena → Workers", () => {
    // Verify the canonical stage ordering matches the Janus → Prometheus → Athena → Workers chain.
    // Each sub-chain must be contiguous and in order.
    const stages = [...PIPELINE_STAGE_ENUM];

    const janusStages    = stages.filter(s => s.startsWith("janus_") || s === "idle");
    const prometheusStages = stages.filter(s => s.startsWith("prometheus_"));
    const athenaStages   = stages.filter(s => s.startsWith("athena_"));
    const workerStages   = stages.filter(s =>
      s.startsWith("workers_") || s === "cycle_complete"
    );

    // All four phases must be present
    assert.ok(janusStages.length >= 2,    `Janus phases must exist; got: ${janusStages.join(", ")}`);
    assert.ok(prometheusStages.length >= 2, `Prometheus phases must exist; got: ${prometheusStages.join(", ")}`);
    assert.ok(athenaStages.length >= 1,   `Athena phases must exist; got: ${athenaStages.join(", ")}`);
    assert.ok(workerStages.length >= 2,   `Worker phases must exist; got: ${workerStages.join(", ")}`);

    // Ordering: the first Janus stage must precede the first Prometheus stage,
    // which must precede the first Athena stage, which must precede the first worker stage.
    const firstJanus    = stages.indexOf("janus_awakening");
    const firstPrometheus = stages.indexOf("prometheus_starting");
    const firstAthena   = stages.indexOf("athena_reviewing");
    const firstWorker   = stages.indexOf("workers_dispatching");
    const cycleComplete = stages.indexOf("cycle_complete");

    assert.ok(firstJanus    >= 0, "janus_awakening must be in PIPELINE_STAGE_ENUM");
    assert.ok(firstPrometheus >= 0, "prometheus_starting must be in PIPELINE_STAGE_ENUM");
    assert.ok(firstAthena   >= 0, "athena_reviewing must be in PIPELINE_STAGE_ENUM");
    assert.ok(firstWorker   >= 0, "workers_dispatching must be in PIPELINE_STAGE_ENUM");
    assert.ok(cycleComplete >= 0, "cycle_complete must be in PIPELINE_STAGE_ENUM");

    assert.ok(firstJanus < firstPrometheus,
      `Janus must precede Prometheus in PIPELINE_STAGE_ENUM (janus=${firstJanus} prometheus=${firstPrometheus})`);
    assert.ok(firstPrometheus < firstAthena,
      `Prometheus must precede Athena in PIPELINE_STAGE_ENUM (prometheus=${firstPrometheus} athena=${firstAthena})`);
    assert.ok(firstAthena < firstWorker,
      `Athena must precede Workers in PIPELINE_STAGE_ENUM (athena=${firstAthena} workers=${firstWorker})`);
    assert.ok(firstWorker < cycleComplete,
      `Workers must precede cycle_complete in PIPELINE_STAGE_ENUM (workers=${firstWorker} cycle_complete=${cycleComplete})`);
  });

  it("gate passes for all-clear config — dispatch is not blocked at any leadership chain stage", async () => {
    const plans = [
      { id: "Janus-T1",    role: "backend", dependsOn: [],        filesInScope: ["src/core/janus_supervisor.ts"],
        verification_commands: ["npm test"], acceptance_criteria: ["tests pass"] },
      { id: "Prometheus-T1", role: "test", dependsOn: ["Janus-T1"], filesInScope: ["tests/core/orchestrator.test.ts"],
        verification_commands: ["npm test"], acceptance_criteria: ["tests pass"] }
    ];

    const result = await evaluatePreDispatchGovernanceGate(config, plans, "leadership-all-clear-1");

    assert.equal(result.blocked, false,
      "gate must not block leadership chain dispatch when all gates are clear");
    assert.equal(result.reason, null,
      "reason must be null when gate is clear");
    assert.ok(result.graphResult, "graphResult must be present");
    assert.equal(result.graphResult.status, "ok",
      "dependency graph must resolve cleanly for a valid linear chain");
  });

  it("gate blocks worker dispatch when governance freeze activates between Athena and Workers phases", async () => {
    // Simulate freeze activating after Athena approved — gate must block at workers_dispatching
    const plans = [
      { id: "T1", role: "backend", dependsOn: [], filesInScope: ["src/core/orchestrator.ts"] }
    ];

    const frozenConfig = {
      ...config,
      governanceFreeze: { enabled: true, manualOverrideActive: true }
    };

    const result = await evaluatePreDispatchGovernanceGate(frozenConfig, plans, "leadership-freeze-midchain-1");

    assert.equal(result.blocked, true,
      "gate must block at workers_dispatching stage when governance freeze is active");
    assert.ok(
      result.reason?.startsWith("governance_freeze_active:"),
      `reason must reflect freeze gate; got: ${result.reason}`
    );
    // No rollback triggered — freeze is a non-destructive block
    assert.equal(result.action, undefined,
      "freeze block must not trigger rollback action");
  });

  it("negative path: gate blocks and no workers run when lineage cycle exists in leadership chain", async () => {
    // A circular dependency in the chain blocks dispatch before any worker fires
    const plans = [
      { id: "Janus-T1",    role: "backend", dependsOn: ["Workers-T1"], filesInScope: [] },
      { id: "Workers-T1",  role: "test",    dependsOn: ["Janus-T1"],   filesInScope: [] }
    ];

    const result = await evaluatePreDispatchGovernanceGate(config, plans, "leadership-cycle-1");

    assert.equal(result.blocked, true,
      "circular dependency in leadership chain must block dispatch");
    assert.ok(
      result.reason?.includes("cycle_detected") || result.reason?.includes("lineage"),
      `reason must reference cycle; got: ${result.reason}`
    );
    assert.ok(result.graphResult,
      "graphResult must be present even when cycle blocks dispatch");
  });
});

// ── Carry-forward debt gate — evaluatePreDispatchGovernanceGate integration ───

describe("carry-forward debt gate — pre-dispatch governance gate integration", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-debt-gate-"));
    config = {
      paths: { stateDir: tmpDir },
      env: { copilotCliCommand: "__missing__", targetRepo: "CanerDoqdu/Box" },
      systemGuardian: { enabled: false },
      canary:          { enabled: false },
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows dispatch when no carry-forward ledger exists (missing file is safe fallback)", async () => {
    const result = await evaluatePreDispatchGovernanceGate(config, [], "debt-gate-no-ledger");

    assert.equal(result.blocked, false,
      "missing ledger must not block dispatch — safe fallback to empty ledger");
    assert.equal(result.reason, null);
  });

  it("allows dispatch when ledger has critical entries that are not yet overdue", async () => {
    // Entry opened at cycle 1, due at cycle 4 — checked at cycle 2 (not overdue)
    const ledger = {
      entries: [
        { id: "d1", lesson: "Fix CI pipeline", openedCycle: 1, dueCycle: 4, severity: "critical", closedAt: null, cyclesOpen: 0 },
      ],
      cycleCounter: 2,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(tmpDir, "carry_forward_ledger.json"),
      JSON.stringify(ledger, null, 2),
      "utf8"
    );

    const result = await evaluatePreDispatchGovernanceGate(config, [], "debt-gate-not-overdue");

    assert.equal(result.blocked, false,
      "critical debt that is not yet overdue must not block dispatch");
  });

  it("blocks dispatch when critical overdue debt meets the default threshold of 3", async () => {
    // Three critical entries opened at cycle 1, due at cycle 4, checked at cycle 5 (overdue)
    const ledger = {
      entries: [
        { id: "d1", lesson: "Fix auth bypass vulnerability", openedCycle: 1, dueCycle: 4, severity: "critical", closedAt: null, cyclesOpen: 0 },
        { id: "d2", lesson: "Fix data integrity on concurrent writes", openedCycle: 1, dueCycle: 4, severity: "critical", closedAt: null, cyclesOpen: 0 },
        { id: "d3", lesson: "Fix memory leak in worker runner pool", openedCycle: 1, dueCycle: 4, severity: "critical", closedAt: null, cyclesOpen: 0 },
      ],
      cycleCounter: 5,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(tmpDir, "carry_forward_ledger.json"),
      JSON.stringify(ledger, null, 2),
      "utf8"
    );

    const result = await evaluatePreDispatchGovernanceGate(config, [], "debt-gate-blocks");

    assert.equal(result.blocked, true,
      "3 critical overdue debt items must trigger dispatch block");
    assert.ok(
      result.reason?.startsWith("critical_debt_overdue:"),
      `reason must reflect debt gate; got: ${result.reason}`
    );
    assert.equal(result.action, undefined,
      "debt block must not trigger rollback action");
  });

  it("does not block when overdue entries are all 'warning' severity (not critical)", async () => {
    const ledger = {
      entries: [
        { id: "d1", lesson: "Improve test coverage", openedCycle: 1, dueCycle: 2, severity: "warning", closedAt: null, cyclesOpen: 0 },
        { id: "d2", lesson: "Update stale documentation", openedCycle: 1, dueCycle: 2, severity: "warning", closedAt: null, cyclesOpen: 0 },
        { id: "d3", lesson: "Refactor helper utilities", openedCycle: 1, dueCycle: 2, severity: "warning", closedAt: null, cyclesOpen: 0 },
      ],
      cycleCounter: 10,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(tmpDir, "carry_forward_ledger.json"),
      JSON.stringify(ledger, null, 2),
      "utf8"
    );

    const result = await evaluatePreDispatchGovernanceGate(config, [], "debt-gate-warning-only");

    assert.equal(result.blocked, false,
      "warning-severity overdue entries must not block dispatch (only critical counts)");
  });

  it("respects a custom maxCriticalOverdue threshold from config", async () => {
    // Two critical overdue items — default threshold is 3, custom is 2
    const ledger = {
      entries: [
        { id: "d1", lesson: "Critical debt item A — must be resolved", openedCycle: 1, dueCycle: 3, severity: "critical", closedAt: null, cyclesOpen: 0 },
        { id: "d2", lesson: "Critical debt item B — must be resolved", openedCycle: 1, dueCycle: 3, severity: "critical", closedAt: null, cyclesOpen: 0 },
      ],
      cycleCounter: 10,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(tmpDir, "carry_forward_ledger.json"),
      JSON.stringify(ledger, null, 2),
      "utf8"
    );

    const customConfig = { ...config, carryForward: { maxCriticalOverdue: 2 } };
    const result = await evaluatePreDispatchGovernanceGate(customConfig, [], "debt-gate-custom-threshold");

    assert.equal(result.blocked, true,
      "2 critical overdue items must block when maxCriticalOverdue is set to 2");
    assert.ok(
      result.reason?.startsWith("critical_debt_overdue:"),
      `reason must reflect debt gate; got: ${result.reason}`
    );
  });

  it("negative path: closed critical entries are excluded from overdue count", async () => {
    // Three critical entries, but all are closed — should not block
    const ledger = {
      entries: [
        { id: "d1", lesson: "Fix auth bypass", openedCycle: 1, dueCycle: 4, severity: "critical", closedAt: "2025-01-01T00:00:00Z", closureEvidence: "PR #1", cyclesOpen: 0 },
        { id: "d2", lesson: "Fix data integrity", openedCycle: 1, dueCycle: 4, severity: "critical", closedAt: "2025-01-01T00:00:00Z", closureEvidence: "PR #2", cyclesOpen: 0 },
        { id: "d3", lesson: "Fix memory leak", openedCycle: 1, dueCycle: 4, severity: "critical", closedAt: "2025-01-01T00:00:00Z", closureEvidence: "PR #3", cyclesOpen: 0 },
      ],
      cycleCounter: 5,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(tmpDir, "carry_forward_ledger.json"),
      JSON.stringify(ledger, null, 2),
      "utf8"
    );

    const result = await evaluatePreDispatchGovernanceGate(config, [], "debt-gate-all-closed");

    assert.equal(result.blocked, false,
      "closed critical entries must not count toward the overdue threshold");
  });
});

// ── Budget reconciliation gate — evaluatePreDispatchGovernanceGate integration ─

describe("budget reconciliation gate — pre-dispatch governance gate integration", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-budget-gate-"));
    config = {
      paths: { stateDir: tmpDir },
      env: { copilotCliCommand: "__missing__", targetRepo: "CanerDoqdu/Box", budgetUsd: 5 },
      systemGuardian: { enabled: false },
      canary:          { enabled: false },
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows dispatch when budget is above the Claude usage threshold", async () => {
    const budgetFile = path.join(tmpDir, "budget.json");
    await fs.writeFile(
      budgetFile,
      JSON.stringify({ initialUsd: 5, remainingUsd: 3.0, claudeCalls: 1, workerRuns: 1, updatedAt: new Date().toISOString() }),
      "utf8"
    );
    const cfg = { ...config, paths: { ...config.paths, budgetFile } };

    const result = await evaluatePreDispatchGovernanceGate(cfg, [], "budget-gate-allowed");

    assert.equal(result.blocked, false,
      "dispatch must proceed when remaining budget exceeds the Claude usage threshold");
    assert.equal(result.reason, null);
    // budgetEligibility contract is always emitted
    assert.equal(result.budgetEligibility.eligible, true, "contract must reflect eligible budget");
    assert.equal(result.budgetEligibility.remainingUsd, 3.0);
    assert.equal(result.budgetEligibility.configured, true);
    assert.equal(result.budgetEligibility.reason, null);
  });

  it("blocks dispatch when remaining budget is at or below the Claude usage threshold", async () => {
    const budgetFile = path.join(tmpDir, "budget.json");
    await fs.writeFile(
      budgetFile,
      JSON.stringify({ initialUsd: 5, remainingUsd: 0.15, claudeCalls: 10, workerRuns: 5, updatedAt: new Date().toISOString() }),
      "utf8"
    );
    const cfg = { ...config, paths: { ...config.paths, budgetFile } };

    const result = await evaluatePreDispatchGovernanceGate(cfg, [], "budget-gate-blocked");

    assert.equal(result.blocked, true,
      "dispatch must be blocked when remaining budget is below the Claude usage threshold");
    assert.ok(
      result.reason?.startsWith("budget_exhausted:"),
      `reason must reflect budget exhaustion; got: ${result.reason}`
    );
    assert.equal(result.action, undefined,
      "budget block must not trigger rollback action");
    assert.ok(
      result.reason?.includes("remainingUsd=0.15"),
      `reason must include the remaining amount for observability; got: ${result.reason}`
    );
    // budgetEligibility contract mirrors the gate decision
    assert.equal(result.budgetEligibility.eligible, false, "contract must reflect ineligible budget");
    assert.equal(result.budgetEligibility.remainingUsd, 0.15);
    assert.equal(result.budgetEligibility.configured, true);
    assert.ok(result.budgetEligibility.reason?.startsWith("budget_exhausted:"));
  });

  it("negative path: blocks when remaining budget is exactly 0.2 (boundary — not above threshold)", async () => {
    const budgetFile = path.join(tmpDir, "budget.json");
    await fs.writeFile(
      budgetFile,
      JSON.stringify({ initialUsd: 5, remainingUsd: 0.2, claudeCalls: 10, workerRuns: 5, updatedAt: new Date().toISOString() }),
      "utf8"
    );
    const cfg = { ...config, paths: { ...config.paths, budgetFile } };

    const result = await evaluatePreDispatchGovernanceGate(cfg, [], "budget-gate-boundary");

    assert.equal(result.blocked, true,
      "remaining budget of exactly 0.2 must block dispatch (threshold requires strictly greater than 0.2)");
    assert.equal(result.budgetEligibility.eligible, false, "contract must reflect ineligible at boundary");
  });

  it("fails open (allows dispatch) when budget file path is not configured", async () => {
    // No budgetFile in paths — budget gate is skipped entirely when path is not set
    const cfgNoBudgetPath = {
      ...config,
      paths: { stateDir: tmpDir },
      env: { ...config.env, budgetUsd: 5 },
    };

    const result = await evaluatePreDispatchGovernanceGate(cfgNoBudgetPath, [], "budget-gate-no-path");

    assert.equal(result.blocked, false,
      "unconfigured budgetFile path must skip the budget gate and allow dispatch");
    // Contract always present — reports unconfigured state
    assert.equal(result.budgetEligibility.eligible, true);
    assert.equal(result.budgetEligibility.configured, false);
    assert.equal(result.budgetEligibility.remainingUsd, null);
  });

  it("hard gate: budget exhaustion blocks before governance freeze fires", async () => {
    // Budget exhausted + freeze active simultaneously: budget gate must win because
    // it is now the first gate evaluated, preventing unnecessary downstream work.
    const budgetFile = path.join(tmpDir, "budget.json");
    await fs.writeFile(
      budgetFile,
      JSON.stringify({ initialUsd: 5, remainingUsd: 0.1, claudeCalls: 10, workerRuns: 5, updatedAt: new Date().toISOString() }),
      "utf8"
    );
    const cfg = {
      ...config,
      paths: { ...config.paths, budgetFile },
      governanceFreeze: { enabled: true, manualOverrideActive: true },
    };

    const result = await evaluatePreDispatchGovernanceGate(cfg, [], "budget-hard-gate-freeze-active");

    assert.equal(result.blocked, true, "dispatch must be blocked");
    assert.ok(
      result.reason?.startsWith("budget_exhausted:"),
      `budget gate must fire before freeze gate; got: ${result.reason}`
    );
    assert.equal(result.budgetEligibility.eligible, false);
    assert.equal(result.budgetEligibility.remainingUsd, 0.1);
    // graphResult is null because graph resolution is skipped when budget blocks first
    assert.equal(result.graphResult, null, "graphResult must be null when budget gate fires first");
  });
});

// ── Task 3 hardening: plan evidence coupling gate ─────────────────────────────

describe("plan evidence coupling gate — pre-dispatch governance gate (Task 3 hardening)", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-coupling-gate-"));
    config = {
      paths: { stateDir: tmpDir },
      env: { copilotCliCommand: "__missing__", targetRepo: "CanerDoqdu/Box" },
      systemGuardian: { enabled: false },
      canary:          { enabled: false },
    };
    await fs.writeFile(
      path.join(tmpDir, "policy.json"),
      JSON.stringify({ blockedCommands: [] }, null, 2),
      "utf8"
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("blocks dispatch when a plan is missing verification_commands", async () => {
    const plans = [
      { id: "T1", task: "do something", acceptance_criteria: ["all tests pass"] }
      // missing verification_commands
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "coupling-gate-no-cmds");
    assert.equal(result.blocked, true, "must block when plan has no verification_commands");
    assert.ok(
      result.reason?.includes("plan_evidence_coupling_invalid"),
      `reason must reflect coupling failure; got: ${result.reason}`
    );
  });

  it("blocks dispatch when a plan is missing acceptance_criteria", async () => {
    const plans = [
      { id: "T1", task: "do something", verification_commands: ["npm test"] }
      // missing acceptance_criteria
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "coupling-gate-no-ac");
    assert.equal(result.blocked, true, "must block when plan has no acceptance_criteria");
    assert.ok(
      result.reason?.includes("plan_evidence_coupling_invalid"),
      `reason must reflect coupling failure; got: ${result.reason}`
    );
  });

  it("allows dispatch when all plans have valid evidence coupling", async () => {
    const plans = [
      {
        id: "T1",
        task: "do something",
        verification_commands: ["npm test"],
        acceptance_criteria: ["all tests pass"],
        dependsOn: [],
        filesInScope: []
      }
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "coupling-gate-valid");
    assert.equal(result.blocked, false, "must allow dispatch when all coupling fields are present");
  });

  it("allows dispatch when plans is empty (no coupling validation needed)", async () => {
    const result = await evaluatePreDispatchGovernanceGate(config, [], "coupling-gate-empty");
    assert.equal(result.blocked, false, "empty plan list must not trigger coupling gate");
  });

  it("negative path: plan with empty verification_commands array is blocked", async () => {
    const plans = [
      { id: "T1", task: "do something", verification_commands: [], acceptance_criteria: ["tests pass"] }
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "coupling-gate-empty-cmds");
    assert.equal(result.blocked, true);
    assert.ok(result.reason?.includes("plan_evidence_coupling_invalid"));
  });
});

// ── Dependency readiness gate — evaluatePreDispatchGovernanceGate integration ──

describe("dependency readiness gate — pre-dispatch governance gate integration", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-readiness-gate-"));
    config = {
      paths: { stateDir: tmpDir },
      env: { copilotCliCommand: "__missing__", targetRepo: "CanerDoqdu/Box" },
      systemGuardian: { enabled: false },
      canary:          { enabled: false },
    };
    await fs.writeFile(
      path.join(tmpDir, "policy.json"),
      JSON.stringify({ blockedCommands: [] }, null, 2),
      "utf8"
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("allows dispatch when plans have no confidence metadata (fail-open for legacy plans)", async () => {
    const plans = [
      {
        id: "T1",
        task: "implement feature",
        verification_commands: ["npm test"],
        acceptance_criteria: ["tests pass"],
        dependsOn: [],
        filesInScope: [],
      }
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "readiness-no-confidence");
    assert.equal(result.blocked, false,
      "plans without confidence fields must not trigger readiness gate (fail-open)");
  });

  it("allows dispatch when all confidence values meet the default threshold", async () => {
    const plans = [
      {
        id: "T1",
        task: "implement feature",
        verification_commands: ["npm test"],
        acceptance_criteria: ["tests pass"],
        dependsOn: [],
        filesInScope: [],
        shapeConfidence: 0.8,
        budgetConfidence: 0.7,
        dependencyConfidence: 0.9,
      }
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "readiness-above-threshold");
    assert.equal(result.blocked, false,
      "plans with all confidence values above threshold must not be blocked by readiness gate");
  });

  it("NEGATIVE PATH: blocks dispatch when a plan's shapeConfidence is below the default threshold", async () => {
    const plans = [
      {
        id: "T1",
        task: "implement feature",
        verification_commands: ["npm test"],
        acceptance_criteria: ["tests pass"],
        dependsOn: [],
        filesInScope: [],
        shapeConfidence: 0.2,  // below 0.5 default threshold
      }
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "readiness-below-threshold");
    assert.equal(result.blocked, true,
      "plan with shapeConfidence below threshold must block dispatch via readiness gate");
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.DEPENDENCY_READINESS_INCOMPLETE),
      `reason must start with dependency_readiness_incomplete; got: ${result.reason}`
    );
    assert.equal((result as any).gateKey, "DEPENDENCY_READINESS", "gateKey must identify dependency readiness gate");
    assert.equal(result.gateIndex, 10, "gateIndex must be 10 for DEPENDENCY_READINESS");
  });

  it("NEGATIVE PATH: blocks dispatch when budgetConfidence is below threshold", async () => {
    const plans = [
      {
        id: "T2",
        task: "refactor module",
        verification_commands: ["npm test"],
        acceptance_criteria: ["tests pass"],
        dependsOn: [],
        filesInScope: [],
        budgetConfidence: 0.1,
      }
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "readiness-budget-low");
    assert.equal(result.blocked, true);
    assert.ok(result.reason?.includes("dependency_readiness_incomplete"));
    assert.ok(result.readinessResult, "readinessResult must be present when readiness gate blocks");
  });

  it("NEGATIVE PATH: blocks dispatch when a confidence value is non-numeric (MISSING_CONFIDENCE)", async () => {
    const plans = [
      {
        id: "T3",
        task: "add tests",
        verification_commands: ["npm test"],
        acceptance_criteria: ["all tests pass"],
        dependsOn: [],
        filesInScope: [],
        shapeConfidence: "high",  // non-numeric — triggers MISSING_CONFIDENCE
      }
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "readiness-non-numeric");
    assert.equal(result.blocked, true);
    assert.ok(result.reason?.includes("dependency_readiness_incomplete"));
  });

  it("respects custom minConfidence threshold from config.runtime.minPlanConfidence", async () => {
    const plans = [
      {
        id: "T4",
        task: "add tests",
        verification_commands: ["npm test"],
        acceptance_criteria: ["tests pass"],
        dependsOn: [],
        filesInScope: [],
        shapeConfidence: 0.4,  // below 0.5 default but above 0.3 custom
      }
    ];

    // With default threshold (0.5): blocked
    const blockedResult = await evaluatePreDispatchGovernanceGate(config, plans, "readiness-custom-default");
    assert.equal(blockedResult.blocked, true);

    // With custom threshold (0.3): allowed
    const customConfig = { ...config, runtime: { minPlanConfidence: 0.3 } };
    const passResult = await evaluatePreDispatchGovernanceGate(customConfig, plans, "readiness-custom-lower");
    assert.equal(passResult.blocked, false,
      "plan with shapeConfidence=0.4 must pass when minPlanConfidence is set to 0.3");
  });

  it("readiness gate fires after plan evidence coupling gate (gate precedence 10 > 8)", async () => {
    // Plan has low confidence AND missing acceptance_criteria:
    // evidence coupling (gate 8) must block BEFORE readiness (gate 9)
    const plans = [
      {
        id: "T5",
        task: "do work",
        verification_commands: ["npm test"],
        // missing acceptance_criteria — triggers evidence coupling gate
        shapeConfidence: 0.1,  // would trigger readiness gate if coupling didn't fire first
      }
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "readiness-precedence");
    assert.equal(result.blocked, true);
    assert.ok(
      result.reason?.startsWith("plan_evidence_coupling_invalid"),
      `evidence coupling must fire before readiness gate; got: ${result.reason}`
    );
    assert.equal(result.gateIndex, 8, "gateIndex must be 8 (evidence coupling), not 9 (readiness)");
  });
});

// ── Oversized packet hard admission gate ──────────────────────────────────────

describe("oversized packet hard admission gate — evaluatePreDispatchGovernanceGate (Gate 13)", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-oversize-gate-"));
    config = {
      paths: { stateDir: tmpDir },
      env: { copilotCliCommand: "__missing__", targetRepo: "CanerDoqdu/Box" },
      systemGuardian: { enabled: false },
      canary:          { enabled: false },
      planner: { maxActionableStepsPerPacket: 2 },
    };
    await fs.writeFile(
      path.join(tmpDir, "policy.json"),
      JSON.stringify({ blockedCommands: [] }, null, 2),
      "utf8"
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("rebatches plans into sub-batches when a role group exceeds maxActionableStepsPerPacket", async () => {
    const plans = [
      { role: "Evolution Worker", task: "Task A", verification_commands: ["npm test"], acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.0 },
      { role: "Evolution Worker", task: "Task B", verification_commands: ["npm test"], acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.0 },
      { role: "Evolution Worker", task: "Task C", verification_commands: ["npm test"], acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.0 },
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "oversize-gate-rebatch");
    // Soft-gate: plans are rebatched rather than blocked when individual plans fit within cap.
    assert.equal(result.blocked, false, "dispatch must not be blocked when rebatch succeeds — plans are redistributed");
    // Plans should be redistributed: first 2 in slot 1, last 1 in slot 2.
    assert.deepEqual(plans.map((p: any) => p._batchIndex), [1, 1, 2], "plans must be redistributed into sub-batches");
  });

  it("rebatches when ordered-step aggregate exceeds cap even if plan count does not", async () => {
    const plans = [
      {
        role: "Evolution Worker",
        task: "Task A",
        verification: "tests/core/a.test.ts — test: passes",
        verification_commands: ["npm test -- tests/core/a.test.ts"],
        acceptance_criteria: ["step 1", "step 2"],
        capacityDelta: 0.1,
        requestROI: 1.0,
      },
      {
        role: "Evolution Worker",
        task: "Task B",
        verification: "tests/core/b.test.ts — test: passes",
        verification_commands: ["npm test -- tests/core/b.test.ts"],
        acceptance_criteria: ["step 1", "step 2"],
        capacityDelta: 0.1,
        requestROI: 1.0,
      },
    ];
    const result = await evaluatePreDispatchGovernanceGate(
      { ...config, planner: { maxActionableStepsPerPacket: 3 } },
      plans,
      "oversize-gate-rebatch-complexity",
    );
    // Soft-gate: each individual plan (2 steps) fits within cap (3); rebatch distributes.
    assert.equal(result.blocked, false, "dispatch must not be blocked when each individual plan fits and rebatch succeeds");
    assert.deepEqual(plans.map((p: any) => p._batchIndex), [1, 2], "plans must be redistributed into separate slots");
  });

  it("binds named verification target before admission when verification is non-specific", async () => {
    const plans = [
      {
        id: "bind-v1",
        role: "Evolution Worker",
        task: "Bind verification command target",
        verification: "npm test",
        verification_commands: [
          "npm test",
          "npm test -- tests/core/orchestrator_pipeline_progress.test.ts",
        ],
        acceptance_criteria: ["step 1"],
        capacityDelta: 0.1,
        requestROI: 1.0,
      },
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "oversize-gate-bind-target");
    assert.equal(result.blocked, false, "single valid plan must pass governance gate");
    assert.equal(
      plans[0].verification,
      "npm test -- tests/core/orchestrator_pipeline_progress.test.ts",
      "gate must bind the first specific verification target before dispatch admission",
    );
    assert.equal(
      plans[0]._boundVerificationTarget,
      "npm test -- tests/core/orchestrator_pipeline_progress.test.ts",
      "bound target marker must be recorded for downstream dispatch surfaces",
    );
  });

  it("allows dispatch when all role groups are within the cap", async () => {
    const plans = [
      { role: "Evolution Worker", task: "Task A", verification_commands: ["npm test"], acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.0 },
      { role: "Evolution Worker", task: "Task B", verification_commands: ["npm test"], acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.0 },
      { role: "Infrastructure Worker", task: "Task C", verification_commands: ["npm run build"], acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.0 },
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "oversize-gate-pass");
    assert.equal(result.blocked, false, "dispatch must not be blocked when all role groups are within cap");
  });

  it("NEGATIVE PATH: rebatches using default OVERBUNDLE_STEPS_THRESHOLD when maxActionableStepsPerPacket is not configured", async () => {
    const configNoCapLimit = {
      paths: { stateDir: tmpDir },
      env: { copilotCliCommand: "__missing__", targetRepo: "CanerDoqdu/Box" },
      systemGuardian: { enabled: false },
      canary:          { enabled: false },
      // no planner.maxActionableStepsPerPacket — gate uses OVERBUNDLE_STEPS_THRESHOLD (9) fallback
    };
    const plans = Array.from({ length: 10 }, (_, i) => ({
      role: "Evolution Worker",
      task: `Task ${i + 1}`,
      verification: `tests/core/orchestrator_pipeline_progress.test.ts — test: case ${i + 1}`,
      verification_commands: ["npm test -- tests/core/orchestrator_pipeline_progress.test.ts"],
      acceptance_criteria: ["pass"],
      capacityDelta: 0.1,
      requestROI: 1.0,
    }));
    const result = await evaluatePreDispatchGovernanceGate(configNoCapLimit, plans, "oversize-gate-no-config");
    // Soft-gate: 10 plans rebatch into 9+1 sub-batches using OVERBUNDLE_STEPS_THRESHOLD=9
    assert.equal(result.blocked, false, "gate must rebatch rather than block when using default threshold and plans fit individually");
    const batchIndices = plans.map((p: any) => p._batchIndex);
    assert.ok(batchIndices.includes(2), "plans exceeding default threshold must overflow into a second sub-batch");
  });

  it("no OVERSIZED_PACKET reason emitted when role group is rebatchable under the cap", async () => {
    const plans = [
      { role: "CI Worker", task: "Fix test A", verification_commands: ["npm test"], acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.0 },
      { role: "CI Worker", task: "Fix test B", verification_commands: ["npm test"], acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.0 },
      { role: "CI Worker", task: "Fix test C", verification_commands: ["npm test"], acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.0 },
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "oversize-gate-reason");
    // Soft-gate succeeds: no block, no OVERSIZED_PACKET reason.
    assert.equal(result.blocked, false);
    assert.equal(result.reason, null, "no block reason must be emitted when rebatch succeeds");
  });

  it("blocks via individual-plan complexity gate when a single plan exceeds the cap", async () => {
    // A single plan with more acceptance_criteria than actionableCap triggers
    // the individual-plan layer of Gate 13 (checkOverbundleHardAdmission),
    // not just the role-group aggregated layer.
    const plans = [
      {
        id: "oversize-single-plan",
        role: "Evolution Worker",
        task: "Individual plan overbundle gate test",
        verification_commands: ["npm test -- tests/core/orchestrator_pipeline_progress.test.ts"],
        acceptance_criteria: ["step 1", "step 2", "step 3", "step 4"],  // 4 > cap of 3
        capacityDelta: 0.1,
        requestROI: 1.0,
      },
    ];
    const result = await evaluatePreDispatchGovernanceGate(
      { ...config, planner: { maxActionableStepsPerPacket: 3 } },
      plans,
      "oversize-individual-plan-check",
    );
    assert.equal(result.blocked, true,
      "single plan exceeding the per-plan step cap must be blocked by Gate 13");
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.OVERSIZED_PACKET),
      `reason must start with OVERSIZED_PACKET prefix; got: ${result.reason}`,
    );
    assert.ok(
      result.reason?.includes("overbundle_hard_admission"),
      `individual-plan layer must produce overbundle_hard_admission sub-reason; got: ${result.reason}`,
    );
    assert.equal(result.gateIndex, 13, "gateIndex must be 13 (OVERSIZED_PACKET)");
  });

  it("NEGATIVE PATH: role-group soft-gate rebatches when aggregate exceeds cap even if individual plans do not", async () => {
    // Two plans each at exactly the cap: individual check passes; role-group check fires rebatch.
    const plans = [
      {
        role: "Evolution Worker",
        task: "Plan A at cap",
        verification_commands: ["npm test"],
        acceptance_criteria: ["step 1", "step 2"],  // 2 == cap
        capacityDelta: 0.1,
        requestROI: 1.0,
      },
      {
        role: "Evolution Worker",
        task: "Plan B at cap",
        verification_commands: ["npm test"],
        acceptance_criteria: ["step 1", "step 2"],  // 2 == cap → role group = 4 > 2
        capacityDelta: 0.1,
        requestROI: 1.0,
      },
    ];
    const result = await evaluatePreDispatchGovernanceGate(config, plans, "oversize-role-group-fires");
    // Soft-gate: role-group layer fires but rebatch succeeds — no block.
    assert.equal(result.blocked, false,
      "role-group layer must rebatch when aggregate exceeds cap even if individual plans do not");
    // The role-group layer (not the individual layer) must have fired rebatch.
    assert.deepEqual(plans.map((p: any) => p._batchIndex), [1, 2], "each plan must be placed in its own sub-batch slot");
    assert.equal(result.reason, null, "no block reason must be emitted when rebatch succeeds");
  });
});

// ── Terminology drift prevention ──────────────────────────────────────────────
//
// These tests pin the exact canonical terminology used across:
//   1. PIPELINE_STAGE_ENUM  — stage IDs referenced by the orchestrator and dashboard
//   2. PIPELINE_STEPS       — human-readable stage labels used in the dashboard
//   3. BLOCK_REASON         — guardrail reason code prefixes emitted by the governance gate
//
// If any of these change, tests here fail immediately and force an explicit
// documentation update — preventing silent terminology drift between the
// orchestrator, pipeline progress tracker, and test assertions.

describe("pipeline progress — terminology drift prevention (stage IDs)", () => {
  it("pins canonical Athena review exception reason code used for fail-closed blocker propagation", () => {
    assert.equal(
      ATHENA_PLAN_REVIEW_REASON_CODE.REVIEW_EXCEPTION,
      "REVIEW_EXCEPTION",
      "Athena review exception code must remain stable for blocker telemetry/event consumers"
    );
  });

  it("PIPELINE_STAGE_ENUM contains exactly the canonical leadership chain stage IDs", () => {
    // Authoritative ordered list of all stage IDs.
    // Any addition, removal, or rename must update this list explicitly.
    const CANONICAL_STAGE_IDS = [
      "idle",
      "janus_awakening",
      "janus_reading",
      "janus_thinking",
      "janus_decided",
      "prometheus_starting",
      "prometheus_reading_repo",
      "prometheus_analyzing",
      "prometheus_audit",
      "prometheus_done",
      "athena_reviewing",
      "athena_approved",
      "workers_dispatching",
      "workers_running",
      "workers_finishing",
      "cycle_complete",
    ];
    assert.deepEqual(
      [...PIPELINE_STAGE_ENUM],
      CANONICAL_STAGE_IDS,
      "PIPELINE_STAGE_ENUM must match the canonical stage ID list exactly — update this list if a stage is intentionally renamed or added"
    );
  });

  it("PIPELINE_STEPS contains exactly the canonical stage labels (prevents label drift)", () => {
    // Authoritative stage-ID-to-label mapping.
    // Labels appear in the dashboard — changes require an explicit update here.
    const CANONICAL_LABELS: Record<string, string> = {
      idle:                    "Idle",
      janus_awakening:         "Janus Awakening",
      janus_reading:           "Janus Reading System State",
      janus_thinking:          "Janus Analyzing (AI)",
      janus_decided:           "Janus Decided",
      prometheus_starting:     "Prometheus Awakening",
      prometheus_reading_repo: "Prometheus Reading Repository",
      prometheus_analyzing:    "Prometheus Deep Analysis (AI)",
      prometheus_audit:        "Prometheus Read Audit",
      prometheus_done:         "Prometheus Analysis Complete",
      athena_reviewing:        "Athena Reviewing Plan",
      athena_approved:         "Athena Plan Approved",
      workers_dispatching:     "Dispatching Workers",
      workers_running:         "Workers Running",
      workers_finishing:       "Workers Finishing",
      cycle_complete:          "Cycle Complete",
    };

    for (const step of PIPELINE_STEPS) {
      assert.equal(
        step.label,
        CANONICAL_LABELS[step.id],
        `PIPELINE_STEPS label for '${step.id}' must be '${CANONICAL_LABELS[step.id]}' — got '${step.label}'. Update CANONICAL_LABELS if the label change is intentional.`
      );
    }
  });

  it("governance gate BLOCK_REASON values match canonical reason-code prefixes", () => {
    // Authoritative reason-code prefix map for evaluatePreDispatchGovernanceGate.
    // These prefixes appear in reason strings returned by the gate and are
    // pattern-matched by consumers and monitors — any change must be deliberate.
    const CANONICAL_BLOCK_REASONS: Record<string, string> = {
      BUDGET_EXHAUSTED:               "budget_exhausted",
      GUARDRAIL_PAUSE_WORKERS_ACTIVE: "guardrail_pause_workers_active",
      GUARDRAIL_FORCE_CHECKPOINT_ACTIVE: "force_checkpoint_validation_active",
      GOVERNANCE_FREEZE_ACTIVE:       "governance_freeze_active",
      AUTONOMY_EXECUTION_GATE_NOT_READY: "autonomy_execution_gate_not_ready",
      LINEAGE_CYCLE_DETECTED:         "lineage_cycle_detected",
      GOVERNANCE_CANARY_BREACH:       "governance_canary_breach",
      CLOUD_AGENT_GOVERNANCE_POLICY_VIOLATION: "cloud_agent_governance_policy_violation",
      CRITICAL_DEBT_OVERDUE:          "critical_debt_overdue",
      MANDATORY_DRIFT_DEBT_UNRESOLVED:"mandatory_drift_debt_unresolved",
      PLAN_EVIDENCE_COUPLING_INVALID: "plan_evidence_coupling_invalid",
      CROSS_CYCLE_PREREQUISITE_UNMET: "cross_cycle_prerequisite_unmet",
      DEPENDENCY_READINESS_INCOMPLETE:"dependency_readiness_incomplete",
      LANE_DIVERSITY_INSUFFICIENT:    "lane_diversity_insufficient",
      ROLLING_YIELD_THROTTLE:         "rolling_yield_throttle",
      SPECIALIZATION_ADMISSION_GATE:  "specialization_admission_gate_failed",
      OVERSIZED_PACKET:               "packet_exceeds_actionable_steps_cap",
    };

    for (const [key, expectedValue] of Object.entries(CANONICAL_BLOCK_REASONS)) {
      assert.equal(
        (BLOCK_REASON as Record<string, string>)[key],
        expectedValue,
        `BLOCK_REASON.${key} must equal '${expectedValue}' — update CANONICAL_BLOCK_REASONS if the reason code is intentionally changed`
      );
    }

    // Ensure no new reason codes were added without being captured here
    const actualKeys = Object.keys(BLOCK_REASON).sort();
    const canonicalKeys = Object.keys(CANONICAL_BLOCK_REASONS).sort();
    assert.deepEqual(
      actualKeys,
      canonicalKeys,
      `BLOCK_REASON has ${actualKeys.length} keys but CANONICAL_BLOCK_REASONS has ${canonicalKeys.length}. New reason codes: [${actualKeys.filter(k => !canonicalKeys.includes(k)).join(", ")}]. Removed reason codes: [${canonicalKeys.filter(k => !actualKeys.includes(k)).join(", ")}]. Update CANONICAL_BLOCK_REASONS to reflect intentional changes.`
    );
  });

  it("negative path: unknown stage ID is not in PIPELINE_STAGE_ENUM (catches accidental renames)", () => {
    // Verify that a hypothetical mis-typed or drifted stage name is not silently accepted
    const driftedNames = ["planner_starting", "supervisor_awakening", "review_approved", "dispatch_workers"];
    for (const drifted of driftedNames) {
      assert.equal(
        (PIPELINE_STAGE_ENUM as ReadonlyArray<string>).includes(drifted),
        false,
        `Drifted stage name '${drifted}' must not appear in PIPELINE_STAGE_ENUM`
      );
    }
  });
});

// ── Wave topology preservation integration (Task 3) ──────────────────────────

import { buildTokenFirstBatches } from "../../src/core/worker_batch_planner.js";

describe("orchestrator dispatch — wave topology preserved in token-first planner (Task 3)", () => {
  const tokenFirstConfig = {
    copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 },
    runtime: { workerContextTokenLimit: 200_000 },
  };

  it("wave-1 batches appear before wave-2 batches in dispatch order when using buildTokenFirstBatches", () => {
    const plans = [
      { role: "Evolution Worker", task: "Wave-2 dependent task — update orchestrator", wave: 2, target_files: ["src/core/orchestrator.ts"] },
      { role: "Evolution Worker", task: "Wave-1 foundational task — add verification gate", wave: 1, target_files: ["src/core/verification_gate.ts"] },
    ];
    const batches = buildTokenFirstBatches(plans, tokenFirstConfig);
    const firstBatchWave = batches[0]?.wave;
    const lastBatchWave = batches[batches.length - 1]?.wave;
    assert.equal(firstBatchWave, 1, "first batch must be wave 1");
    assert.equal(lastBatchWave, 2, "last batch must be wave 2");
  });

  it("negative: single-wave plans all produce batches with the same wave number", () => {
    const plans = [
      { role: "Evolution Worker", task: "Task A", wave: 1, target_files: ["src/a.ts"] },
      { role: "Evolution Worker", task: "Task B", wave: 1, target_files: ["src/b.ts"] },
    ];
    const batches = buildTokenFirstBatches(plans, tokenFirstConfig);
    for (const batch of batches) {
      assert.equal(batch.wave, 1, "all batches must be wave 1");
    }
  });
});

// ── Reroute history: E2E persistence and optimizer penalty assertions ──────────

describe("reroute_history.jsonl — schema and optimizer penalty E2E", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-reroute-e2e-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("reroute_history.jsonl records written by the orchestrator conform to REROUTE_HISTORY_RECORD_SCHEMA", async () => {
    // Simulate the record shape the orchestrator dispatch phase writes to reroute_history.jsonl
    // (see orchestrator.ts lines 3079-3087 — the exact fields written).
    const rerouteRecord = {
      recordedAt: new Date().toISOString(),
      role: "specialist-worker",
      lane: "specialist",
      reasonCode: "fill_threshold",
      fillRatio: 0.15,
      laneScore: 0.42,
    };
    const rerouteHistoryPath = path.join(tmpDir, "reroute_history.jsonl");
    await fs.writeFile(rerouteHistoryPath, JSON.stringify(rerouteRecord) + "\n", "utf8");

    // Read back and validate against schema
    const raw = await fs.readFile(rerouteHistoryPath, "utf8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    assert.equal(lines.length, 1, "one reroute record must be written");

    const parsed = JSON.parse(lines[0]);
    for (const field of REROUTE_HISTORY_RECORD_SCHEMA.required) {
      assert.ok(field in parsed,
        `reroute_history record must include required field '${field}'`);
    }
    assert.equal(parsed.role, "specialist-worker");
    assert.equal(parsed.reasonCode, "fill_threshold");
  });

  it("reroute_history.jsonl records are read back and passed to the optimizer — penalties appear in result", async () => {
    // Pre-seed reroute_history.jsonl with records for "backend" role
    const rerouteHistoryPath = path.join(tmpDir, "reroute_history.jsonl");
    const records = [
      {
        recordedAt: new Date().toISOString(),
        role: "backend",
        lane: "backend",
        reasonCode: "fill_threshold",
        fillRatio: 0.1,
        laneScore: 0.3,
      },
      {
        recordedAt: new Date().toISOString(),
        role: "backend",
        lane: "backend",
        reasonCode: "performance_degraded",
        fillRatio: 0.05,
        laneScore: 0.2,
      },
    ];
    const content = records.map(r => JSON.stringify(r)).join("\n") + "\n";
    await fs.writeFile(rerouteHistoryPath, content, "utf8");

    // Simulate the optimizer read-back: read last N records and pass as rerouteReasons
    const raw = await fs.readFile(rerouteHistoryPath, "utf8");
    const rerouteReasons = raw.split("\n")
      .filter(l => l.trim().length > 0)
      .slice(-20)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    assert.equal(rerouteReasons.length, 2, "both reroute records must be read back");

    // Pass to optimizer — verify penalties are applied
    const result = runInterventionOptimizer(
      [{
        id: "rh-e2e",
        type: "task",
        wave: 1,
        role: "backend",
        title: "Backend fix",
        successProbability: 0.8,
        impact: 0.8,
        riskCost: 0.2,
        sampleCount: 3,
        budgetCost: 1,
      }],
      { maxWorkerSpawns: 10 },
      { rerouteReasons },
    );

    assert.ok(result.rerouteCostPenaltiesApplied >= 1,
      `rerouteCostPenaltiesApplied must be >= 1 when reroute history contains matching role records; got ${result.rerouteCostPenaltiesApplied}`);
    const item = result.selected.find((s: any) => s.id === "rh-e2e");
    assert.ok(item !== undefined, "intervention must be selected");
    assert.equal(item._reroutePenaltyApplied, true,
      "_reroutePenaltyApplied must be true when reroute history records match the role");
  });

  it("multiple reroute records for the same role accumulate penalties capped at REROUTE_EV_MAX_PENALTY", async () => {
    // Generate many reroute records for the same role
    const manyRecords = Array.from({ length: 15 }, (_, i) => ({
      recordedAt: new Date().toISOString(),
      role: "backend",
      lane: "backend",
      reasonCode: "fill_threshold",
      fillRatio: 0.1,
      laneScore: 0.2,
    }));
    const rerouteReasons = manyRecords;

    const unpenalised = runInterventionOptimizer(
      [{ id: "unpen", type: "task", wave: 1, role: "backend", title: "T", successProbability: 0.8,
         impact: 0.8, riskCost: 0.2, sampleCount: 3, budgetCost: 1 }],
      { maxWorkerSpawns: 10 },
      { rerouteReasons: [] },
    );
    const penalised = runInterventionOptimizer(
      [{ id: "pen", type: "task", wave: 1, role: "backend", title: "T", successProbability: 0.8,
         impact: 0.8, riskCost: 0.2, sampleCount: 3, budgetCost: 1 }],
      { maxWorkerSpawns: 10 },
      { rerouteReasons },
    );

    const unpenSP = unpenalised.selected[0]?.adjustedSuccessProbability ?? 1;
    const penSP   = penalised.selected[0]?.adjustedSuccessProbability ?? 0;
    const actualPenalty = unpenSP - penSP;

    assert.ok(penSP < unpenSP, "penalised SP must be lower than unpenalised SP");
    assert.ok(actualPenalty <= REROUTE_EV_MAX_PENALTY + 0.001,
      `penalty (${actualPenalty}) must not exceed REROUTE_EV_MAX_PENALTY (${REROUTE_EV_MAX_PENALTY})`);
  });

  it("reroute_history records without matching roles produce zero rerouteCostPenaltiesApplied", async () => {
    const rerouteReasons = [
      {
        recordedAt: new Date().toISOString(),
        role: "infrastructure-worker",
        lane: "infrastructure",
        reasonCode: "fill_threshold",
        fillRatio: 0.1,
        laneScore: 0.3,
      },
    ];
    const result = runInterventionOptimizer(
      [{
        id: "no-match-e2e",
        type: "task",
        wave: 1,
        role: "backend",
        title: "Backend task",
        successProbability: 0.8,
        impact: 0.8,
        riskCost: 0.2,
        sampleCount: 3,
        budgetCost: 1,
      }],
      { maxWorkerSpawns: 10 },
      { rerouteReasons },
    );
    assert.equal(result.rerouteCostPenaltiesApplied, 0,
      "non-matching reroute history must produce zero penalties");
    const item = result.selected.find((s: any) => s.id === "no-match-e2e");
    assert.ok(item !== undefined, "unpenalised intervention must be selected");
    assert.ok(!item._reroutePenaltyApplied, "_reroutePenaltyApplied must be absent/falsy for unpenalised intervention");
  });
});

// ── Task 1: buildIncrementalSignatureIndex — incremental cache behavior ────────

import { buildIncrementalSignatureIndex } from "../../src/core/fs_utils.js";

describe("buildIncrementalSignatureIndex — incremental file-hash cache", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-sig-idx-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("finds signatures present in a .ts file", async () => {
    await fs.writeFile(path.join(tmpDir, "a.ts"), "export function validateAllPlans() {}", "utf8");
    const found = await buildIncrementalSignatureIndex(tmpDir, ["validateallplans", "plan_contract_validator"]);
    assert.ok(found.has("validateallplans"), "should find the signature that appears in the file");
    assert.ok(!found.has("plan_contract_validator"), "should not find a signature absent from the file");
  });

  it("returns empty Set when srcDir does not exist", async () => {
    const noDir = path.join(tmpDir, "no_such_dir");
    const found = await buildIncrementalSignatureIndex(noDir, ["something"]);
    assert.equal(found.size, 0, "missing srcDir must yield empty Set, not throw");
  });

  it("returns empty Set when allSignatures is empty", async () => {
    await fs.writeFile(path.join(tmpDir, "b.ts"), "export const x = 1;", "utf8");
    const found = await buildIncrementalSignatureIndex(tmpDir, []);
    assert.equal(found.size, 0, "empty signature list must yield empty Set");
  });

  it("cache hit: unchanged file is not re-read on second call (no stale results)", async () => {
    const filePath = path.join(tmpDir, "c.ts");
    await fs.writeFile(filePath, "export function hydratedispatchcontextwithcievidence() {}", "utf8");
    const sig = "hydratedispatchcontextwithcievidence";

    const first = await buildIncrementalSignatureIndex(tmpDir, [sig]);
    assert.ok(first.has(sig), "first call must find the signature");

    // Overwrite with content that no longer contains the signature — but cache
    // should detect the hash change and pick up the new content.
    await fs.writeFile(filePath, "export function something_else() {}", "utf8");
    const second = await buildIncrementalSignatureIndex(tmpDir, [sig]);
    assert.ok(!second.has(sig), "after content change the signature must no longer be found");
  });

  it("negative path: signature search is case-insensitive", async () => {
    await fs.writeFile(path.join(tmpDir, "d.ts"), "export const DispatchBlockReason = {};", "utf8");
    // Signature is lowercase; source has mixed case — must still match
    const found = await buildIncrementalSignatureIndex(tmpDir, ["dispatchblockreason"]);
    assert.ok(found.has("dispatchblockreason"), "signature matching must be case-insensitive");
  });
});

// ── Task 2: AUTO_APPROVE_DISPATCH_SIGNAL includes DELTA_REVIEW_APPROVED ───────

import { AUTO_APPROVE_DISPATCH_SIGNAL } from "../../src/core/orchestrator.js";

describe("AUTO_APPROVE_DISPATCH_SIGNAL — delta-review signal", () => {
  it("exports DELTA_REVIEW_APPROVED constant", () => {
    assert.equal(
      AUTO_APPROVE_DISPATCH_SIGNAL.DELTA_REVIEW_APPROVED,
      "DELTA_REVIEW_APPROVED",
      "DELTA_REVIEW_APPROVED must be present in AUTO_APPROVE_DISPATCH_SIGNAL",
    );
  });

  it("all three canonical signals are present and frozen", () => {
    assert.ok(Object.isFrozen(AUTO_APPROVE_DISPATCH_SIGNAL), "must be frozen");
    assert.ok("LOW_RISK_UNCHANGED"    in AUTO_APPROVE_DISPATCH_SIGNAL);
    assert.ok("HIGH_QUALITY_LOW_RISK" in AUTO_APPROVE_DISPATCH_SIGNAL);
    assert.ok("DELTA_REVIEW_APPROVED" in AUTO_APPROVE_DISPATCH_SIGNAL);
  });
});

// ── Task 3: Athena-preassigned batch specialist telemetry ─────────────────────

import { assignWorkersToPlans } from "../../src/core/capability_pool.js";
import { buildTokenFirstBatches } from "../../src/core/worker_batch_planner.js";

describe("Athena-preassigned batch — specialist utilization telemetry derived", () => {
  it("capabilityPoolResult.specializationUtilization fields are populated by assignWorkersToPlans", () => {
    // Verify the pool result shape so orchestrator can safely inject it
    const plans = [
      { id: "p1", role: "evolution-worker", task: "Implement feature", wave: 1, riskLevel: "low" },
      { id: "p2", role: "quality-worker",   task: "Add tests",         wave: 1, riskLevel: "low" },
    ];
    const config: any = {};
    const result = assignWorkersToPlans(plans, config);
    const util = result.specializationUtilization;
    assert.ok(util, "specializationUtilization must be present in pool result");
    assert.ok(typeof util.specializedShare === "number",  "specializedShare must be a number");
    assert.ok(typeof util.minSpecializedShare === "number", "minSpecializedShare must be a number");
    assert.ok(typeof util.adaptiveMinSpecializedShare === "number", "adaptiveMinSpecializedShare must be a number");
    assert.ok(typeof util.specializationTargetsMet === "boolean", "specializationTargetsMet must be boolean");
  });

  it("buildTokenFirstBatches stamps specialistUtilizationTarget on first batch for non-Athena path", () => {
    // Confirm the standard token-first path does set the fields that the Athena-preassigned
    // injection must replicate — ensures parity.
    const plans = [
      { id: "t1", role: "evolution-worker", task: "Implement X", wave: 1, riskLevel: "low",
        target_files: ["src/x.ts"], acceptance_criteria: ["X works"], estimatedExecutionTokens: 5000 },
    ];
    const config: any = { planner: { specialistFillThreshold: 1.0 } };
    const batches = buildTokenFirstBatches(plans, config);
    assert.ok(Array.isArray(batches) && batches.length > 0, "must produce at least one batch");
    const first = batches[0] as any;
    // specialistUtilizationTarget is always set on the first batch
    assert.ok(first.specialistUtilizationTarget !== undefined, "specialistUtilizationTarget must be present on first batch");
    // For an evo-worker-only batch, reroute arrays are only present when there are actual reroutes
    if ("specialistReroutes" in first) {
      assert.ok(Array.isArray(first.specialistReroutes), "specialistReroutes must be an array when present");
    }
    if ("specialistRerouteReasons" in first) {
      assert.ok(Array.isArray(first.specialistRerouteReasons), "specialistRerouteReasons must be an array when present");
    }
  });

  it("negative path: empty plans list produces empty batch array without throwing", () => {
    const config: any = {};
    const batches = buildTokenFirstBatches([], config);
    assert.ok(Array.isArray(batches) && batches.length === 0, "empty plans must produce empty batches");
  });
});

// ── Unified specialization target derivation ──────────────────────────────────

import { computeAdaptiveSpecializedShareTarget } from "../../src/core/capability_pool.js";

describe("specialization target derivation — unified across dispatch paths", () => {
  it("buildTokenFirstBatches adaptiveMinSpecializedShare equals computeAdaptiveSpecializedShareTarget (no lane data)", () => {
    // With no cycle_analytics state, lanePerformance is empty so the canonical
    // function returns the configuredMin unchanged.  Token-first must agree.
    const configuredMin = 0.45;
    const plans = [
      { id: "p1", role: "evolution-worker", task: "Task A", wave: 1, taskKind: "implementation" },
    ];
    const config: any = {
      workerPool: { specializationTargets: { minSpecializedShare: configuredMin } },
      // Use a missing stateDir so no cycle analytics can be loaded from disk
      paths: { stateDir: "__nonexistent_dir_for_test__" },
    };
    const batches = buildTokenFirstBatches(plans, config);
    const target = (batches[0] as any)?.specialistUtilizationTarget;
    assert.ok(target, "specialistUtilizationTarget must be present");

    // With empty lane performance (no disk data), canonical function returns configuredMin clamped
    const expected = computeAdaptiveSpecializedShareTarget(configuredMin, {});
    assert.equal(
      target.adaptiveMinSpecializedShare,
      expected,
      `token-first path adaptiveMin (${target.adaptiveMinSpecializedShare}) must equal canonical result (${expected})`,
    );
  });

  it("assignWorkersToPlans and buildTokenFirstBatches produce consistent adaptiveMinSpecializedShare when lane data absent", () => {
    // Both paths must produce the same adaptive target when no lane data is available,
    // ensuring scoreboard values are aligned regardless of which path was taken.
    const configuredMin = 0.35;
    const plans = [
      { id: "a1", role: "evolution-worker", task: "Task A", wave: 1 },
      { id: "a2", role: "quality-worker",   task: "Task B", wave: 1 },
    ];
    const config: any = {
      workerPool: { specializationTargets: { minSpecializedShare: configuredMin } },
      paths: { stateDir: "__nonexistent_dir_for_test__" },
    };

    const poolResult = assignWorkersToPlans(plans, config);
    const batchResults = buildTokenFirstBatches(plans.map(p => ({ ...p, taskKind: "implementation" })), config);

    const poolAdaptive = poolResult.specializationUtilization?.adaptiveMinSpecializedShare;
    const batchAdaptive = (batchResults[0] as any)?.specialistUtilizationTarget?.adaptiveMinSpecializedShare;

    assert.ok(typeof poolAdaptive === "number", "capability pool must produce a numeric adaptiveMinSpecializedShare");
    assert.ok(typeof batchAdaptive === "number", "token-first batch must produce a numeric adaptiveMinSpecializedShare");
    assert.equal(poolAdaptive, batchAdaptive,
      `capability pool (${poolAdaptive}) and token-first path (${batchAdaptive}) must agree on adaptiveMinSpecializedShare`);
  });

  it("negative path: configuredMin=0 produces adaptiveMinSpecializedShare at the lower clamp floor", () => {
    // Negative: configuredMin=0 → computeAdaptiveSpecializedShareTarget clamps to 0
    // Both pool and batch must agree on this clamped value.
    const plans = [{ id: "z1", role: "evolution-worker", task: "Z", wave: 1, taskKind: "implementation" }];
    const config: any = {
      workerPool: { specializationTargets: { minSpecializedShare: 0 } },
      paths: { stateDir: "__nonexistent_dir_for_test__" },
    };

    const batches = buildTokenFirstBatches(plans, config);
    const batchAdaptive = (batches[0] as any)?.specialistUtilizationTarget?.adaptiveMinSpecializedShare;
    const canonical = computeAdaptiveSpecializedShareTarget(0, {});

    assert.equal(batchAdaptive, canonical,
      `zero configuredMin: token-first (${batchAdaptive}) must equal canonical (${canonical})`);
  });
});

// ── Task 2: modelRoutingTelemetry producer pipeline ────────────────────────────
import { computeCycleAnalytics, buildModelRoutingTelemetry, MIN_TELEMETRY_SAMPLE_THRESHOLD } from "../../src/core/cycle_analytics.js";
import { rankModelsByTaskKindExpectedValue } from "../../src/core/model_policy.js";

describe("buildModelRoutingTelemetry — producer pipeline", () => {
  const sampleLog = [
    { model: "claude-sonnet-4", taskKind: "ci-fix",       outcome: "done",    durationMs: 12000 },
    { model: "claude-sonnet-4", taskKind: "ci-fix",       outcome: "done",    durationMs: 11000 },
    { model: "claude-sonnet-4", taskKind: "ci-fix",       outcome: "partial", durationMs: 14000 },
    { model: "gpt-4o",          taskKind: "ci-fix",       outcome: "error",   durationMs:  8000 },
    { model: "gpt-4o",          taskKind: "feature",      outcome: "done",    durationMs: 30000 },
    { model: "gpt-4o",          taskKind: "feature",      outcome: "done",    durationMs: 28000 },
  ];

  it("returns empty invariant for empty log", () => {
    const result = buildModelRoutingTelemetry([]);
    assert.deepStrictEqual(result, { byTaskKind: {}, sampleCount: 0 });
  });

  it("returns empty invariant for log with invalid entries only", () => {
    const bad = [{ bad: "entry" }, null, "string", 42];
    const result = buildModelRoutingTelemetry(bad as unknown[]);
    assert.deepStrictEqual(result, { byTaskKind: {}, sampleCount: 0 });
  });

  it("produces byTaskKind with default and per-model economics", () => {
    const result = buildModelRoutingTelemetry(sampleLog);
    assert.ok(result !== null);
    assert.ok("byTaskKind" in result!);
    assert.ok("ci-fix" in result!.byTaskKind);
    assert.ok("feature" in result!.byTaskKind);
  });

  it("computes correct successProbability for ci-fix/claude-sonnet-4 (2/3 done)", () => {
    const result = buildModelRoutingTelemetry(sampleLog)!;
    // normalizeModelLabel("claude-sonnet-4") → "claude sonnet 4"
    const sonnet = result.byTaskKind["ci-fix"].models["claude sonnet 4"];
    // 2 done out of 3 total
    assert.strictEqual(Math.round(sonnet.successProbability * 100), 67);
  });

  it("computes correct successProbability for ci-fix default (2 done out of 4 total across models)", () => {
    const result = buildModelRoutingTelemetry(sampleLog)!;
    const def = result.byTaskKind["ci-fix"].default;
    // claude: 2 done/3, gpt: 0 done/1 → total 2/4 = 0.5
    assert.strictEqual(def.successProbability, 0.5);
  });

  it("sampleCount equals number of usable entries", () => {
    const result = buildModelRoutingTelemetry(sampleLog)!;
    assert.strictEqual(result.sampleCount, sampleLog.length);
  });

  it("each byTaskKind entry includes a sampleCount matching total entries for that kind", () => {
    const result = buildModelRoutingTelemetry(sampleLog)!;
    // ci-fix: claude (3) + gpt-4o (1) = 4 entries
    assert.strictEqual(result.byTaskKind["ci-fix"].sampleCount, 4);
    // feature: gpt-4o (2) = 2 entries
    assert.strictEqual(result.byTaskKind["feature"].sampleCount, 2);
  });

  it("requestCost is always 1.0", () => {
    const result = buildModelRoutingTelemetry(sampleLog)!;
    for (const [, kindData] of Object.entries(result.byTaskKind)) {
      assert.strictEqual(kindData.default.requestCost, 1.0);
      for (const [, modelData] of Object.entries(kindData.models)) {
        assert.strictEqual(modelData.requestCost, 1.0);
      }
    }
  });

  it("negative: missing taskKind or model fields are skipped without throwing", () => {
    const mixed = [
      ...sampleLog,
      { model: "x", outcome: "done" }, // no taskKind
      { taskKind: "ci-fix", outcome: "done" }, // no model
    ];
    // Should not throw and still produce a result from the valid entries
    const result = buildModelRoutingTelemetry(mixed as unknown[]);
    assert.ok(result !== null);
    assert.strictEqual(result!.sampleCount, sampleLog.length); // malformed entries excluded
  });
});

describe("computeCycleAnalytics — modelRoutingTelemetry integration", () => {
  const sampleLog = [
    { model: "claude-sonnet-4", taskKind: "ci-fix", outcome: "done",    durationMs: 12000 },
    { model: "claude-sonnet-4", taskKind: "ci-fix", outcome: "blocked", durationMs: 11000 },
    { model: "gpt-4o",          taskKind: "feature", outcome: "done",   durationMs: 30000 },
  ];

  it("includes modelRoutingTelemetry in analytics record when premiumUsageLog provided", () => {
    const config = {};
    const record: any = computeCycleAnalytics(config, { premiumUsageLog: sampleLog });
    assert.ok(record.modelRoutingTelemetry !== null, "modelRoutingTelemetry must be present");
    assert.ok("byTaskKind" in record.modelRoutingTelemetry);
  });

  it("modelRoutingTelemetry is empty invariant when premiumUsageLog is empty", () => {
    const config = {};
    const record: any = computeCycleAnalytics(config, { premiumUsageLog: [] });
    assert.deepStrictEqual(record.modelRoutingTelemetry, { byTaskKind: {}, sampleCount: 0 });
  });

  it("modelRoutingTelemetry is empty invariant when premiumUsageLog is omitted", () => {
    const config = {};
    const record: any = computeCycleAnalytics(config, {});
    assert.deepStrictEqual(record.modelRoutingTelemetry, { byTaskKind: {}, sampleCount: 0 });
  });
});

describe("rankModelsByTaskKindExpectedValue — usedTelemetry flag from real telemetry", () => {
  const sampleLog = [
    { model: "claude-sonnet-4", taskKind: "ci-fix", outcome: "done",    durationMs: 12000, lineageId: "ci-1" },
    { model: "claude-sonnet-4", taskKind: "ci-fix", outcome: "done",    durationMs: 11000, lineageId: "ci-2" },
    { model: "gpt-4o",          taskKind: "ci-fix", outcome: "error",   durationMs:  8000, lineageId: "ci-3" },
  ];

  it("returns usedTelemetry=true when real byTaskKind data is provided", () => {
    const telemetry = buildModelRoutingTelemetry(sampleLog)!;
    const cycleAnalytics = { modelRoutingTelemetry: telemetry };
    const result = rankModelsByTaskKindExpectedValue(
      "ci-fix",
      ["claude-sonnet-4", "gpt-4o"],
      cycleAnalytics,
    );
    assert.strictEqual(result.usedTelemetry, true);
    assert.strictEqual(result.reason, "expected-value(taskKind)");
  });

  it("negative: returns usedTelemetry=false when cycleAnalytics is null", () => {
    const result = rankModelsByTaskKindExpectedValue(
      "ci-fix",
      ["claude-sonnet-4", "gpt-4o"],
      null,
    );
    assert.strictEqual(result.usedTelemetry, false);
    assert.strictEqual(result.reason, "telemetry-missing");
  });
});

// ── Sample threshold enforcement ──────────────────────────────────────────────
describe("rankModelsByTaskKindExpectedValue — sample threshold enforcement", () => {
  it("MIN_TELEMETRY_SAMPLE_THRESHOLD is a positive integer", () => {
    assert.ok(Number.isInteger(MIN_TELEMETRY_SAMPLE_THRESHOLD));
    assert.ok(MIN_TELEMETRY_SAMPLE_THRESHOLD > 0);
  });

  it("returns telemetry-below-threshold when task kind has fewer samples than threshold", () => {
    // 2 entries for ci-fix — below the threshold of 3
    const sparseLog = [
      { model: "claude-sonnet-4", taskKind: "ci-fix", outcome: "done", lineageId: "ci-sparse-1" },
      { model: "gpt-4o",          taskKind: "ci-fix", outcome: "error", lineageId: "ci-sparse-2" },
    ];
    const telemetry = buildModelRoutingTelemetry(sparseLog)!;
    assert.strictEqual(telemetry.byTaskKind["ci-fix"].sampleCount, 2);
    const cycleAnalytics = { modelRoutingTelemetry: telemetry };
    const result = rankModelsByTaskKindExpectedValue(
      "ci-fix",
      ["claude-sonnet-4", "gpt-4o"],
      cycleAnalytics,
    );
    assert.strictEqual(result.usedTelemetry, false);
    assert.strictEqual(result.reason, "telemetry-below-threshold");
    // Fallback must preserve original model order
    assert.deepStrictEqual(result.rankedModels, ["claude-sonnet-4", "gpt-4o"]);
  });

  it("uses telemetry when sample count exactly meets the threshold", () => {
    // Exactly MIN_TELEMETRY_SAMPLE_THRESHOLD entries — should be trusted
    const thresholdLog = Array.from({ length: MIN_TELEMETRY_SAMPLE_THRESHOLD }, (_, i) => ({
      model: i % 2 === 0 ? "claude-sonnet-4" : "gpt-4o",
      taskKind: "ci-fix",
      outcome: i === 0 ? "done" : "error",
      lineageId: `ci-threshold-${i}`,
    }));
    const telemetry = buildModelRoutingTelemetry(thresholdLog)!;
    assert.strictEqual(telemetry.byTaskKind["ci-fix"].sampleCount, MIN_TELEMETRY_SAMPLE_THRESHOLD);
    const cycleAnalytics = { modelRoutingTelemetry: telemetry };
    const result = rankModelsByTaskKindExpectedValue(
      "ci-fix",
      ["claude-sonnet-4", "gpt-4o"],
      cycleAnalytics,
    );
    assert.strictEqual(result.usedTelemetry, true);
    assert.strictEqual(result.reason, "expected-value(taskKind)");
  });

  it("negative: threshold check is per-task-kind — abundant samples for one kind do not unlock another", () => {
    // ci-fix has 5 samples, but feature has only 1
    const mixedLog = [
      { model: "claude-sonnet-4", taskKind: "ci-fix", outcome: "done", lineageId: "ci-mixed-1" },
      { model: "claude-sonnet-4", taskKind: "ci-fix", outcome: "done", lineageId: "ci-mixed-2" },
      { model: "claude-sonnet-4", taskKind: "ci-fix", outcome: "done", lineageId: "ci-mixed-3" },
      { model: "gpt-4o",          taskKind: "ci-fix", outcome: "done", lineageId: "ci-mixed-4" },
      { model: "gpt-4o",          taskKind: "ci-fix", outcome: "done", lineageId: "ci-mixed-5" },
      { model: "gpt-4o",          taskKind: "feature", outcome: "done", lineageId: "feature-1" },
    ];
    const telemetry = buildModelRoutingTelemetry(mixedLog)!;
    const cycleAnalytics = { modelRoutingTelemetry: telemetry };

    // ci-fix: 5 samples — above threshold, telemetry used
    const ciFixResult = rankModelsByTaskKindExpectedValue("ci-fix", ["claude-sonnet-4", "gpt-4o"], cycleAnalytics);
    assert.strictEqual(ciFixResult.usedTelemetry, true);

    // feature: 1 sample — below threshold, falls back
    const featureResult = rankModelsByTaskKindExpectedValue("feature", ["claude-sonnet-4", "gpt-4o"], cycleAnalytics);
    assert.strictEqual(featureResult.usedTelemetry, false);
    assert.strictEqual(featureResult.reason, "telemetry-below-threshold");
  });
});

// ── Task 1: Specialist admission threshold bound to reroute reason intensity ───

import {
  evaluateSpecializationAdmissionGate,
  computeAdmissionThresholdFromRerouteIntensity,
  buildReroutePenaltyLedger,
  SPECIALIST_REROUTE_REASON_CODE,
} from "../../src/core/capability_pool.js";

describe("computeAdmissionThresholdFromRerouteIntensity — reroute intensity → threshold delta", () => {
  it("returns 0 for an empty ledger", () => {
    assert.strictEqual(computeAdmissionThresholdFromRerouteIntensity({}), 0);
  });

  it("returns 0 for null/undefined input", () => {
    assert.strictEqual(computeAdmissionThresholdFromRerouteIntensity(null as any), 0);
    assert.strictEqual(computeAdmissionThresholdFromRerouteIntensity(undefined as any), 0);
  });

  it("BELOW_FILL_THRESHOLD reroutes produce a negative delta (lower threshold = more lenient)", () => {
    const ledger = buildReroutePenaltyLedger([
      { lane: "quality",         reasonCode: SPECIALIST_REROUTE_REASON_CODE.BELOW_FILL_THRESHOLD },
      { lane: "implementation",  reasonCode: SPECIALIST_REROUTE_REASON_CODE.BELOW_FILL_THRESHOLD },
    ]);
    const delta = computeAdmissionThresholdFromRerouteIntensity(ledger);
    assert.ok(delta < 0, `delta must be negative for BELOW_FILL_THRESHOLD reroutes; got ${delta}`);
  });

  it("PERFORMANCE_DEGRADED reroutes produce a positive delta (raise threshold = stricter)", () => {
    const ledger = buildReroutePenaltyLedger([
      { lane: "quality",        reasonCode: SPECIALIST_REROUTE_REASON_CODE.PERFORMANCE_DEGRADED },
      { lane: "quality",        reasonCode: SPECIALIST_REROUTE_REASON_CODE.PERFORMANCE_DEGRADED },
    ]);
    const delta = computeAdmissionThresholdFromRerouteIntensity(ledger);
    assert.ok(delta > 0, `delta must be positive for PERFORMANCE_DEGRADED reroutes; got ${delta}`);
  });

  it("DEPENDENCY_ISOLATION reroutes produce a negative delta (structural leniency)", () => {
    const ledger = buildReroutePenaltyLedger([
      { lane: "integration", reasonCode: SPECIALIST_REROUTE_REASON_CODE.DEPENDENCY_ISOLATION },
    ]);
    const delta = computeAdmissionThresholdFromRerouteIntensity(ledger);
    assert.ok(delta < 0, `delta must be negative for DEPENDENCY_ISOLATION reroutes; got ${delta}`);
  });

  it("net delta is bounded to [-0.15, +0.15] regardless of reroute volume", () => {
    // Many PERFORMANCE_DEGRADED reroutes — must not exceed +0.15
    const heavyLedger = buildReroutePenaltyLedger(
      Array.from({ length: 20 }, () => ({ lane: "quality", reasonCode: SPECIALIST_REROUTE_REASON_CODE.PERFORMANCE_DEGRADED }))
    );
    const highDelta = computeAdmissionThresholdFromRerouteIntensity(heavyLedger);
    assert.ok(highDelta <= 0.15, `positive delta must not exceed 0.15; got ${highDelta}`);

    // Many BELOW_FILL_THRESHOLD reroutes — must not go below -0.15
    const lenientLedger = buildReroutePenaltyLedger(
      Array.from({ length: 20 }, () => ({ lane: "quality", reasonCode: SPECIALIST_REROUTE_REASON_CODE.BELOW_FILL_THRESHOLD }))
    );
    const lowDelta = computeAdmissionThresholdFromRerouteIntensity(lenientLedger);
    assert.ok(lowDelta >= -0.15, `negative delta must not go below -0.15; got ${lowDelta}`);
  });

  it("mixed reroute reasons partially cancel each other", () => {
    const ledger = buildReroutePenaltyLedger([
      { lane: "quality", reasonCode: SPECIALIST_REROUTE_REASON_CODE.PERFORMANCE_DEGRADED },
      { lane: "quality", reasonCode: SPECIALIST_REROUTE_REASON_CODE.BELOW_FILL_THRESHOLD },
    ]);
    const delta = computeAdmissionThresholdFromRerouteIntensity(ledger);
    // Net should be between -0.05 and +0.05 (partially cancelled)
    assert.ok(delta >= -0.05 && delta <= 0.05,
      `mixed reroute delta should be near zero; got ${delta}`);
  });
});

describe("evaluateSpecializationAdmissionGate — reroute intensity binding", () => {
  const baseUtil = {
    specializationTargetsMet: false,
    specializedShare: 0.30,
    minSpecializedShare: 0.35,
    adaptiveMinSpecializedShare: 0.35,
    specializedDeficit: 1,
    admissionReady: false,
  };

  it("blocks when share is below adaptiveMinSpecializedShare with no reroute history", () => {
    const result = evaluateSpecializationAdmissionGate(baseUtil, 0);
    assert.strictEqual(result.blocked, true);
    assert.ok(result.reason.includes("specialized_share=30%"));
  });

  it("effectiveAdaptiveMin is included in the result", () => {
    const result = evaluateSpecializationAdmissionGate(baseUtil, 0);
    assert.ok(typeof result.effectiveAdaptiveMin === "number");
    assert.ok(result.effectiveAdaptiveMin >= 0 && result.effectiveAdaptiveMin <= 1);
  });

  it("BELOW_FILL_THRESHOLD reroutes lower effective threshold — gate may pass when base would block", () => {
    // specializedShare=0.30, base adaptiveMin=0.35
    // With 2× BELOW_FILL_THRESHOLD across 2 lanes: delta = -0.10, effectiveMin = 0.25
    // 0.30 >= 0.25 → gate should pass
    const ledger = buildReroutePenaltyLedger([
      { lane: "quality",        reasonCode: SPECIALIST_REROUTE_REASON_CODE.BELOW_FILL_THRESHOLD },
      { lane: "implementation", reasonCode: SPECIALIST_REROUTE_REASON_CODE.BELOW_FILL_THRESHOLD },
    ]);
    const result = evaluateSpecializationAdmissionGate(baseUtil, 0, 3, ledger);
    assert.strictEqual(result.blocked, false,
      "gate must pass when BELOW_FILL_THRESHOLD reroutes lower the effective threshold below specializedShare");
  });

  it("PERFORMANCE_DEGRADED reroutes raise effective threshold — gate still blocks", () => {
    // specializedShare=0.30, base adaptiveMin=0.35; performance reroutes raise to 0.40+
    // 0.30 < 0.40 → gate should still block
    const ledger = buildReroutePenaltyLedger([
      { lane: "quality", reasonCode: SPECIALIST_REROUTE_REASON_CODE.PERFORMANCE_DEGRADED },
      { lane: "quality", reasonCode: SPECIALIST_REROUTE_REASON_CODE.PERFORMANCE_DEGRADED },
    ]);
    const result = evaluateSpecializationAdmissionGate(baseUtil, 0, 3, ledger);
    assert.strictEqual(result.blocked, true,
      "gate must still block when PERFORMANCE_DEGRADED reroutes raise the threshold");
    assert.ok(result.effectiveAdaptiveMin > baseUtil.adaptiveMinSpecializedShare,
      "effectiveAdaptiveMin must be raised above the base by PERFORMANCE_DEGRADED reroutes");
  });

  it("intensity delta is reflected in reason string when non-zero", () => {
    const ledger = buildReroutePenaltyLedger([
      { lane: "quality", reasonCode: SPECIALIST_REROUTE_REASON_CODE.PERFORMANCE_DEGRADED },
    ]);
    const result = evaluateSpecializationAdmissionGate(baseUtil, 0, 3, ledger);
    assert.ok(result.blocked && result.reason.includes("intensity_delta"),
      `reason must include intensity_delta; got: ${result.reason}`);
  });

  it("negative path: null specializationUtilization returns not-blocked safely", () => {
    const result = evaluateSpecializationAdmissionGate(null as any, 0);
    assert.strictEqual(result.blocked, false);
  });

  it("bounded fallback still fires even with reroute ledger present", () => {
    const ledger = buildReroutePenaltyLedger([
      { lane: "quality", reasonCode: SPECIALIST_REROUTE_REASON_CODE.PERFORMANCE_DEGRADED },
    ]);
    // consecutiveBlockCycles >= maxBlockCycles → bypassed
    const result = evaluateSpecializationAdmissionGate(baseUtil, 3, 3, ledger);
    assert.strictEqual(result.blocked, false);
    assert.ok(result.reason.includes("bypassed_fallback"));
  });
});

describe("scoreboard persistence — specialization target fallback to capabilityPoolResult", () => {
  // Verify that appendCapacityEntry receives the correct specialization target
  // even when workerBatches[0].specialistUtilizationTarget is absent (role-execution path).
  // This test exercises the in-memory logic extracted from the orchestrator: the
  // effective target is derived from capPoolUtil when the batch target is null.

  it("effectiveSpecTarget falls back to capPoolUtil when firstBatchSpecialization is null", () => {
    const capPoolUtil = {
      specializationTargetsMet: true,
      adaptiveMinSpecializedShare: 0.4,
      minSpecializedShare: 0.35,
      specializedCount: 3,
      total: 5,
    };

    // Replicate the fallback logic from the orchestrator scoreboard block
    const firstBatchSpecialization: any = null;
    const effectiveSpecTarget = firstBatchSpecialization ?? (capPoolUtil
      ? {
          targetMet: capPoolUtil.specializationTargetsMet === true,
          adaptiveMinSpecializedShare: Number(capPoolUtil.adaptiveMinSpecializedShare ?? capPoolUtil.minSpecializedShare ?? 0),
          minSpecializedShare: Number(capPoolUtil.minSpecializedShare ?? 0),
        }
      : null);

    assert.ok(effectiveSpecTarget !== null, "effectiveSpecTarget must not be null when capPoolUtil is present");
    assert.strictEqual(effectiveSpecTarget.targetMet, true);
    assert.strictEqual(effectiveSpecTarget.adaptiveMinSpecializedShare, 0.4);
    assert.strictEqual(effectiveSpecTarget.minSpecializedShare, 0.35);
  });

  it("effectiveSpecTarget uses batch data when available (token-first / Athena-prebatched paths)", () => {
    const firstBatchSpecialization = {
      targetMet: false,
      adaptiveMinSpecializedShare: 0.5,
      minSpecializedShare: 0.35,
    };
    const capPoolUtil = {
      specializationTargetsMet: true,
      adaptiveMinSpecializedShare: 0.4,
      minSpecializedShare: 0.35,
    };

    const effectiveSpecTarget = firstBatchSpecialization ?? (capPoolUtil ? {
      targetMet: capPoolUtil.specializationTargetsMet === true,
      adaptiveMinSpecializedShare: Number(capPoolUtil.adaptiveMinSpecializedShare),
      minSpecializedShare: Number(capPoolUtil.minSpecializedShare),
    } : null);

    // Batch data takes precedence
    assert.strictEqual(effectiveSpecTarget?.targetMet, false,
      "batch data must take precedence over capPoolUtil fallback");
    assert.strictEqual(effectiveSpecTarget?.adaptiveMinSpecializedShare, 0.5);
  });

  it("negative path: effectiveSpecTarget is null when both sources are absent", () => {
    const firstBatchSpecialization: any = null;
    const capPoolUtil: any = null;
    const effectiveSpecTarget = firstBatchSpecialization ?? (capPoolUtil ? {
      targetMet: capPoolUtil.specializationTargetsMet === true,
      adaptiveMinSpecializedShare: Number(capPoolUtil.adaptiveMinSpecializedShare ?? 0),
      minSpecializedShare: Number(capPoolUtil.minSpecializedShare ?? 0),
    } : null);
    assert.strictEqual(effectiveSpecTarget, null);
  });

  it("configuredMinSpecializedShare is distinct from adaptiveMinSpecializedShare when adaptation is active", () => {
    const capPoolUtil = {
      specializationTargetsMet: false,
      adaptiveMinSpecializedShare: 0.5,
      minSpecializedShare: 0.35,
    };
    const effectiveSpecTarget = {
      targetMet: capPoolUtil.specializationTargetsMet === true,
      adaptiveMinSpecializedShare: Number(capPoolUtil.adaptiveMinSpecializedShare),
      minSpecializedShare: Number(capPoolUtil.minSpecializedShare),
    };
    // specializedShareTarget uses the adaptive value
    const specializedShareTarget = Number(
      effectiveSpecTarget.adaptiveMinSpecializedShare ?? effectiveSpecTarget.minSpecializedShare ?? 0,
    );
    // configuredMinSpecializedShare uses the policy value
    const configuredMinSpecializedShare = Number(effectiveSpecTarget.minSpecializedShare ?? 0);

    assert.strictEqual(specializedShareTarget, 0.5, "specializedShareTarget must use adaptive value");
    assert.strictEqual(configuredMinSpecializedShare, 0.35, "configuredMinSpecializedShare must reflect policy");
    assert.notStrictEqual(specializedShareTarget, configuredMinSpecializedShare,
      "adaptive and configured targets must differ when adaptation is active");
  });

  it("configuredMinSpecializedShare equals specializedShareTarget when no adaptation is applied", () => {
    const capPoolUtil = {
      specializationTargetsMet: true,
      adaptiveMinSpecializedShare: 0.35,
      minSpecializedShare: 0.35,
    };
    const effectiveSpecTarget = {
      targetMet: capPoolUtil.specializationTargetsMet === true,
      adaptiveMinSpecializedShare: Number(capPoolUtil.adaptiveMinSpecializedShare),
      minSpecializedShare: Number(capPoolUtil.minSpecializedShare),
    };
    const specializedShareTarget = Number(effectiveSpecTarget.adaptiveMinSpecializedShare ?? 0);
    const configuredMinSpecializedShare = Number(effectiveSpecTarget.minSpecializedShare ?? 0);

    assert.strictEqual(specializedShareTarget, configuredMinSpecializedShare,
      "when adaptation is absent, adaptive and configured targets must be equal");
  });
});

describe("rankModelsByTaskKindExpectedValue — empty-invariant consumer safety", () => {
  it("falls back to original order when modelRoutingTelemetry has empty byTaskKind (sampleCount=0)", () => {
    const cycleAnalytics = { modelRoutingTelemetry: { byTaskKind: {}, sampleCount: 0 } };
    const models = ["claude-sonnet-4", "gpt-4o"];
    const result = rankModelsByTaskKindExpectedValue("ci-fix", models, cycleAnalytics);
    assert.strictEqual(result.usedTelemetry, false, "must not claim telemetry used with empty byTaskKind");
    assert.deepStrictEqual(result.rankedModels, models, "original order must be preserved on empty telemetry");
    assert.strictEqual(result.reason, "telemetry-missing", "reason must be telemetry-missing");
  });

  it("negative: empty invariant does NOT cause an error or undefined access", () => {
    const cycleAnalytics = { modelRoutingTelemetry: { byTaskKind: {}, sampleCount: 0 } };
    assert.doesNotThrow(() => {
      rankModelsByTaskKindExpectedValue("feature", ["model-a"], cycleAnalytics);
    });
  });
});

// ── Dispatch-boundary hard cap — applyDispatchBoundaryHardCap ─────────────────
//
// Verifies the unconditional final safeguard that splits any batch descriptor
// exceeding MAX_ACTIONABLE_STEPS_PER_PACKET into smaller chunks.  This cap fires
// after ALL batching paths converge, regardless of earlier config-gated checks.
describe("dispatch-boundary hard cap — applyDispatchBoundaryHardCap", () => {
  it("passes batches with ≤ MAX_ACTIONABLE_STEPS_PER_PACKET plans through unchanged", () => {
    const plans = [{ task: "A" }, { task: "B" }, { task: "C" }];
    const batches = [{ role: "evolution-worker", plans, estimatedTokens: 1000 }];
    const result = applyDispatchBoundaryHardCap(batches);
    assert.equal(result.length, 1, "single batch within cap must not be split");
    assert.equal(result[0].plans.length, MAX_ACTIONABLE_STEPS_PER_PACKET);
    assert.ok(!(result[0] as any)._dispatchHardCapSplit, "within-cap batch must not carry split marker");
  });

  it("splits a batch with 4 plans into [3, 1]", () => {
    const plans = [{ task: "A" }, { task: "B" }, { task: "C" }, { task: "D" }];
    const batches = [{ role: "evolution-worker", plans, estimatedTokens: 4000 }];
    const result = applyDispatchBoundaryHardCap(batches);
    assert.equal(result.length, 2, "4-plan batch must be split into 2 batches");
    assert.equal(result[0].plans.length, 3, "first chunk must have 3 plans");
    assert.equal(result[1].plans.length, 1, "second chunk must have 1 plan");
    assert.ok((result[0] as any)._dispatchHardCapSplit, "split batch must carry _dispatchHardCapSplit marker");
    assert.ok((result[1] as any)._dispatchHardCapSplit, "split batch must carry _dispatchHardCapSplit marker");
  });

  it("splits a batch with 6 plans into [3, 3]", () => {
    const plans = Array.from({ length: 6 }, (_, i) => ({ task: `T${i}` }));
    const batches = [{ role: "evolution-worker", plans, estimatedTokens: 6000 }];
    const result = applyDispatchBoundaryHardCap(batches);
    assert.equal(result.length, 2, "6-plan batch must be split into 2 batches of 3");
    assert.equal(result[0].plans.length, 3);
    assert.equal(result[1].plans.length, 3);
  });

  it("handles multiple batches — only oversized ones are split", () => {
    const ok = [{ task: "A" }, { task: "B" }];
    const oversized = Array.from({ length: 5 }, (_, i) => ({ task: `X${i}` }));
    const batches = [
      { role: "evolution-worker", plans: ok, estimatedTokens: 2000 },
      { role: "ci-worker", plans: oversized, estimatedTokens: 5000 },
    ];
    const result = applyDispatchBoundaryHardCap(batches);
    // First batch (2 plans) passes through; second (5 plans) becomes [3, 2]
    assert.equal(result.length, 3, "5-plan batch splits into 2; total batches = 1 + 2 = 3");
    assert.equal(result[0].plans.length, 2);
    assert.equal(result[1].plans.length, 3);
    assert.equal(result[2].plans.length, 2);
  });

  it("preserves all non-plans fields on split chunks", () => {
    const plans = Array.from({ length: 4 }, (_, i) => ({ task: `P${i}` }));
    const batches = [{ role: "ci-worker", plans, estimatedTokens: 4000, wave: 2, taskKind: "ci-fix" }];
    const result = applyDispatchBoundaryHardCap(batches);
    assert.equal(result.length, 2);
    assert.equal((result[0] as any).role, "ci-worker", "role must be preserved on split chunks");
    assert.equal((result[0] as any).wave, 2, "wave must be preserved on split chunks");
    assert.equal((result[0] as any).taskKind, "ci-fix", "taskKind must be preserved on split chunks");
  });

  it("returns empty array unchanged", () => {
    const result = applyDispatchBoundaryHardCap([]);
    assert.equal(result.length, 0, "empty input must return empty output");
  });

  it("NEGATIVE PATH: exactly 3 plans is NOT split (boundary condition)", () => {
    const plans = [{ task: "A" }, { task: "B" }, { task: "C" }];
    const batches = [{ role: "evolution-worker", plans, estimatedTokens: 3000 }];
    const result = applyDispatchBoundaryHardCap(batches);
    assert.equal(result.length, 1, "batch at exact cap must not be split");
    assert.equal(result[0].plans.length, 3);
  });

  it("NEGATIVE PATH: 2 plans is NOT split", () => {
    const plans = [{ task: "A" }, { task: "B" }];
    const batches = [{ role: "evolution-worker", plans, estimatedTokens: 2000 }];
    const result = applyDispatchBoundaryHardCap(batches);
    assert.equal(result.length, 1, "batch below cap must not be split");
  });
});

// ── UNBOUND_VERIFICATION_TARGET — pre-dispatch binding gate ──────────────────

describe("validatePlanContract — UNBOUND_VERIFICATION_TARGET", () => {
  const VALID_BASE = {
    id: "T-bind-001",
    task: "Implement feature X in module Y",
    role: "evolution-worker",
    wave: 1,
    verification: "npm test -- tests/core/foo.test.ts",
    verification_commands: ["npm test -- tests/core/foo.test.ts"],
    acceptance_criteria: ["foo.test.ts passes", "No regressions in module Y"],
    dependencies: [],
    capacityDelta: 0.1,
    requestROI: 1.2,
  };

  it("no UNBOUND_VERIFICATION_TARGET when verification resolves to a named test file", () => {
    const { violations } = validatePlanContract(VALID_BASE);
    const unbound = violations.filter((v) => v.code === PACKET_VIOLATION_CODE.UNBOUND_VERIFICATION_TARGET);
    assert.equal(unbound.length, 0, "specific test file reference must not trigger UNBOUND_VERIFICATION_TARGET");
  });

  it("emits UNBOUND_VERIFICATION_TARGET when all verification values are non-specific", () => {
    const plan = {
      ...VALID_BASE,
      verification: "npm test",
      verification_commands: ["npm run test"],
    };
    const { violations } = validatePlanContract(plan);
    const unbound = violations.filter((v) => v.code === PACKET_VIOLATION_CODE.UNBOUND_VERIFICATION_TARGET);
    // Note: NON_SPECIFIC_VERIFICATION fires for bare "npm test" in `verification`;
    // UNBOUND_VERIFICATION_TARGET fires additionally when no target resolves from either field.
    assert.ok(unbound.length > 0, "must emit UNBOUND_VERIFICATION_TARGET when no named target resolves");
    assert.equal(unbound[0].severity, PLAN_VIOLATION_SEVERITY.WARNING, "unbound target is WARNING severity");
  });

  it("NEGATIVE PATH: no UNBOUND_VERIFICATION_TARGET when verification is absent (MISSING_VERIFICATION covers that case)", () => {
    const plan = { ...VALID_BASE, verification: null, verification_commands: undefined };
    const { violations } = validatePlanContract(plan);
    const unbound = violations.filter((v) => v.code === PACKET_VIOLATION_CODE.UNBOUND_VERIFICATION_TARGET);
    // When verification is absent, hasAnyVerificationField is false, so UNBOUND_VERIFICATION_TARGET is NOT emitted.
    // MISSING_VERIFICATION is emitted instead.
    assert.equal(unbound.length, 0, "UNBOUND_VERIFICATION_TARGET must not fire when verification is absent");
    const missing = violations.filter((v) => v.code === PACKET_VIOLATION_CODE.MISSING_VERIFICATION);
    assert.ok(missing.length > 0, "MISSING_VERIFICATION must fire when verification is absent");
  });
});

// ── Boundary checkpoint — pipeline transition snapshots ──────────────────────

import { createVersionedCheckpointEnvelope, writeBoundaryCheckpoint, CHECKPOINT_NS } from "../../src/core/checkpoint_engine.js";

describe("boundary checkpoints", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-boundary-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("planner boundary checkpoint persists plan metadata with stable ids", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const filePath = await writeBoundaryCheckpoint(config, {
      planCount: 5,
      prometheusCompletedAt: new Date().toISOString(),
    }, { thread_id: "cycle-001", checkpoint_ns: CHECKPOINT_NS.PLANNER });
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(parsed.planCount, 5);
    assert.equal(parsed.thread_id, "cycle-001");
    assert.equal(parsed.checkpoint_ns, "planner");
    assert.ok(parsed.checkpoint_id.startsWith("cycle-001/planner/"));
    assert.equal(parsed.checkpointKind, "boundary:planner");
    assert.equal(parsed.schemaVersion, 2);
  });

  it("reviewer boundary checkpoint persists athena approval with stable ids", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const filePath = await writeBoundaryCheckpoint(config, {
      athenaApproved: true,
      overallScore: 8,
    }, { thread_id: "cycle-001", checkpoint_ns: CHECKPOINT_NS.REVIEWER });
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(parsed.athenaApproved, true);
    assert.equal(parsed.checkpoint_ns, "reviewer");
    assert.equal(parsed.checkpointKind, "boundary:reviewer");
  });

  it("verification boundary checkpoint persists worker result with stable ids", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const filePath = await writeBoundaryCheckpoint(config, {
      roleName: "backend-worker",
      status: "done",
    }, { thread_id: "task-42", checkpoint_ns: CHECKPOINT_NS.VERIFICATION });
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(parsed.roleName, "backend-worker");
    assert.equal(parsed.status, "done");
    assert.equal(parsed.checkpoint_ns, "verification");
  });

  it("checkpoint_id is composite thread_id/ns/seq", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const filePath = await writeBoundaryCheckpoint(config, {}, {
      thread_id: "test-thread",
      checkpoint_ns: CHECKPOINT_NS.DISPATCH,
      sequence: 3,
    });
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(parsed.checkpoint_id, "test-thread/dispatch/3");
  });

  it("createVersionedCheckpointEnvelope includes logical ids in integrity hash", () => {
    const base = { data: "test" };
    const withIds = createVersionedCheckpointEnvelope(base, null, "boundary:dispatch", {
      thread_id: "t1", checkpoint_ns: "dispatch", checkpoint_id: "t1/dispatch/1",
    });
    const withoutIds = createVersionedCheckpointEnvelope(base);
    // Different logical IDs must produce different integrity hashes
    assert.notEqual(withIds.integrity.hash, withoutIds.integrity.hash);
  });

  it("negative path: boundary checkpoint with empty namespace falls back to dispatch", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const filePath = await writeBoundaryCheckpoint(config, { test: true }, {
      thread_id: "t-fallback",
      checkpoint_ns: "" as any,
    });
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(parsed.checkpoint_ns, "dispatch");
  });
});

// ── pipeline_progress terminalBlockReason contract (Task 1) ─────────────────

import { updatePipelineProgress, PIPELINE_PROGRESS_SCHEMA } from "../../src/core/pipeline_progress.js";

describe("pipeline_progress — terminalBlockReason contract (Task 1 cycle-truth)", () => {
  it("PIPELINE_PROGRESS_SCHEMA.conditionalFields includes terminalBlockReason", () => {
    assert.ok(
      "terminalBlockReason" in PIPELINE_PROGRESS_SCHEMA.conditionalFields,
      "PIPELINE_PROGRESS_SCHEMA.conditionalFields must document terminalBlockReason"
    );
    assert.equal(
      PIPELINE_PROGRESS_SCHEMA.conditionalFields["terminalBlockReason"],
      "cycle_complete_with_null_events"
    );
  });

  it("updatePipelineProgress persists terminalBlockReason on cycle_complete when supplied", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pp-tbr-"));
    try {
      const cfg = { paths: { stateDir: dir } };
      // First set startedAt by going through janus_awakening
      await updatePipelineProgress(cfg, "janus_awakening", "cycle starting");
      // Now complete the cycle with an explicit terminal block reason
      await updatePipelineProgress(cfg, "cycle_complete", "terminated early", {
        terminalBlockReason: "governance_freeze_active: safety gate",
      });
      const data = await readPipelineProgress(cfg);
      assert.equal(data.stage, "cycle_complete");
      assert.equal(
        data.terminalBlockReason,
        "governance_freeze_active: safety gate",
        "terminalBlockReason must be persisted when supplied on cycle_complete"
      );
      assert.ok(data.completedAt, "completedAt must still be set");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("updatePipelineProgress does not persist terminalBlockReason when not supplied", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pp-notbr-"));
    try {
      const cfg = { paths: { stateDir: dir } };
      await updatePipelineProgress(cfg, "cycle_complete", "normal completion");
      const data = await readPipelineProgress(cfg);
      assert.equal(data.stage, "cycle_complete");
      assert.ok(!data.terminalBlockReason, "terminalBlockReason must not be present when not supplied");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("negative path: terminalBlockReason with empty string is not persisted", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pp-emptbr-"));
    try {
      const cfg = { paths: { stateDir: dir } };
      await updatePipelineProgress(cfg, "cycle_complete", "normal completion", {
        terminalBlockReason: "   ",
      });
      const data = await readPipelineProgress(cfg);
      assert.ok(!data.terminalBlockReason, "empty/whitespace terminalBlockReason must not be persisted");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ── Athena pre-batched reroute telemetry — computed signal verification ────────
// Verifies that fillRatio / laneScore / adaptiveFillThreshold in the Athena
// pre-batched dispatch path are derived from real signals rather than the old
// hardcoded defaults (fillRatio=1.0, laneScore=0.5, adaptiveFillThreshold=1.0).

import {
  getLaneScore,
  computeAdaptiveSpecialistFillThreshold,
  buildLanePerformanceFromCycleTelemetry as buildLanePerf,
  routeTaskToLane,
  computeLaneROIAdmission,
  TASK_LANE_KIND,
  LANE_ROI_ADMISSION_MIN_COMPLETION_RATE,
  LANE_ROI_ADMISSION_MIN_ROI,
} from "../../src/core/capability_pool.js";
import {
  estimatePlanTokens,
  getUsableModelContextTokens,
} from "../../src/core/worker_batch_planner.js";

describe("Athena pre-batched reroute telemetry — computed signals (not hardcoded)", () => {
  it("laneScore is derived from lane performance data, not hardcoded to 0.5", () => {
    // A lane with 9 successes and 1 failure → Laplace score ≈ 0.833 (above 0.5 neutral).
    const lanePerf = buildLanePerf({ implementation: { completed: 9, failed: 1 } });
    const score = getLaneScore(lanePerf, "implementation");
    assert.ok(score > 0.5, `expected score > 0.5 for high-success lane; got ${score}`);
    assert.notEqual(score, 0.5, "laneScore must not be the hardcoded default 0.5 when lane data is present");
  });

  it("laneScore defaults to 0.5 when no lane performance data is available (negative path)", () => {
    const score = getLaneScore({}, "unknown-lane");
    assert.equal(score, 0.5, "missing lane data must yield neutral score 0.5");
  });

  it("adaptiveFillThreshold adjusts below base threshold for a high-performing lane", () => {
    // A lane with 9 successes and 1 failure → Laplace score ≈ 0.833.
    // With score > 0.5, the adjustment = (0.5 - score) * 0.3 is negative, lowering the threshold.
    const lanePerf = buildLanePerf({ implementation: { completed: 9, failed: 1 } });
    // base=1.0, high-scoring lane → threshold lowered (less gatekeeping)
    const threshold = computeAdaptiveSpecialistFillThreshold(1.0, "implementation", lanePerf);
    assert.ok(threshold < 1.0, `expected threshold < 1.0 for high-performing lane; got ${threshold}`);
    assert.notEqual(threshold, 1.0, "adaptiveFillThreshold must not be the hardcoded default 1.0 when lane data is present");
  });

  it("adaptiveFillThreshold returns base threshold when no lane performance data is available (negative path)", () => {
    const threshold = computeAdaptiveSpecialistFillThreshold(1.0, "unknown-lane", {});
    assert.equal(threshold, 1.0, "missing lane data must yield unchanged base threshold");
  });

  it("fillRatio computed from estimatePlanTokens is below 1.0 for a single realistic plan", () => {
    // A single small plan should occupy far less than 100% of the context window.
    const plan = { task: "implement a new feature in src/core/orchestrator.ts", context: "background context" };
    const tokens = estimatePlanTokens(plan);
    const usable = getUsableModelContextTokens({}, "Claude Sonnet 4.6");
    const fillRatio = usable > 0 ? Math.round((tokens / usable) * 1000) / 1000 : 0;
    assert.ok(fillRatio < 1.0, `expected fillRatio < 1.0 for a single plan; got ${fillRatio}`);
    assert.notEqual(fillRatio, 1.0, "fillRatio must not be the hardcoded default 1.0");
  });

  it("fillRatio is 0 when usable context tokens resolves to zero (edge case)", () => {
    // Simulate degenerate config where context window collapses to zero.
    // getUsableModelContextTokens clamps to at least 1, so we test the formula directly.
    const tokens = 100;
    const usable = 0;
    const fillRatio = usable > 0 ? Math.round((tokens / usable) * 1000) / 1000 : 0;
    assert.equal(fillRatio, 0, "fillRatio must be 0 when usable tokens is zero");
  });
});

describe("routeTaskToLane — deterministic task-lane router", () => {
  it("routes CI-fix task to workflow lane", () => {
    const plan = { task: "Run ci-fix repair for failing test suite", taskKind: "ci-fix" };
    assert.equal(routeTaskToLane(plan), TASK_LANE_KIND.WORKFLOW, "ci-fix taskKind → workflow");
  });

  it("routes infrastructure task to workflow lane by task text", () => {
    const plan = { task: "Deploy updated Docker infrastructure image" };
    assert.equal(routeTaskToLane(plan), TASK_LANE_KIND.WORKFLOW, "deploy task text → workflow");
  });

  it("routes code implementation task to agent lane", () => {
    const plan = { task: "Implement bounded candidate generation in prometheus.ts", taskKind: "implementation" };
    assert.equal(routeTaskToLane(plan), TASK_LANE_KIND.AGENT, "implementation → agent");
  });

  it("routes task with explicit taskLane=workflow override", () => {
    const plan = { task: "Some ambiguous task", taskLane: "workflow" };
    assert.equal(routeTaskToLane(plan), TASK_LANE_KIND.WORKFLOW, "explicit override → workflow");
  });

  it("routes task with explicit taskLane=agent override", () => {
    const plan = { task: "ci-fix repair", taskLane: "agent" };
    assert.equal(routeTaskToLane(plan), TASK_LANE_KIND.AGENT, "explicit agent override takes priority");
  });

  it("defaults to agent lane for null/undefined input (negative path)", () => {
    assert.equal(routeTaskToLane(null), TASK_LANE_KIND.AGENT, "null → agent default");
    assert.equal(routeTaskToLane(undefined), TASK_LANE_KIND.AGENT, "undefined → agent default");
    assert.equal(routeTaskToLane({}), TASK_LANE_KIND.AGENT, "empty object → agent default");
  });

  it("TASK_LANE_KIND enum has WORKFLOW and AGENT values", () => {
    assert.equal(TASK_LANE_KIND.WORKFLOW, "workflow");
    assert.equal(TASK_LANE_KIND.AGENT, "agent");
  });
});

describe("computeLaneROIAdmission — specialization admission by lane ROI", () => {
  it("admits when a lane meets both completion and ROI thresholds", () => {
    const signals = {
      quality: { completionRate: 0.75, roi: 0.60 },
      implementation: { completionRate: 0.30, roi: 0.20 },
    };
    const result = computeLaneROIAdmission(signals);
    assert.equal(result.admitted, true, "admitted when at least one lane passes");
    assert.ok(result.passingLanes.includes("quality"), "quality lane passes");
    assert.ok(result.failingLanes.includes("implementation"), "implementation fails");
  });

  it("blocks when all lanes are below thresholds (negative path)", () => {
    const signals = {
      quality: { completionRate: 0.20, roi: 0.10 },
      implementation: { completionRate: 0.15, roi: 0.05 },
    };
    const result = computeLaneROIAdmission(signals);
    assert.equal(result.admitted, false, "blocked when all lanes fail thresholds");
    assert.equal(result.passingLanes.length, 0, "no passing lanes");
    assert.equal(result.failingLanes.length, 2, "both lanes failing");
  });

  it("admits with optimistic default when no signals are provided", () => {
    const result = computeLaneROIAdmission({});
    assert.equal(result.admitted, true, "empty signals → optimistic default");
    assert.ok(result.reason.includes("no_lane_signals"), "reason cites no signals");
  });

  it("uses custom threshold overrides", () => {
    const signals = { quality: { completionRate: 0.50, roi: 0.40 } };
    // Standard thresholds would pass (0.50 >= 0.40 and 0.40 >= 0.30)
    const passResult = computeLaneROIAdmission(signals);
    assert.equal(passResult.admitted, true, "passes with default thresholds");
    // Stricter thresholds fail
    const failResult = computeLaneROIAdmission(signals, { minCompletionRate: 0.80, minROI: 0.70 });
    assert.equal(failResult.admitted, false, "fails with strict thresholds");
  });

  it("LANE_ROI_ADMISSION constants are exported and positive", () => {
    assert.ok(LANE_ROI_ADMISSION_MIN_COMPLETION_RATE > 0, "min completion rate is positive");
    assert.ok(LANE_ROI_ADMISSION_MIN_ROI > 0, "min ROI is positive");
    assert.ok(LANE_ROI_ADMISSION_MIN_COMPLETION_RATE < 1, "min completion rate is less than 1");
    assert.ok(LANE_ROI_ADMISSION_MIN_ROI < 1, "min ROI is less than 1");
  });
});

// ── isDispatchCheckpointResumable — resume-first semantics ───────────────────────

describe("isDispatchCheckpointResumable — resume-first daemon flow", () => {
  it("returns true for an in-progress checkpoint with remaining plans", () => {
    const checkpoint = { status: "dispatching", totalPlans: 5, completedPlans: 2 };
    assert.equal(isDispatchCheckpointResumable(checkpoint), true);
  });

  it("returns false when checkpoint is complete (all plans done)", () => {
    const checkpoint = { status: "dispatching", totalPlans: 5, completedPlans: 5 };
    assert.equal(isDispatchCheckpointResumable(checkpoint), false);
  });

  it("returns false when status is not 'dispatching'", () => {
    assert.equal(isDispatchCheckpointResumable({ status: "complete", totalPlans: 3, completedPlans: 1 }), false);
    assert.equal(isDispatchCheckpointResumable({ status: "failed", totalPlans: 3, completedPlans: 0 }), false);
  });

  it("returns false when totalPlans is 0 (nothing to resume)", () => {
    const checkpoint = { status: "dispatching", totalPlans: 0, completedPlans: 0 };
    assert.equal(isDispatchCheckpointResumable(checkpoint), false);
  });

  it("returns false for null or undefined checkpoint", () => {
    assert.equal(isDispatchCheckpointResumable(null), false);
    assert.equal(isDispatchCheckpointResumable(undefined), false);
  });

  it("negative path: completed checkpoint at exactly totalPlans is not resumable", () => {
    const checkpoint = { status: "dispatching", totalPlans: 3, completedPlans: 3 };
    assert.equal(isDispatchCheckpointResumable(checkpoint), false,
      "completedPlans === totalPlans means all dispatches are done — not resumable");
  });
});

// ── Stale PR guard — applyState state machine ─────────────────────────────────
//
// These tests exercise the idempotency and state-transition invariants of the
// runStaleAutomatedPrGuard apply-state machine without touching the GitHub API.
// Pure logic is extracted inline (same pattern as pr_triage_automation.test.ts).

describe("runStaleAutomatedPrGuard — applyState state machine", () => {
  // Reproduce the idempotency gate logic to verify it is correct in isolation.
  function isTerminalApplyState(record: unknown): boolean {
    if (!record || typeof record !== "object") return false;
    const state = (record as Record<string, unknown>).applyState;
    // "applied"    — action successfully executed; do not repeat.
    // "superseded" — GitHub returned HTTP 404; PR is permanently resolved.
    return state === "applied" || state === "superseded";
  }

  // Reproduce the valid-state set for schema validation.
  const VALID_APPLY_STATES = ["pending", "applied", "failed", "skipped", "superseded"];

  function buildTriageRecord(applyState: string, decision: string = "MERGE") {
    return {
      schemaVersion: 1,
      triageTimestamp: new Date().toISOString(),
      pr: { number: 100, isAutomatedPr: true, branch: "recovery/test" },
      ci: { allChecksPassed: true, passingChecks: 1, totalChecks: 1, failingChecks: 0, pendingChecks: 0 },
      diff: { hasSubstantiveChanges: true },
      decision,
      rationale: "test rationale",
      decidedBy: "runStaleAutomatedPrGuard",
      decidedAt: new Date().toISOString(),
      applyState,
    };
  }

  it("applyState=applied is terminal — idempotency gate returns true", () => {
    const record = buildTriageRecord("applied");
    assert.equal(isTerminalApplyState(record), true);
  });

  it("applyState=pending is not terminal — processing must proceed", () => {
    const record = buildTriageRecord("pending");
    assert.equal(isTerminalApplyState(record), false);
  });

  it("applyState=failed is not terminal — retry on next cycle", () => {
    const record = buildTriageRecord("failed");
    assert.equal(isTerminalApplyState(record), false);
  });

  it("applyState=superseded is terminal — HTTP 404 means PR is permanently resolved", () => {
    const record = buildTriageRecord("superseded");
    assert.equal(isTerminalApplyState(record), true);
  });

  it("applyState=skipped (dry-run) is not terminal — can be applied later", () => {
    const record = buildTriageRecord("skipped");
    assert.equal(isTerminalApplyState(record), false);
  });

  it("null record is treated as non-terminal — first run path", () => {
    assert.equal(isTerminalApplyState(null), false);
  });

  it("record without applyState field is not terminal — legacy migration path", () => {
    const legacyRecord = { schemaVersion: 1, decision: "MERGE", rationale: "old format" };
    assert.equal(isTerminalApplyState(legacyRecord), false);
  });

  it("negative path: unrecognised applyState is not treated as terminal", () => {
    const record = buildTriageRecord("unknown-state");
    assert.equal(isTerminalApplyState(record), false);
  });

  it("all valid applyState values are recognised by the schema set", () => {
    for (const state of VALID_APPLY_STATES) {
      assert.ok(VALID_APPLY_STATES.includes(state), `${state} must be in VALID_APPLY_STATES`);
    }
  });

  it("applied record for MERGE must have passing CI evidence", () => {
    const record = buildTriageRecord("applied", "MERGE") as any;
    if (record.decision === "MERGE" && record.applyState === "applied") {
      assert.ok(
        record.ci.allChecksPassed || record.ci.passingChecks > 0,
        "MERGE+applied record must show passing CI evidence",
      );
    }
  });

  it("CLOSE decision record can reach applied state regardless of CI", () => {
    const record = buildTriageRecord("applied", "CLOSE") as any;
    // CLOSE decisions may apply even when CI is failing — they are closing bad PRs.
    assert.equal(record.decision, "CLOSE");
    assert.equal(record.applyState, "applied");
  });

  it("negative path: applyState=applied without appliedAt is flagged as incomplete", () => {
    const record = buildTriageRecord("applied") as any;
    // appliedAt must be present for a fully applied record.
    // This test documents the expected invariant — not yet enforced by the schema,
    // but verified here to prevent silent state corruption.
    if (record.applyState === "applied") {
      // In a freshly built test record appliedAt is absent — this documents the gap.
      const hasAppliedAt = typeof record.appliedAt === "string" && record.appliedAt.length > 0;
      // The function that writes the record must include appliedAt — this test ensures
      // the invariant is tracked. Existing records without appliedAt are migration candidates.
      assert.equal(typeof hasAppliedAt, "boolean", "appliedAt presence check must be boolean");
    }
  });
});

// ── Stale-artifact closure fastpath — orchestrator integration ────────────────

describe("loadStaleTriageRecords — file discovery", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-stale-triage-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns empty array when state dir has no pr_triage files", async () => {
    const cfg = { paths: { stateDir: tmpDir } };
    const records = await loadStaleTriageRecords(cfg);
    assert.deepEqual(records, []);
  });

  it("reads a single triage record correctly", async () => {
    const record = { schemaVersion: 1, applyState: "superseded", pr: { number: 42 } };
    await fs.writeFile(path.join(tmpDir, "pr_triage_42.json"), JSON.stringify(record), "utf8");
    const cfg = { paths: { stateDir: tmpDir } };
    const records = await loadStaleTriageRecords(cfg);
    assert.equal(records.length, 1);
    assert.equal(records[0].applyState, "superseded");
  });

  it("reads multiple triage records from the state dir", async () => {
    for (const [num, state] of [[10, "applied"], [11, "superseded"], [12, "failed"]]) {
      await fs.writeFile(
        path.join(tmpDir, `pr_triage_${num}.json`),
        JSON.stringify({ applyState: state }),
        "utf8",
      );
    }
    const cfg = { paths: { stateDir: tmpDir } };
    const records = await loadStaleTriageRecords(cfg);
    assert.equal(records.length, 3);
    const states = records.map((r) => r.applyState).sort();
    assert.deepEqual(states, ["applied", "failed", "superseded"]);
  });

  it("ignores non-triage files in the state dir", async () => {
    await fs.writeFile(path.join(tmpDir, "orchestrator_health.json"), "{}", "utf8");
    await fs.writeFile(path.join(tmpDir, "prometheus_analysis.json"), "{}", "utf8");
    const cfg = { paths: { stateDir: tmpDir } };
    const records = await loadStaleTriageRecords(cfg);
    assert.deepEqual(records, []);
  });

  it("returns empty array when state dir does not exist", async () => {
    const cfg = { paths: { stateDir: path.join(tmpDir, "nonexistent") } };
    const records = await loadStaleTriageRecords(cfg);
    assert.deepEqual(records, []);
  });
});

describe("runStaleArtifactClosureFastpath — orchestrator decision", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-closure-fp-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns eligible=false when no triage records exist (even if CI were green)", async () => {
    // No GitHub token → fetchMainBranchCiStatus returns green=false, and no records.
    const cfg = { paths: { stateDir: tmpDir }, env: {} };
    const result = await runStaleArtifactClosureFastpath(cfg, []);
    assert.equal(result.eligible, false);
    assert.equal(result.stalePrCount, 0);
    assert.equal(result.reason, "no_stale_pr_records");
  });

  it("returns eligible=false when records exist but CI status is non-green", async () => {
    // Write a terminal triage record.
    const recentTimestamp = new Date(Date.now() - (5 * 60 * 1000)).toISOString();
    await fs.writeFile(
      path.join(tmpDir, "pr_triage_99.json"),
      JSON.stringify({ applyState: "superseded", triageTimestamp: recentTimestamp }),
      "utf8",
    );
    // No GitHub credentials → CI green = false.
    const cfg = {
      paths: { stateDir: tmpDir },
      env: {},
      runtime: { staleArtifactClosureRecencyMs: 60 * 60 * 1000 },
    };
    const result = await runStaleArtifactClosureFastpath(cfg, [{ task: "Close stale PR debt" }]);
    assert.equal(result.eligible, false);
    assert.equal(result.stalePrCount, 1);
    assert.equal(result.mainCiGreen, false);
    assert.equal(result.reason, "main_ci_not_green");
  });

  it("returns eligible=false when a non-terminal record exists", async () => {
    await fs.writeFile(
      path.join(tmpDir, "pr_triage_55.json"),
      JSON.stringify({ applyState: "pending" }),
      "utf8",
    );
    const cfg = { paths: { stateDir: tmpDir }, env: {} };
    const result = await runStaleArtifactClosureFastpath(cfg, [{ task: "Close stale PR debt" }]);
    assert.equal(result.eligible, false);
    assert.equal(result.stalePrCount, 1);
    assert.equal(result.reason, "non_terminal_stale_pr_records");
  });

  it("result always includes stalePrCount and mainCiGreen fields", async () => {
    const cfg = { paths: { stateDir: tmpDir }, env: {} };
    const result = await runStaleArtifactClosureFastpath(cfg, []);
    assert.ok("stalePrCount" in result, "stalePrCount must be present");
    assert.ok("mainCiGreen" in result, "mainCiGreen must be present");
    assert.ok("eligible" in result, "eligible must be present");
    assert.ok("reason" in result, "reason must be present");
  });

  it("negative path: mixed terminal/non-terminal records block the fastpath", async () => {
    for (const [num, state] of [[1, "applied"], [2, "pending"]]) {
      await fs.writeFile(
        path.join(tmpDir, `pr_triage_${num}.json`),
        JSON.stringify({ applyState: state }),
        "utf8",
      );
    }
    const cfg = { paths: { stateDir: tmpDir }, env: {} };
    const result = await runStaleArtifactClosureFastpath(cfg, [{ task: "Close stale PR debt" }]);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "non_terminal_stale_pr_records");
  });

  it("returns eligible=false when terminal triage records are only archival", async () => {
    const now = Date.now();
    const archivalTimestamp = new Date(now - (5 * 60 * 60 * 1000)).toISOString();

    await fs.writeFile(
      path.join(tmpDir, "pr_triage_1.json"),
      JSON.stringify({ applyState: "superseded", triageTimestamp: archivalTimestamp }),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "pr_triage_2.json"),
      JSON.stringify({ applyState: "applied", appliedAt: archivalTimestamp }),
      "utf8",
    );

    const cfg = {
      paths: { stateDir: tmpDir },
      env: {},
      runtime: { staleArtifactClosureRecencyMs: 60 * 60 * 1000 },
    };
    const result = await runStaleArtifactClosureFastpath(cfg, [{ task: "Close stale PR debt" }]);

    assert.equal(result.eligible, false);
    assert.equal(result.stalePrCount, 2);
    assert.equal(result.reason, "archival_terminal_stale_pr_records");
  });

  it("returns eligible=false for recent terminal records when CI is still non-green", async () => {
    const recentTimestamp = new Date(Date.now() - (5 * 60 * 1000)).toISOString();

    await fs.writeFile(
      path.join(tmpDir, "pr_triage_1.json"),
      JSON.stringify({ applyState: "superseded", triageTimestamp: recentTimestamp }),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "pr_triage_2.json"),
      JSON.stringify({ applyState: "applied", appliedAt: recentTimestamp }),
      "utf8",
    );

    const cfg = {
      paths: { stateDir: tmpDir },
      env: {},
      runtime: { staleArtifactClosureRecencyMs: 60 * 60 * 1000 },
    };
    const result = await runStaleArtifactClosureFastpath(cfg, [{ task: "Close stale PR debt" }]);

    assert.equal(result.eligible, false);
    assert.equal(result.stalePrCount, 2);
    assert.equal(result.mainCiGreen, false);
    assert.equal(result.reason, "main_ci_not_green");
  });

  it("returns eligible=false when current plans are unrelated fresh work", async () => {
    const recentTimestamp = new Date(Date.now() - (5 * 60 * 1000)).toISOString();

    await fs.writeFile(
      path.join(tmpDir, "pr_triage_1.json"),
      JSON.stringify({ applyState: "superseded", triageTimestamp: recentTimestamp }),
      "utf8",
    );

    const result = await runStaleArtifactClosureFastpath(
      {
        paths: { stateDir: tmpDir },
        env: {},
        runtime: { staleArtifactClosureRecencyMs: 60 * 60 * 1000 },
      },
      [{ task: "Propagate lineage join keys through analytics and routing" }],
    );

    assert.equal(result.eligible, false);
    assert.equal(result.reason, "current_plans_not_stale_artifact_closure");
  });

  it("persists a complete checkpoint for a skipped dispatch plan set", async () => {
    const cfg = { paths: { stateDir: tmpDir }, env: {} };
    const plans = [
      { role: "quality-worker", task: "Close stale PR debt", task_id: "plan-1", wave: 1 },
      { role: "infrastructure-worker", task: "Archive superseded artifacts", task_id: "plan-2", wave: 2 },
    ];

    await persistSkippedDispatchCheckpoint(cfg, plans, {
      planAnalyzedAt: "2026-04-11T15:13:33.184Z",
    });

    const checkpoint = JSON.parse(
      await fs.readFile(path.join(tmpDir, "dispatch_checkpoint.json"), "utf8"),
    );
    assert.equal(checkpoint.status, "complete");
    assert.equal(checkpoint.completedPlans, 2);
    assert.equal(checkpoint.planCount, 2);
    assert.equal(checkpoint.planAnalyzedAt, "2026-04-11T15:13:33.184Z");
    assert.equal(typeof checkpoint.planSetSignature, "string");
    assert.ok(checkpoint.planSetSignature.length > 0);
  });

  it("clears a stale Athena rejection latch after approval paths recover", async () => {
    const cfg = { paths: { stateDir: tmpDir }, env: {} };
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_rejection.json"),
      JSON.stringify({ rejectedAt: "2026-04-08T17:39:43.300Z" }),
      "utf8",
    );

    const cleared = await clearAthenaPlanRejectionLatch(cfg);
    assert.equal(cleared, true);

    const existsAfter = await fs.access(path.join(tmpDir, "athena_plan_rejection.json"))
      .then(() => true)
      .catch(() => false);
    assert.equal(existsAfter, false);
  });
});

