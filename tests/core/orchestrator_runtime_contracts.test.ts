import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  autoResolveBenchmarkRecommendations,
  buildCycleWorkerResultRow,
  isCheckpointAdvanceEligibleStatus,
  isResumePreferredTimeoutOutcome,
  promotePrometheusAnalysisFromWorkerEvidence,
  rebatchOversizedAthenaPlanGroupsForAdmission,
  resolveInterBatchCooldownDecision,
  shouldRunSelfEvolutionRuntimeHooks,
  shouldBypassLaneDiversityHardGate,
  shouldBypassSpecializationAdmissionGate,
  recoverStaleWorkerSessions,
  shouldRecoverWorkingSessionAfterDaemonRestart,
  extractMandatoryFindingsPreflightAdmissionTelemetry,
} from "../../src/core/orchestrator.js";

describe("orchestrator runtime contracts - timeout recovery", () => {
  it("marks PROCESS_TIMEOUT cooldown errors as resume-preferred", () => {
    assert.equal(
      isResumePreferredTimeoutOutcome({
        status: "error",
        reasonCode: "PROCESS_TIMEOUT",
        retryClass: "cooldown",
      }),
      true,
    );
  });

  it("ignores non-timeout outcomes", () => {
    assert.equal(
      isResumePreferredTimeoutOutcome({
        status: "transient_error",
        reasonCode: "TRANSIENT_API_ERROR",
        retryClass: "cooldown",
      }),
      false,
    );
    assert.equal(
      isResumePreferredTimeoutOutcome({
        status: "error",
        reasonCode: "UNKNOWN_EXIT",
        retryClass: "cooldown",
      }),
      false,
    );
  });
});

describe("orchestrator runtime contracts - self-evolution runtime gating", () => {
  it("runs self-evolution hooks only in self-dev mode", () => {
    assert.equal(
      shouldRunSelfEvolutionRuntimeHooks({
        platformModeState: { currentMode: "self_dev" },
      }),
      true,
    );
  });

  it("does not run self-evolution hooks during single-target delivery", () => {
    assert.equal(
      shouldRunSelfEvolutionRuntimeHooks({
        platformModeState: { currentMode: "single_target_delivery" },
      }),
      false,
    );
  });
});

describe("orchestrator runtime contracts - lane diversity hard gate bypass", () => {
  it("bypasses the hard gate when same-lane conflicts will be serialized into batches", () => {
    const result = shouldBypassLaneDiversityHardGate({
      plans: [
        { task: "Eliminate thin-packet rejection churn", _capabilityLane: "implementation" },
        { task: "Create shared context bus artifact", _capabilityLane: "implementation" },
      ],
      minLanes: 2,
      capabilityPoolResult: { activeLaneCount: 1 },
      laneConflicts: [{ lane: "implementation", sharedFiles: ["src/core/prometheus.ts"] }],
    });

    assert.equal(result.bypass, true);
    assert.equal(result.reason, "same_lane_conflicts_will_serialize_into_distinct_batches");
  });

  it("bypasses the hard gate for single-target endgame closure work on one remaining lane", () => {
    const result = shouldBypassLaneDiversityHardGate({
      plans: [
        {
          task: "Emit the final verification report and recompute project readiness for the active target session",
          taskKind: "verification",
          role: "quality-worker",
          _capabilityLane: "quality",
          currentMode: "single_target_delivery",
          currentStage: "active",
        },
      ],
      minLanes: 2,
      capabilityPoolResult: { activeLaneCount: 1 },
      laneConflicts: [],
    });

    assert.equal(result.bypass, true);
    assert.equal(result.reason, "single_target_endgame_single_lane_closure");
  });

  it("does not bypass the hard gate for plain monoculture without conflict serialization", () => {
    const result = shouldBypassLaneDiversityHardGate({
      plans: [
        { task: "Task A", _capabilityLane: "implementation" },
        { task: "Task B", _capabilityLane: "implementation" },
      ],
      minLanes: 2,
      capabilityPoolResult: { activeLaneCount: 1 },
      laneConflicts: [],
    });

    assert.equal(result.bypass, false);
    assert.equal(result.reason, null);
  });
});

describe("orchestrator runtime contracts - specialization admission bypass", () => {
  it("bypasses specialization when serialized same-lane topology makes specialist share infeasible", () => {
    const result = shouldBypassSpecializationAdmissionGate({
      laneDiversityBypassReason: "same_lane_conflicts_will_serialize_into_distinct_batches",
      capabilityPoolResult: {
        activeLaneCount: 1,
        specializationUtilization: {
          specializedShare: 0,
          specializedDeficit: 3,
        },
      },
    });

    assert.equal(result.bypass, true);
    assert.equal(result.reason, "serialized_same_lane_batch_topology_makes_specialization_target_infeasible");
  });

  it("bypasses specialization for single-target endgame closure on one remaining lane", () => {
    const result = shouldBypassSpecializationAdmissionGate({
      laneDiversityBypassReason: "single_target_endgame_single_lane_closure",
      capabilityPoolResult: {
        activeLaneCount: 1,
        specializationUtilization: {
          specializedShare: 0,
          specializedDeficit: 1,
        },
      },
    });

    assert.equal(result.bypass, true);
    assert.equal(result.reason, "single_target_endgame_single_lane_closure_makes_specialization_target_infeasible");
  });

  it("does not bypass specialization without a connected lane-diversity serialization signal", () => {
    const result = shouldBypassSpecializationAdmissionGate({
      laneDiversityBypassReason: null,
      capabilityPoolResult: {
        activeLaneCount: 1,
        specializationUtilization: {
          specializedShare: 0,
          specializedDeficit: 3,
        },
      },
    });

    assert.equal(result.bypass, false);
    assert.equal(result.reason, null);
  });
});

describe("orchestrator runtime contracts - oversized Athena admission rebatch", () => {
  it("splits an oversized Athena batch into admission-safe sub-batches", () => {
    const plans = [
      { role: "evolution-worker", _batchIndex: 1, _batchWorkerRole: "evolution-worker", _batchWave: 1, acceptance_criteria: ["a1", "a2", "a3", "a4"] },
      { role: "evolution-worker", _batchIndex: 1, _batchWorkerRole: "evolution-worker", _batchWave: 1, acceptance_criteria: ["b1", "b2", "b3"] },
      { role: "evolution-worker", _batchIndex: 1, _batchWorkerRole: "evolution-worker", _batchWave: 1, acceptance_criteria: ["c1", "c2", "c3", "c4"] },
      { role: "quality-worker", _batchIndex: 2, _batchWorkerRole: "quality-worker", _batchWave: 2, acceptance_criteria: ["q1"] },
    ];

    const result = rebatchOversizedAthenaPlanGroupsForAdmission(plans, 9);

    assert.equal(result.rewrote, true);
    assert.equal(result.splitGroups, 1);
    assert.equal(result.batchCount, 3);
    assert.deepEqual(plans.map((plan) => plan._batchIndex), [1, 1, 2, 3]);
    assert.deepEqual(plans.map((plan) => plan._batchTotal), [3, 3, 3, 3]);
  });

  it("returns a deterministic block reason when a single Athena plan is unsplittable", () => {
    const plans = [
      { role: "evolution-worker", _batchIndex: 1, _batchWorkerRole: "evolution-worker", _batchWave: 1, acceptance_criteria: Array.from({ length: 10 }, (_, i) => `step-${i}`) },
    ];

    const result = rebatchOversizedAthenaPlanGroupsForAdmission(plans, 9);

    assert.equal(result.rewrote, false);
    assert.match(String(result.blockedReason || ""), /ordered_step_complexity_unsplittable/);
  });
});

describe("orchestrator runtime contracts - Prometheus evidence promotion", () => {
  it("promotes matched plans to implemented_correctly with runtime evidence", () => {
    const analysis = {
      plans: [
        {
          task: "Fix timeout recovery flow",
          implementationStatus: "not_implemented",
          implementationEvidence: [],
        },
      ],
    };

    const rows = [
      {
        roleName: "evolution-worker",
        status: "done",
        planTasks: ["Fix timeout recovery flow"],
        filesTouched: ["src/core/orchestrator.ts"],
        verificationEvidence: "VERIFICATION_REPORT: BUILD=pass; TESTS=pass",
        dispatchContract: {
          doneWorkerWithVerificationReportEvidence: true,
          doneWorkerWithCleanTreeStatusEvidence: true,
        },
      },
    ];

    const result = promotePrometheusAnalysisFromWorkerEvidence(
      analysis,
      rows,
      "2026-04-09T12:00:00.000Z",
    );

    assert.equal(result.promotedCount > 0, true);
    assert.equal(result.analysis.plans[0].implementationStatus, "implemented_correctly");
    assert.ok(result.analysis.plans[0].implementationEvidence.includes("src/core/orchestrator.ts"));
  });

  it("leaves unrelated plans unchanged", () => {
    const analysis = {
      plans: [
        {
          task: "Unrelated task",
          implementationStatus: "not_implemented",
          implementationEvidence: [],
        },
      ],
    };

    const result = promotePrometheusAnalysisFromWorkerEvidence(
      analysis,
      [{ status: "done", planTasks: ["Different task"], filesTouched: [] }],
      "2026-04-09T12:00:00.000Z",
    );

    assert.equal(result.promotedCount, 0);
    assert.equal(result.analysis.plans[0].implementationStatus, "not_implemented");
  });
});

describe("orchestrator runtime contracts - benchmark auto-resolution", () => {
  it("uses runtime evidence strength for linked topic promotion", () => {
    const result = autoResolveBenchmarkRecommendations(
      [{
        recommendations: [
          {
            topic: "Worker lifecycle safety",
            implementationStatus: "pending",
            evidence: "",
          },
        ],
      }],
      {
        verifiedDoneWorkers: 1,
        workerBatches: [{ plans: [{ synthesis_sources: ["Worker lifecycle safety"] }] }],
        workerResults: [{
          roleName: "evolution-worker",
          status: "done",
          synthesisSources: ["Worker lifecycle safety"],
          filesTouched: ["src/core/worker_runner.ts"],
          verificationEvidence: "VERIFICATION_REPORT: TESTS=pass",
          dispatchContract: { doneWorkerWithVerificationReportEvidence: true },
        }],
        atIso: "2026-04-09T12:00:00.000Z",
      },
    );

    assert.equal(result.resolvedCount, 1);
    assert.equal(result.entries[0].recommendations[0].implementationStatus, "implemented_correctly");
  });

  it("preserves synthesis linkage when building cycle worker rows", () => {
    const row = buildCycleWorkerResultRow(
      {
        role: "evolution-worker",
        plans: [
          {
            task: "Fix timeout recovery flow",
            synthesis_sources: ["Worker lifecycle safety"],
          },
        ],
      },
      {
        status: "done",
        filesTouched: ["src/core/orchestrator.ts"],
        verificationEvidence: "VERIFICATION_REPORT: TESTS=pass",
        dispatchContract: { doneWorkerWithVerificationReportEvidence: true },
      },
    );

    assert.deepEqual(row.planTasks, ["Fix timeout recovery flow"]);
    assert.deepEqual(row.synthesisSources, ["Worker lifecycle safety"]);
    assert.deepEqual(row.filesTouched, ["src/core/orchestrator.ts"]);

    const benchmarkResult = autoResolveBenchmarkRecommendations(
      [{
        recommendations: [
          {
            topic: "Worker lifecycle safety",
            implementationStatus: "pending",
            evidence: "",
          },
        ],
      }],
      {
        verifiedDoneWorkers: 1,
        workerBatches: [{ plans: [{ synthesis_sources: ["Worker lifecycle safety"] }] }],
        workerResults: [row],
        atIso: "2026-04-09T12:00:00.000Z",
      },
    );

    assert.equal(benchmarkResult.entries[0].recommendations[0].implementationStatus, "implemented_correctly");

    const promotionResult = promotePrometheusAnalysisFromWorkerEvidence(
      {
        plans: [
          {
            task: "Fix timeout recovery flow",
            implementationStatus: "not_implemented",
            implementationEvidence: [],
          },
        ],
      },
      [row],
      "2026-04-09T12:00:00.000Z",
    );

    assert.equal(promotionResult.analysis.plans[0].implementationStatus, "implemented_correctly");
    assert.ok(promotionResult.analysis.plans[0].implementationEvidence.includes("src/core/orchestrator.ts"));
  });

  it("fails closed when only generic verified completion exists without linkage", () => {
    const result = autoResolveBenchmarkRecommendations(
      [{
        recommendations: [
          {
            topic: "Reflection memory",
            implementationStatus: "pending",
            evidence: "",
          },
        ],
      }],
      {
        verifiedDoneWorkers: 1,
        workerBatches: [],
        workerResults: [],
        atIso: "2026-04-09T12:00:00.000Z",
      },
    );

    assert.equal(result.resolvedCount, 0);
    assert.equal(result.entries[0].recommendations[0].implementationStatus, "pending");
  });
});

describe("orchestrator runtime contracts - closure truth", () => {
  it("treats only fully completed worker statuses as checkpoint-advance eligible", () => {
    assert.equal(isCheckpointAdvanceEligibleStatus("done"), true);
    assert.equal(isCheckpointAdvanceEligibleStatus("success"), true);
    assert.equal(isCheckpointAdvanceEligibleStatus("skipped"), true);
    assert.equal(isCheckpointAdvanceEligibleStatus("partial"), false);
    assert.equal(isCheckpointAdvanceEligibleStatus("blocked"), false);
  });
});

describe("orchestrator runtime contracts - startup stale worker recovery", () => {
  it("recovers working sessions left behind by a daemon restart", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-daemon-restart-"));

    try {
      await fs.writeFile(
        path.join(tmpDir, "daemon.pid.json"),
        JSON.stringify({ pid: 12345, startedAt: "2026-04-09T12:41:34.037Z" }, null, 2),
        "utf8",
      );

      const sessions = {
        "evolution-worker": {
          status: "working",
          startedAt: "2026-04-09T12:15:26.307Z",
          updatedAt: "2026-04-09T12:15:26.307Z",
        },
      };

      const recovered = await recoverStaleWorkerSessions(
        {
          paths: {
            stateDir: tmpDir,
            progressFile: path.join(tmpDir, "progress.txt"),
          },
        },
        tmpDir,
        sessions,
      );

      assert.equal(recovered, true);
      assert.equal(sessions["evolution-worker"].status, "idle");

      const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, "worker_sessions.json"), "utf8"));
      assert.equal(persisted["evolution-worker"].status, "idle");

      const progress = await fs.readFile(path.join(tmpDir, "progress.txt"), "utf8");
      assert.match(progress, /Recovered stale worker states \(1\): evolution-worker/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps genuinely live working sessions active after restart time", () => {
    assert.equal(
      shouldRecoverWorkingSessionAfterDaemonRestart(
        {
          status: "working",
          startedAt: "2026-04-09T12:45:00.000Z",
          updatedAt: "2026-04-09T12:46:00.000Z",
        },
        "2026-04-09T12:41:34.037Z",
      ),
      false,
    );
  });
});

describe("orchestrator runtime contracts - adaptive inter-batch cooldown", () => {
  it("uses the fast path after a clean successful batch when more work remains", () => {
    const result = resolveInterBatchCooldownDecision({
      runtime: {
        interBatchDelayMs: 90000,
        interBatchSuccessDelayMs: 15000,
      },
    }, {
      remainingBatches: 2,
      workerStatus: "done",
      transientRetries: 0,
    });

    assert.equal(result.cooldownMs, 15000);
    assert.equal(result.reason, "successful_batch_fast_path");
  });

  it("keeps the full cooldown after transient retry pressure", () => {
    const result = resolveInterBatchCooldownDecision({
      runtime: {
        interBatchDelayMs: 90000,
        interBatchSuccessDelayMs: 15000,
      },
    }, {
      remainingBatches: 1,
      workerStatus: "done",
      transientRetries: 1,
    });

    assert.equal(result.cooldownMs, 90000);
    assert.equal(result.reason, "transient_retry_recovery");
  });

  it("returns zero cooldown when no batches remain", () => {
    const result = resolveInterBatchCooldownDecision({
      runtime: {
        interBatchDelayMs: 90000,
      },
    }, {
      remainingBatches: 0,
      workerStatus: "done",
      transientRetries: 0,
    });

    assert.equal(result.cooldownMs, 0);
    assert.equal(result.reason, "no_remaining_batches");
  });

  it("uses the fast path for environment-blocked batches where waiting does not improve readiness", () => {
    const result = resolveInterBatchCooldownDecision({
      runtime: {
        interBatchDelayMs: 90000,
        interBatchSuccessDelayMs: 15000,
      },
    }, {
      remainingBatches: 1,
      workerStatus: "blocked",
      transientRetries: 0,
      dispatchBlockReason: "access_blocked:tools",
    });

    assert.equal(result.cooldownMs, 15000);
    assert.equal(result.reason, "environment_blocker_fast_path");
  });
});

// ── extractSessionsFromCycleRecord — canonical session loading behavior ────────

import {
  extractSessionsFromCycleRecord,
  migrateWorkerCycleArtifacts,
  selectWorkerCycleRecord,
} from "../../src/core/cycle_analytics.js";

describe("orchestrator — canonical session loading behavior (extractSessionsFromCycleRecord)", () => {
  it("returns null for missing canonical artifacts (signals legacy fallback required)", () => {
    const sessions = extractSessionsFromCycleRecord(null);
    assert.equal(sessions, null);
  });

  it("returns null for canonical record without workerSessions key", () => {
    assert.equal(extractSessionsFromCycleRecord({ cycleId: "c1", status: "active" }), null);
  });

  it("returns sessions from a valid canonical record", () => {
    const record = {
      workerSessions: {
        coder: { status: "working", startedAt: new Date().toISOString() },
      },
      workerActivity: {},
    };
    const sessions = extractSessionsFromCycleRecord(record);
    assert.ok(sessions, "sessions must not be null for valid record");
    assert.ok("coder" in sessions, "coder session must be present");
  });

  it("full canonical path: migrate → select → extract yields sessions consistent with recoverStaleWorkerSessions input", () => {
    const cycleId = new Date().toISOString();
    const rawArtifacts = {
      schemaVersion: 1,
      updatedAt: cycleId,
      latestCycleId: cycleId,
      cycles: {
        [cycleId]: {
          cycleId,
          status: "active",
          updatedAt: cycleId,
          workerSessions: {
            coder: { status: "working", startedAt: cycleId },
          },
          workerActivity: { coder: [] },
          completedTaskIds: [],
        },
      },
    };
    const migrated = migrateWorkerCycleArtifacts(rawArtifacts);
    assert.ok(migrated.ok && migrated.data, "migration must succeed for valid artifacts");
    const { record } = selectWorkerCycleRecord(migrated.data!, cycleId);
    const sessions = extractSessionsFromCycleRecord(record);
    assert.ok(sessions, "canonical path must yield sessions");
    assert.ok("coder" in sessions!, "coder must be present after full canonical path");
    const coderSessions = sessions!.coder as any;
    assert.equal(coderSessions.status, "working");
    assert.ok(Array.isArray(coderSessions._activityLog), "_activityLog must be present");

    // Verify the extracted sessions can feed recoverStaleWorkerSessions (structural compatibility).
    const recovered = recoverStaleWorkerSessions(sessions!);
    assert.ok(typeof recovered === "object" && recovered !== null, "recovered must be an object");
  });
});

// ── filterStaleWorkerSessions — canonical-first liveness arbitration ──────────

import { filterStaleWorkerSessions } from "../../src/core/cycle_analytics.js";

describe("orchestrator — filterStaleWorkerSessions pure function contracts", () => {
  it("returns all sessions with no staleRoles when sessions is empty", () => {
    const result = filterStaleWorkerSessions({}, null);
    assert.deepEqual(result.sessions, {});
    assert.deepEqual(result.staleRoles, []);
  });

  it("returns all sessions unchanged when cycleStart is null (no reference available)", () => {
    const sessions = {
      worker1: { status: "working", startedAt: "2020-01-01T00:00:00.000Z" },
    };
    const result = filterStaleWorkerSessions(sessions, null);
    assert.ok("worker1" in result.sessions, "session must be kept when cycleStart is null");
    assert.deepEqual(result.staleRoles, [], "no stale roles when cycleStart is null");
  });

  it("excludes sessions whose startedAt predates cycleStart", () => {
    const cycleStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const staleTs    = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const freshTs    = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const sessions = {
      stale:  { status: "working", startedAt: staleTs },
      active: { status: "working", startedAt: freshTs },
    };
    const result = filterStaleWorkerSessions(sessions, cycleStart);

    assert.ok(!("stale" in result.sessions), "stale session must be excluded");
    assert.ok("active" in result.sessions, "active session must remain");
    assert.ok(result.staleRoles.includes("stale"), "stale role must be reported");
    assert.equal(result.staleRoles.length, 1);
  });

  it("prefers lastActiveAt over startedAt when both are present", () => {
    const cycleStart      = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const staleStart      = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const freshLastActive = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // startedAt is before cycleStart but lastActiveAt is after — should NOT be filtered
    const sessions = {
      mixed: { status: "working", startedAt: staleStart, lastActiveAt: freshLastActive },
    };
    const result = filterStaleWorkerSessions(sessions, cycleStart);

    assert.ok("mixed" in result.sessions,
      "session with stale startedAt but fresh lastActiveAt must be kept");
    assert.deepEqual(result.staleRoles, []);
  });

  it("keeps sessions with no parseable timestamp (cannot be proven stale)", () => {
    const cycleStart = new Date().toISOString();
    const sessions = {
      unknown: { status: "working" }, // no timestamps at all
    };
    const result = filterStaleWorkerSessions(sessions, cycleStart);

    assert.ok("unknown" in result.sessions,
      "session with no timestamp must be kept (cannot prove staleness)");
    assert.deepEqual(result.staleRoles, []);
  });

  it("filters all sessions when all predate cycleStart", () => {
    const cycleStart = new Date(Date.now() - 60 * 1000).toISOString();
    const staleTs    = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const sessions = {
      worker1: { status: "working", startedAt: staleTs },
      worker2: { status: "idle",    startedAt: staleTs },
    };
    const result = filterStaleWorkerSessions(sessions, cycleStart);

    assert.deepEqual(result.sessions, {}, "all sessions must be filtered");
    assert.equal(result.staleRoles.length, 2);
    assert.ok(result.staleRoles.includes("worker1"));
    assert.ok(result.staleRoles.includes("worker2"));
  });

  it("returns sessions unchanged when all timestamps are after cycleStart", () => {
    const cycleStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const freshTs    = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const sessions = {
      worker1: { status: "working", startedAt: freshTs },
      worker2: { status: "working", startedAt: freshTs },
    };
    const result = filterStaleWorkerSessions(sessions, cycleStart);

    assert.ok("worker1" in result.sessions);
    assert.ok("worker2" in result.sessions);
    assert.deepEqual(result.staleRoles, []);
  });
});

// ── extractMandatoryFindingsPreflightAdmissionTelemetry ───────────────────────

describe("extractMandatoryFindingsPreflightAdmissionTelemetry", () => {
  it("returns null when analysis is null", () => {
    const result = extractMandatoryFindingsPreflightAdmissionTelemetry(null);
    assert.equal(result, null);
  });

  it("returns null when analysis is undefined", () => {
    const result = extractMandatoryFindingsPreflightAdmissionTelemetry(undefined);
    assert.equal(result, null);
  });

  it("returns null when mandatoryTasks is absent", () => {
    const analysis = { plan: [], mandatoryTasks: undefined };
    const result = extractMandatoryFindingsPreflightAdmissionTelemetry(analysis);
    assert.equal(result, null);
  });

  it("returns null when mandatoryTasks.preflightResult is absent", () => {
    const analysis = { mandatoryTasks: { tasks: [], preflightResult: undefined } };
    const result = extractMandatoryFindingsPreflightAdmissionTelemetry(analysis);
    assert.equal(result, null);
  });

  it("returns structured telemetry when preflightResult is present", () => {
    const analysis = {
      mandatoryTasks: {
        tasks: [],
        preflightResult: {
          preflightStatus: "TRUSTED",
          trustedFindings: [{ id: "api-design" }],
          quarantinedFindings: [],
          quarantinedCount: 0,
          quarantineReasons: [],
          sourceFresh: true,
          sourceAgeMs: 3_600_000,
        },
      },
    };
    const result = extractMandatoryFindingsPreflightAdmissionTelemetry(analysis);
    assert.ok(result !== null, "must return telemetry when preflightResult is present");
    assert.equal(result.preflightStatus, "TRUSTED");
    assert.equal(result.trustedCount, 1);
    assert.equal(result.quarantinedCount, 0);
    assert.equal(result.sourceAgeMs, 3_600_000);
    assert.equal(result.sourceFresh, true);
  });

  it("returns correct counts when some findings are quarantined (DEGRADED)", () => {
    const analysis = {
      mandatoryTasks: {
        tasks: [],
        preflightResult: {
          preflightStatus: "DEGRADED",
          trustedFindings: [{ id: "api-design" }],
          quarantinedFindings: [{ id: "ci-fix" }],
          quarantinedCount: 1,
          quarantineReasons: ["mandatory_finding_quarantined:ci-fix:stale_ci_evidence"],
          sourceFresh: false,
          sourceAgeMs: 90_000_000,
        },
      },
    };
    const result = extractMandatoryFindingsPreflightAdmissionTelemetry(analysis);
    assert.ok(result !== null);
    assert.equal(result.preflightStatus, "DEGRADED");
    assert.equal(result.trustedCount, 1);
    assert.equal(result.quarantinedCount, 1);
    assert.equal(result.sourceFresh, false);
  });

  it("returns correct counts when all findings are quarantined (QUARANTINED)", () => {
    const analysis = {
      mandatoryTasks: {
        tasks: [],
        preflightResult: {
          preflightStatus: "QUARANTINED",
          trustedFindings: [],
          quarantinedFindings: [{ id: "ci-fix" }, { id: "ci-setup" }],
          quarantinedCount: 2,
          quarantineReasons: [
            "mandatory_finding_quarantined:ci-fix:stale_ci_evidence",
            "mandatory_finding_quarantined:ci-setup:stale_ci_evidence",
          ],
          sourceFresh: false,
          sourceAgeMs: Infinity,
        },
      },
    };
    const result = extractMandatoryFindingsPreflightAdmissionTelemetry(analysis);
    assert.ok(result !== null);
    assert.equal(result.preflightStatus, "QUARANTINED");
    assert.equal(result.trustedCount, 0);
    assert.equal(result.quarantinedCount, 2);
    // sourceAgeMs is null when source age is Infinity (not JSON-safe); check sourceFresh instead
    assert.equal(result.sourceAgeMs, null);
    assert.equal(result.sourceFresh, false);
  });

  it("negative: returns null for completely empty object", () => {
    const result = extractMandatoryFindingsPreflightAdmissionTelemetry({});
    assert.equal(result, null);
  });
});

// ── buildWorkerCycleArtifactsFreshnessRecord — cycle snapshot freshness ────────

import {
  buildWorkerCycleArtifactsFreshnessRecord,
  WORKER_CYCLE_ARTIFACTS_FRESHNESS_MAX_AGE_MS,
} from "../../src/core/cycle_analytics.js";

describe("buildWorkerCycleArtifactsFreshnessRecord — cycle snapshot freshness signals", () => {
  it("extracts updatedAt from valid artifact data as recordedAt", () => {
    const ts = new Date().toISOString();
    const result = buildWorkerCycleArtifactsFreshnessRecord({
      schemaVersion: 1,
      updatedAt: ts,
      latestCycleId: "cycle-1",
      cycles: {},
    });
    assert.equal(result.recordedAt, ts);
    assert.equal(result.label, "worker_cycle_artifacts");
    assert.equal(result.staleAfterMs, WORKER_CYCLE_ARTIFACTS_FRESHNESS_MAX_AGE_MS);
  });

  it("returns recordedAt=null when artifact data is null (file absent)", () => {
    const result = buildWorkerCycleArtifactsFreshnessRecord(null);
    assert.equal(result.recordedAt, null);
    assert.equal(result.label, "worker_cycle_artifacts");
  });

  it("returns recordedAt=null when artifact data is undefined", () => {
    const result = buildWorkerCycleArtifactsFreshnessRecord(undefined);
    assert.equal(result.recordedAt, null);
  });

  it("returns recordedAt=null when artifact data lacks updatedAt field", () => {
    const result = buildWorkerCycleArtifactsFreshnessRecord({ schemaVersion: 1, cycles: {} });
    assert.equal(result.recordedAt, null);
  });

  it("returns recordedAt=null for non-object inputs (e.g. arrays, primitives)", () => {
    assert.equal(buildWorkerCycleArtifactsFreshnessRecord([]).recordedAt, null);
    assert.equal(buildWorkerCycleArtifactsFreshnessRecord("string").recordedAt, null);
    assert.equal(buildWorkerCycleArtifactsFreshnessRecord(42).recordedAt, null);
  });

  it("staleAfterMs is 6 hours (matches WORKER_CYCLE_ARTIFACTS_FRESHNESS_MAX_AGE_MS)", () => {
    assert.equal(WORKER_CYCLE_ARTIFACTS_FRESHNESS_MAX_AGE_MS, 6 * 60 * 60 * 1000);
    const result = buildWorkerCycleArtifactsFreshnessRecord({ updatedAt: new Date().toISOString() });
    assert.equal(result.staleAfterMs, 6 * 60 * 60 * 1000);
  });
});