/**
 * BOX Orchestrator — Athena-Gated Loop Architecture
 *
 * Flow per cycle:
 *   Janus (orchestrator/state analyzer) → Prometheus (full scan + plan)
 *   → Athena (validate plan) → Worker(s)
 *   → back to Prometheus for next iteration
 *
 * Each agent uses exactly 1 premium request per invocation (single-prompt).
 * No autopilot. Janus orchestrates, Prometheus plans, Athena gates.
 *
 * Startup:
 *   1. Read last checkpoint (worker_sessions.json + prometheus_analysis.json)
 *   2. If workers are active → resume monitoring, ZERO AI calls
 *   3. If no checkpoint → first run → Janus analyzes state
 *   4. If project interrupted → Janus decides: continue or re-plan
 */

import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { appendProgress, appendAlert, ALERT_SEVERITY, appendGovernanceBlockEvent, recordCapabilityExecution, appendInterventionApplicationEntries, appendInterventionRetirementEvidence, appendPolicyClosureEvidence, enforceStateRetention, readPromptCacheTelemetry } from "./state_tracker.js";
import { readStopRequest, writeDaemonPid, clearDaemonPid, clearStopRequest, readReloadRequest, clearReloadRequest, createCancellationToken, readDaemonPid } from "./daemon_control.js";
import type { CancellationToken } from "./daemon_control.js";
import { loadConfig } from "../config.js";
import { runJanusCycle, appendJanusOutcomeLedger, buildJanusDecisionOutcome } from "./janus_supervisor.js";
import { runPrometheusAnalysis, loadTopicMemory, saveTopicMemory, topicKey as prometheusTopicKey, findCanonicalTopicKey, applyPlanLifecycleAdmissionFilter, isResearchArtifactAlignedToTargetSession } from "./prometheus.js";
import {
  runAthenaPlanReview,
  ATHENA_PLAN_REVIEW_REASON_CODE,
  hasFiniteAthenaOverallScore,
  extractCrossCycleDispatchPrerequisiteFromDependency,
  evaluateStaleArtifactClosureFastpath,
} from "./athena_reviewer.js";
import { runWorkerConversation, isAnalyticsCompletedWorkerStatus, isTerminalWorkerStatus } from "./worker_runner.js";
import { capturePreWorkBaseline, runProjectCompletion, isProjectAlreadyCompleted } from "./project_lifecycle.js";
import {
  evaluateTargetSuccessContract,
  isTargetSuccessContractTerminal,
  performTargetDeliveryHandoff,
  persistTargetSuccessContract,
  TARGET_SUCCESS_CONTRACT_STATUS,
} from "./target_success_contract.js";
import { warn, emitEvent } from "./logger.js";
import { EVENTS, EVENT_DOMAIN } from "./event_schema.js";
import { readJson, readJsonSafe, writeJson, cleanupStaleTempFiles, READ_JSON_REASON } from "./fs_utils.js";
import { updatePipelineProgress, readPipelineProgress } from "./pipeline_progress.js";
import { loadEscalationQueue, sortEscalationQueue, processEscalationQueueClosures } from "./escalation_queue.js";
import { computeCycleSLOs, persistSloMetrics, detectCoupledAlerts, patchSloMetricsReplayEvidence } from "./slo_checker.js";
import { computeCycleAnalytics, persistCycleAnalytics, computeCycleHealth, persistCycleHealthComposite, CYCLE_PHASE, computeRuntimeContractProbe, readCycleAnalytics, evaluateBenchmarkGroundTruth, WORKER_CYCLE_ARTIFACTS_FILE, migrateWorkerCycleArtifacts, selectWorkerCycleRecord, generateDeterministicTaskId, CYCLE_OUTCOME_STATUS, computeCiRemediationStatus } from "./cycle_analytics.js";
import { computeBaselineRecoveryState, persistBaselineMetrics, PARSER_CONFIDENCE_RECOVERY_THRESHOLD } from "./parser_baseline_recovery.js";
import { computeDispatchStrictness, loadReplayRegressionState, DISPATCH_STRICTNESS } from "./parser_replay_harness.js";
import {
  addSchemaVersion,
  migrateData,
  recordMigrationTelemetry,
  STATE_FILE_TYPE,
  MIGRATION_REASON
} from "./schema_registry.js";
import { runCatastropheDetection, GUARDRAIL_ACTION, isSloCascadingBreachScenario } from "./catastrophe_detector.js";
import { executeGuardrailsForDetections, isGuardrailActive, readForceCheckpointValidationContract, autoRevertSloGuardrailIfResolved } from "./guardrail_executor.js";
import { evaluateFreezeGate, isFreezeActive } from "./governance_freeze.js";
import { detectRecurrences, buildRecurrenceEscalations } from "./recurrence_detector.js";
import { checkClosureSLA } from "./closure_validator.js";
import { appendCapacityEntry } from "./capacity_scoreboard.js";
import { computeCapabilityDelta } from "./delta_analytics.js";
import { evaluateRetune } from "./strategy_retuner.js";
import { compileLessonsToPolicies } from "./learning_policy_compiler.js";
import { assignWorkersToPlans, enforceLaneDiversity, evaluateSpecializationAdmissionGate, computeTopologyFeasibility, buildLanePerformanceFromCycleTelemetry, buildLaneTelemetrySignals, buildReroutePenaltyLedger, SPECIALIZATION_ADMISSION_MAX_BLOCK_CYCLES, getLaneScore, computeAdaptiveSpecialistFillThreshold, buildWorkerChain, computeLaneROIAdmission } from "./capability_pool.js";
import { runDoctor } from "./doctor.js";
import { validateAllPlans, validatePacketBatchAdmission, applyDispatchBoundaryHardCap, bindNamedVerificationTargets } from "./plan_contract_validator.js";
import {
  resolveDependencyGraph,
  computeReadinessGate,
  GRAPH_STATUS,
  type ReadinessGateResult,
} from "./dependency_graph_resolver.js";
import { isGovernanceCanaryBreachActive } from "./governance_canary.js";
import { executeRollback, ROLLBACK_LEVEL, ROLLBACK_TRIGGER } from "./rollback_engine.js";
import { initializeAggregateLiveLog, appendAggregateLiveLogSync } from "./live_log.js";
import { buildRoleExecutionBatches, buildTokenFirstBatches, measureWaveBoundaryIdleGap, shouldPackAcrossWaveBoundary, estimatePlanTokens, getUsableModelContextTokens, DEFAULT_SPECIALIST_FILL_THRESHOLD } from "./worker_batch_planner.js";
import { computeFrontier } from "./dag_scheduler.js";
import { agentFileExists, nameToSlug, validateCriticalAgentContracts, validateRequiredAgentContracts } from "./agent_loader.js";
import { buildWorkerTopologyContract, getRoleRegistry, assertRoleCapabilityForTask, isAthenaReviewOrPostmortemTask } from "./role_registry.js";
import type { WorkerTopologyContract } from "./role_registry.js";
import { normalizePromptLineageContract } from "./prompt_compiler.js";
import {
  checkArchitectureDrift,
  rankStaleRefsAsRemediationCandidates,
  type ArchitectureDriftReport,
} from "./architecture_drift.js";
import { detectLaneConflicts } from "./capability_pool.js";
import {
  loadLedgerMeta,
  addDebtEntries,
  saveLedgerFull,
  shouldBlockOnDebt,
  autoCloseVerifiedDebt,
  reconcileReplayClosureBacklog,
  MANDATORY_REPLAY_LINEAGE_IDS,
} from "./carry_forward_ledger.js";
import { reconcileBudgetEligibility, computeRollingCompletionYield, type BudgetEligibilityContract, type RollingYieldContract } from "./budget_controller.js";
import {
  runInterventionOptimizer,
  buildInterventionsFromPlan,
  buildBudgetFromConfig,
  persistOptimizerLog,
  OPTIMIZER_STATUS,
  buildPolicyImpactByInterventionId,
  OVERBUNDLE_STEPS_THRESHOLD,
  checkOverbundleHardAdmission,
} from "./intervention_optimizer.js";
import { evaluateInterventionsForCycle } from "./intervention_judge.js";
import { evaluateAutonomyBand, type CycleSample } from "./autonomy_band_monitor.js";
import { loadPlatformModeState, PLATFORM_MODE, summarizePlatformModeState } from "./mode_state.js";
import {
  archiveTargetSession,
  loadActiveTargetSession,
  loadLastArchivedTargetSession,
  saveActiveTargetSession,
  summarizeActiveTargetSession,
  transitionActiveTargetSession,
  TARGET_FEEDBACK_CATEGORY,
  TARGET_INTENT_STATUS,
  TARGET_SESSION_STAGE,
} from "./target_session_state.js";
import { refreshTargetSessionReadiness, runTargetOnboarding, TARGET_ONBOARDING_AGENT_SLUG } from "./onboarding_runner.js";
import { validatePlanEvidenceCoupling } from "./evidence_envelope.js";
import { runResearchScout } from "./research_scout.js";
import { runResearchSynthesizer, persistBenchmarkEntry } from "./research_synthesizer.js";
import { buildReplayClosureEvidence, CANONICAL_MAIN_BRANCH_REPLAY_COMMANDS, hasCleanTreeStatusEvidence, hasVerificationReportEvidence } from "./verification_gate.js";
import {
  classifyFailure,
  persistFailureClassification,
  loadRecentFailureClassifications,
  normalizeRoleKey,
} from "./failure_classifier.js";
import { recordAgentHandoff } from "./agent_control_plane.js";
import {
  readCheckpoint as readVersionedCheckpoint,
  writeCheckpoint as writeVersionedCheckpoint,
  initializeRunSegmentState,
  applyRunSegmentRollover,
  RUN_SEGMENT_BATCH_SPAN_DEFAULT,
  RUN_SEGMENT_HISTORY_MAX_DEFAULT,
  checkCancellationAtCheckpoint,
  writeBoundaryCheckpoint,
  CHECKPOINT_NS,
} from "./checkpoint_engine.js";
import { assessRetryExpectedROI, loadRouteROILedger, rankModelsByTaskKindExpectedValue } from "./model_policy.js";
import { loadHookPolicy, DEFAULT_HOOK_POLICY_PATH } from "./policy_engine.js";
import {
  AGENT_CONTRACT_GOVERNANCE_REASON_CODE,
  GOVERNANCE_DISPATCH_BLOCK_REASON,
  GOVERNANCE_SIGNAL_REGISTRY,
  resolveAutonomyExecutionGateBlockReason,
} from "./governance_contract.js";
import { buildSingleTargetStartupGuardMessage, evaluateSingleTargetStartupRequirements } from "./single_target_startup_guard.js";

/**
 * Orchestrator health status enum.
 * Written to state/orchestrator_health.json whenever status changes.
 */
export const ORCHESTRATOR_STATUS = Object.freeze({
  OPERATIONAL: "operational",
  DEGRADED: "degraded"
});

/**
 * Explicit gate-precedence mapping for evaluatePreDispatchGovernanceGate.
 *
 * Each value is the numeric order (1 = evaluated first) in which the gate fires.
 * Lower numbers take priority — a gate with precedence 1 blocks before any gate
 * with precedence 2 is evaluated. Consumers can compare result.gateIndex against
 * these values to determine which gate fired without parsing the reason string.
 *
 * Order rationale:
 *   1. BUDGET_ELIGIBILITY    — hard short-circuit; prevents expensive downstream reads
 *   2. GUARDRAIL_PAUSE       — system-level safety valve; checked before governance logic
 *   3. GOVERNANCE_FREEZE     — policy freeze overrides all planning gates
 *   3.25 CLOUD_AGENT_GOVERNANCE — repository-level cloud-agent governance profile validation
 *   4. LINEAGE_CYCLE         — structural integrity before scheduling canary/debt checks
 *   5. GOVERNANCE_CANARY     — canary breach triggers rollback; evaluated before ledger ops
 *   6. CARRY_FORWARD_DEBT    — outstanding critical debt blocks new dispatch
 *   7. MANDATORY_DRIFT_DEBT  — architecture integrity gate before plan validation
 *   8. PLAN_EVIDENCE_COUPLING — validates individual plan completeness
 *   9. CROSS_CYCLE_PREREQUISITE — requires explicit cross-cycle confirmation token
 *  10. DEPENDENCY_READINESS  — validates dependency confidence metadata
 *  11. LANE_DIVERSITY        — active lanes below required minimum
 *  12. ROLLING_COMPLETION_YIELD — throttles when recent yield is too low
 *  13. SPECIALIZATION_ADMISSION — specialist share below adaptive lane target
 *  14. OVERSIZED_PACKET      — per-role plan group exceeds actionable-steps cap
 */
export const GATE_PRECEDENCE = Object.freeze({
  BUDGET_ELIGIBILITY:          1,
  GUARDRAIL_PAUSE:             2,
  FORCE_CHECKPOINT:            3.5,
  GOVERNANCE_FREEZE:           3,
  CLOUD_AGENT_GOVERNANCE:      3.25,
  AUTONOMY_EXECUTION:          3.75,
  LINEAGE_CYCLE:               4,
  GOVERNANCE_CANARY:           5,
  CARRY_FORWARD_DEBT:          6,
  MANDATORY_DRIFT_DEBT:        7,
  PLAN_EVIDENCE_COUPLING:      8,
  /** Cross-cycle prerequisite metadata is present but has no confirmation token. */
  CROSS_CYCLE_PREREQUISITE:    9,
  /** Confidence metadata on plans is below the minimum dispatch threshold. */
  DEPENDENCY_READINESS:       10,
  /** Active plan topology spans fewer lanes than required minimum. */
  LANE_DIVERSITY:             10.5,
  /** Rolling completion yield is below the throttle threshold — dispatch is paused to prevent waste spirals. */
  ROLLING_COMPLETION_YIELD:   11,
  /** Specialization admission gate — specialist share below adaptive lane target. */
  SPECIALIZATION_ADMISSION:   12,
  /** Oversized packet gate — per-role plan group exceeds the configured actionable-steps cap. */
  OVERSIZED_PACKET:           13,
});

/**
 * Stable block-reason prefix constants emitted by evaluatePreDispatchGovernanceGate.
 *
 * Each constant is the authoritative prefix of the reason string returned when
 * the corresponding gate fires.  Dynamic detail (counts, paths, sub-reasons) is
 * appended after a `:` separator, but the prefix is guaranteed stable across
 * releases so consumers can pattern-match on `reason.startsWith(BLOCK_REASON.X)`.
 *
 * BUDGET_EXHAUSTED intentionally mirrors the budget_controller output prefix so
 * both the controller and the gate surface the same token vocabulary.
 */
export const BLOCK_REASON = GOVERNANCE_DISPATCH_BLOCK_REASON;

const CLOUD_AGENT_ALLOWED_SETUP_JOB_KEYS = new Set([
  "steps",
  "permissions",
  "runs-on",
  "services",
  "snapshot",
  "timeout-minutes",
]);

function resolveGithubTargetRepoSlug(repoUrl: unknown): string | null {
  const normalized = String(repoUrl || "").trim();
  if (!normalized) return null;
  const match = normalized.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function bindRuntimeTargetContext(config: any, platformModeState: any, activeTargetSession: any): void {
  config.platformModeState = platformModeState;
  config.activeTargetSession = activeTargetSession;
  if (platformModeState?.currentMode !== PLATFORM_MODE.SINGLE_TARGET_DELIVERY || !activeTargetSession) {
    return;
  }

  const targetRepoSlug = resolveGithubTargetRepoSlug(activeTargetSession.repo?.repoUrl);
  config.env = {
    ...(config.env || {}),
    ...(targetRepoSlug ? { targetRepo: targetRepoSlug } : {}),
    ...(activeTargetSession.repo?.defaultBranch ? { targetBaseBranch: activeTargetSession.repo.defaultBranch } : {}),
  };
}

function resolveRuntimeTargetSessionStamp(platformModeState: any, activeTargetSession: any): Record<string, unknown> | null {
  if (platformModeState?.currentMode !== PLATFORM_MODE.SINGLE_TARGET_DELIVERY || !activeTargetSession?.sessionId) {
    return null;
  }

  return {
    projectId: activeTargetSession.projectId,
    sessionId: activeTargetSession.sessionId,
    currentStage: activeTargetSession.currentStage,
    repoUrl: activeTargetSession.repo?.repoUrl || null,
  };
}

function isRuntimeTargetSessionAlignedArtifact(artifact: any, platformModeState: any, activeTargetSession: any): boolean {
  const runtimeTargetSession = resolveRuntimeTargetSessionStamp(platformModeState, activeTargetSession);
  const artifactTargetSession = artifact?.targetSession && typeof artifact.targetSession === "object"
    ? artifact.targetSession
    : null;

  if (!runtimeTargetSession) {
    return !artifactTargetSession;
  }
  if (!artifactTargetSession) {
    return false;
  }

  return isResearchArtifactAlignedToTargetSession({ targetSession: artifactTargetSession }, activeTargetSession);
}

function stampArtifactTargetSessionForRuntime(artifact: any, platformModeState: any, activeTargetSession: any): any {
  if (!artifact || typeof artifact !== "object") return artifact;
  const runtimeTargetSession = resolveRuntimeTargetSessionStamp(platformModeState, activeTargetSession);
  if (!runtimeTargetSession) {
    if (artifact.targetSession) {
      delete artifact.targetSession;
    }
    return artifact;
  }

  artifact.targetSession = runtimeTargetSession;
  return artifact;
}

function isPrometheusAnalysisAlignedToRuntime(prometheusAnalysis: any, platformModeState: any, activeTargetSession: any): boolean {
  return isRuntimeTargetSessionAlignedArtifact(prometheusAnalysis, platformModeState, activeTargetSession);
}

function stampPrometheusAnalysisTargetSession(config: any, prometheusAnalysis: any): any {
  return stampArtifactTargetSessionForRuntime(
    prometheusAnalysis,
    config?.platformModeState,
    config?.activeTargetSession,
  );
}

async function prepareTerminalTargetCompletionFreeze(
  config: any,
  platformModeState: any,
  activeTargetSession: any,
): Promise<{ action: "stop"; message: string } | null> {
  const stateDir = config?.paths?.stateDir || "state";
  const persistedDeliveryHandoff = await readJson(path.join(stateDir, "last_target_delivery_handoff.json"), null);
  const persistedHandoffSummary = String(
    persistedDeliveryHandoff?.summary
    || persistedDeliveryHandoff?.delivery?.userMessage
    || "",
  ).trim();
  const completedStages = new Set([
    TARGET_SESSION_STAGE.COMPLETED,
    TARGET_SESSION_STAGE.COMPLETED_WITH_HANDOFF,
  ]);

  if (
    activeTargetSession
    && completedStages.has(String(activeTargetSession.currentStage || "") as any)
    && persistedDeliveryHandoff?.projectId === activeTargetSession.projectId
    && persistedDeliveryHandoff?.sessionId === activeTargetSession.sessionId
    && persistedHandoffSummary
  ) {
    const archivedSession = await archiveTargetSession(config, {
      completionStage: activeTargetSession.currentStage,
      completionReason: activeTargetSession.lifecycle?.completionReason || `session_closed:${activeTargetSession.currentStage}`,
      completionSummary: activeTargetSession.handoff?.carriedContextSummary || persistedHandoffSummary || activeTargetSession.objective?.summary || null,
    });
    const refreshedModeState = await loadPlatformModeState(config);
    bindRuntimeTargetContext(config, refreshedModeState, null);
    return {
      action: "stop",
      message: `archived completed target session ${archivedSession.sessionId}`,
    };
  }

  if (platformModeState?.currentMode !== PLATFORM_MODE.IDLE || activeTargetSession) {
    return null;
  }

  const archivedTargetSession = await loadLastArchivedTargetSession(config);
  if (
    !archivedTargetSession
    || !completedStages.has(String(archivedTargetSession.currentStage || "") as any)
    || persistedDeliveryHandoff?.projectId !== archivedTargetSession.projectId
    || persistedDeliveryHandoff?.sessionId !== archivedTargetSession.sessionId
    || !persistedHandoffSummary
  ) {
    return null;
  }

  bindRuntimeTargetContext(config, platformModeState, null);
  return {
    action: "stop",
    message: `terminal target handoff already completed for session ${archivedTargetSession.sessionId}`,
  };
}

async function prepareTargetSessionForCycle(config: any): Promise<{ action: "continue" | "wait" | "stop"; message?: string }> {
  const platformModeState = await loadPlatformModeState(config);
  let activeTargetSession = await loadActiveTargetSession(config);
  bindRuntimeTargetContext(config, platformModeState, activeTargetSession);

  const terminalTargetFreeze = await prepareTerminalTargetCompletionFreeze(
    config,
    platformModeState,
    activeTargetSession,
  );
  if (terminalTargetFreeze) {
    return terminalTargetFreeze;
  }

  if (platformModeState.currentMode !== PLATFORM_MODE.SINGLE_TARGET_DELIVERY) {
    return { action: "continue" };
  }
  if (!activeTargetSession) {
    return { action: "wait", message: "single_target_delivery mode active without an open target session" };
  }

  try {
    const stateDir = config?.paths?.stateDir || "state";
    const persistedTargetSuccessReport = await readJson(path.join(stateDir, "last_target_project_readiness.json"), null);
    const persistedDeliveryHandoff = await readJson(path.join(stateDir, "last_target_delivery_handoff.json"), null);
    const persistedReportMatchesSession = persistedTargetSuccessReport
      && persistedTargetSuccessReport.projectId === activeTargetSession.projectId
      && persistedTargetSuccessReport.sessionId === activeTargetSession.sessionId;
    const persistedHandoffMatchesSession = persistedDeliveryHandoff
      && persistedDeliveryHandoff.projectId === activeTargetSession.projectId
      && persistedDeliveryHandoff.sessionId === activeTargetSession.sessionId;
    const persistedHandoffSummary = String(
      persistedDeliveryHandoff?.summary
      || persistedDeliveryHandoff?.delivery?.userMessage
      || "",
    ).trim();
    if (persistedHandoffMatchesSession && persistedHandoffSummary) {
      activeTargetSession = await transitionActiveTargetSession(config, {
        nextStage: TARGET_SESSION_STAGE.COMPLETED,
        actor: "target_delivery_handoff_guard",
        reason: "target_delivery_handoff_presented",
        nextAction: "await_next_target",
        handoff: {
          carriedContextSummary: persistedHandoffSummary,
          requiredHumanInputs: [],
        },
      });
      bindRuntimeTargetContext(config, platformModeState, activeTargetSession);
      await appendProgress(
        config,
        `[TARGET_SESSION] delivery handoff guard engaged session=${activeTargetSession.sessionId} stage=${activeTargetSession.currentStage} source=persisted_handoff`,
      );
    } else {
      const computedTargetSuccessReport = await evaluateTargetSuccessContract(config, activeTargetSession);
      await persistTargetSuccessContract(config, computedTargetSuccessReport);
      const targetSuccessReport = persistedReportMatchesSession && isTargetSuccessContractTerminal(persistedTargetSuccessReport)
        ? persistedTargetSuccessReport
        : computedTargetSuccessReport;
      if (isTargetSuccessContractTerminal(targetSuccessReport)) {
        const handoff = await performTargetDeliveryHandoff(config, targetSuccessReport);
        activeTargetSession = await transitionActiveTargetSession(config, {
          nextStage: String(targetSuccessReport?.status || "") === TARGET_SUCCESS_CONTRACT_STATUS.FULFILLED_WITH_HANDOFF
            ? TARGET_SESSION_STAGE.COMPLETED_WITH_HANDOFF
            : TARGET_SESSION_STAGE.COMPLETED,
          actor: "target_success_contract",
          reason: String(targetSuccessReport?.status || "") === TARGET_SUCCESS_CONTRACT_STATUS.FULFILLED_WITH_HANDOFF
            ? "target_delivery_handoff_completed"
            : "target_success_contract_fulfilled",
          nextAction: "await_next_target",
          handoff: {
            carriedContextSummary: handoff?.summary || targetSuccessReport?.summary || activeTargetSession.objective?.summary || null,
            requiredHumanInputs: Array.isArray(targetSuccessReport?.pendingHumanInputs)
              ? targetSuccessReport.pendingHumanInputs
              : [],
          },
        });
        bindRuntimeTargetContext(config, platformModeState, activeTargetSession);
        await appendProgress(
          config,
          `[TARGET_SESSION] terminal success guard engaged session=${activeTargetSession.sessionId} stage=${activeTargetSession.currentStage} status=${String(targetSuccessReport?.status || "unknown")} source=${persistedReportMatchesSession && isTargetSuccessContractTerminal(persistedTargetSuccessReport) ? "persisted" : "computed"}`,
        );
      }
    }
  } catch (error) {
    warn(`[orchestrator] target success guard failed: ${String((error as Error)?.message || error)}`);
  }

  if (activeTargetSession.currentStage === TARGET_SESSION_STAGE.ONBOARDING) {
    const onboardingAgentContractResult = validateRequiredAgentContracts([TARGET_ONBOARDING_AGENT_SLUG]);
    if (!onboardingAgentContractResult.allValid) {
      const firstViolation = onboardingAgentContractResult.violations[0];
      const violations = Array.isArray(firstViolation?.violations) ? firstViolation.violations.join(",") : "unknown";
      throw new Error(`Onboarding agent contract invalid: slug=${String(firstViolation?.slug || TARGET_ONBOARDING_AGENT_SLUG)} violations=${violations}`);
    }
    const onboardingResult = await runTargetOnboarding(config, activeTargetSession);
    activeTargetSession = onboardingResult.session;
    bindRuntimeTargetContext(config, platformModeState, activeTargetSession);
    if (
      activeTargetSession.currentStage !== TARGET_SESSION_STAGE.SHADOW
      && activeTargetSession.currentStage !== TARGET_SESSION_STAGE.ACTIVE
    ) {
      return {
        action: "wait",
        message: `onboarding gated target session at stage=${activeTargetSession.currentStage}`,
      };
    }
  }

  if (
    activeTargetSession.currentStage === TARGET_SESSION_STAGE.AWAITING_CREDENTIALS
    || activeTargetSession.currentStage === TARGET_SESSION_STAGE.AWAITING_MANUAL_STEP
  ) {
    const refreshedReadiness = await refreshTargetSessionReadiness(config, activeTargetSession);
    activeTargetSession = refreshedReadiness.session;
    bindRuntimeTargetContext(config, platformModeState, activeTargetSession);
    if (
      activeTargetSession.currentStage !== TARGET_SESSION_STAGE.SHADOW
      && activeTargetSession.currentStage !== TARGET_SESSION_STAGE.ACTIVE
    ) {
      return {
        action: "wait",
        message: `target session waiting at stage=${activeTargetSession.currentStage}`,
      };
    }
  }

  if (
    activeTargetSession.currentStage === TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION
    || activeTargetSession.currentStage === TARGET_SESSION_STAGE.AWAITING_CREDENTIALS
    || activeTargetSession.currentStage === TARGET_SESSION_STAGE.AWAITING_MANUAL_STEP
    || activeTargetSession.currentStage === TARGET_SESSION_STAGE.QUARANTINED
  ) {
    return {
      action: "wait",
      message: `target session waiting at stage=${activeTargetSession.currentStage}`,
    };
  }

  if (
    activeTargetSession.currentStage === TARGET_SESSION_STAGE.COMPLETED
    || activeTargetSession.currentStage === TARGET_SESSION_STAGE.COMPLETED_WITH_HANDOFF
  ) {
    const archivedSession = await archiveTargetSession(config, {
      completionStage: activeTargetSession.currentStage,
      completionReason: activeTargetSession.lifecycle?.completionReason || `session_closed:${activeTargetSession.currentStage}`,
      completionSummary: activeTargetSession.handoff?.carriedContextSummary || activeTargetSession.objective?.summary || null,
    });
    const refreshedModeState = await loadPlatformModeState(config);
    bindRuntimeTargetContext(config, refreshedModeState, null);
    return {
      action: "wait",
      message: `archived closed target session ${archivedSession.sessionId}`,
    };
  }

  return { action: "continue" };
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function buildSingleTargetAthenaFeedbackText(planReview: any): string {
  const reasonCode = String(planReview?.reason?.code || "");
  const reasonMessage = String(planReview?.reason?.message || planReview?.summary || "");
  const corrections = normalizeStringArray(planReview?.corrections);
  return [reasonCode, reasonMessage, ...corrections].join(" ").toLowerCase();
}

export function classifySingleTargetAthenaFeedback(planReview: any, activeTargetSession: any): string {
  const text = buildSingleTargetAthenaFeedbackText(planReview);
  const reasonCode = String(planReview?.reason?.code || "").trim();
  const repoState = String(activeTargetSession?.intent?.repoState || activeTargetSession?.repoProfile?.repoState || "unknown").trim().toLowerCase();

  if (/(intent|clarif|unclear|ambiguous|product|goal|user(s)?|scope|must-have|success criteria)/i.test(text)) {
    return TARGET_FEEDBACK_CATEGORY.INTENT;
  }

  if (/(research|source|evidence|external|benchmark|discovery|unknown stack|architecture|framework|integration|hosting|deployment)/i.test(text)) {
    return TARGET_FEEDBACK_CATEGORY.RESEARCH;
  }

  if (
    repoState === "empty"
    && [
      ATHENA_PLAN_REVIEW_REASON_CODE.LOW_PLAN_QUALITY,
      ATHENA_PLAN_REVIEW_REASON_CODE.MISSING_PREMORTEM,
      ATHENA_PLAN_REVIEW_REASON_CODE.MANDATORY_COVERAGE_INCOMPLETE,
    ].includes(reasonCode as any)
    && /(stack|architecture|framework|integration|deployment|mvp|bootstrap)/i.test(text)
  ) {
    return TARGET_FEEDBACK_CATEGORY.RESEARCH;
  }

  return TARGET_FEEDBACK_CATEGORY.PLANNING;
}

function buildPlanningRetryAction(session: any): string {
  return session?.currentStage === TARGET_SESSION_STAGE.ACTIVE
    ? "run_active_planning"
    : "run_shadow_planning";
}

export function shouldPromoteShadowSessionAfterCleanWave(input: {
  config: any;
  batch: any;
  workerResult: any;
  workerBatches: any[];
  completedBatchIndex: number;
}): boolean {
  const config = input?.config;
  const activeTargetSession = config?.activeTargetSession;
  if (config?.platformModeState?.currentMode !== PLATFORM_MODE.SINGLE_TARGET_DELIVERY) return false;
  if (!activeTargetSession || activeTargetSession.currentStage !== TARGET_SESSION_STAGE.SHADOW) return false;
  if (activeTargetSession.gates?.allowShadowExecution !== true) return false;
  if (String(input?.workerResult?.status || "").toLowerCase() !== "done") return false;

  const completedWave = Number(input?.batch?.wave || 0);
  if (completedWave !== 1) return false;

  const workerBatches = Array.isArray(input?.workerBatches) ? input.workerBatches : [];
  const nextBatch = workerBatches[Number(input?.completedBatchIndex ?? -1) + 1] || null;
  const nextWave = Number(nextBatch?.wave || completedWave);
  return !nextBatch || nextWave > completedWave;
}

export async function promoteShadowSessionToActiveAfterCleanWave(config: any, input: {
  batch: any;
  workerResult: any;
  workerBatches: any[];
  completedBatchIndex: number;
}) {
  if (!shouldPromoteShadowSessionAfterCleanWave({ config, ...input })) {
    return null;
  }

  const transitioned = await transitionActiveTargetSession(config, {
    nextStage: TARGET_SESSION_STAGE.ACTIVE,
    actor: "shadow_wave_promotion",
    reason: "first_wave_clean",
    nextAction: "run_active_planning",
    handoff: {
      carriedContextSummary: "Shadow wave 1 completed cleanly; promote session to active execution for broader scoped delivery.",
    },
  });

  bindRuntimeTargetContext(config, config.platformModeState, transitioned);
  await appendProgress(
    config,
    `[TARGET_SESSION] promoted to active after clean wave 1 session=${transitioned.sessionId} projectId=${transitioned.projectId}`,
    {
      projectId: transitioned.projectId,
      sessionId: transitioned.sessionId,
    },
  );
  return transitioned;
}

async function persistSingleTargetAthenaFeedback(config: any, planReview: any): Promise<any | null> {
  if (config?.platformModeState?.currentMode !== PLATFORM_MODE.SINGLE_TARGET_DELIVERY) {
    return null;
  }

  const activeTargetSession = await loadActiveTargetSession(config);
  if (!activeTargetSession) {
    return null;
  }

  const category = classifySingleTargetAthenaFeedback(planReview, activeTargetSession);
  const corrections = normalizeStringArray(planReview?.corrections);
  const reasonCode = String(planReview?.reason?.code || "PLAN_REJECTED").trim() || "PLAN_REJECTED";
  const reasonMessage = String(planReview?.reason?.message || planReview?.summary || "Rejected by Athena").trim() || "Rejected by Athena";
  const reviewSnapshot = {
    status: planReview?.approved === true ? "approved" : "rejected",
    category,
    code: reasonCode,
    message: reasonMessage,
    corrections,
    updatedAt: new Date().toISOString(),
  };
  const carriedContextSummary = `Athena rejected target plan (${category}) — ${reasonMessage}`;

  if (category === TARGET_FEEDBACK_CATEGORY.INTENT) {
    const transitioned = await transitionActiveTargetSession(config, {
      nextStage: TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION,
      actor: "athena_feedback",
      nextAction: "run_onboarding_clarification",
      handoff: {
        carriedContextSummary,
        requiredHumanInputs: corrections,
      },
      gates: {
        allowPlanning: false,
        allowShadowExecution: false,
        allowActiveExecution: false,
      },
    });

    return saveActiveTargetSession(config, {
      ...transitioned,
      clarification: {
        ...transitioned.clarification,
        status: "needs_follow_up",
        readyForPlanning: false,
        pendingQuestions: uniqueStrings([
          ...normalizeStringArray(transitioned.clarification?.pendingQuestions),
          ...corrections,
        ]).slice(0, 6),
      },
      intent: {
        ...transitioned.intent,
        status: TARGET_INTENT_STATUS.CLARIFYING,
        openQuestions: uniqueStrings([
          ...normalizeStringArray(transitioned.intent?.openQuestions),
          ...corrections,
        ]).slice(0, 6),
        updatedAt: new Date().toISOString(),
      },
      feedback: {
        pendingResearchRefresh: false,
        pendingIntentClarification: true,
        lastAthenaReview: reviewSnapshot,
      },
    });
  }

  return saveActiveTargetSession(config, {
    ...activeTargetSession,
    lifecycle: {
      ...activeTargetSession.lifecycle,
      updatedAt: new Date().toISOString(),
    },
    handoff: {
      ...activeTargetSession.handoff,
      carriedContextSummary,
      requiredHumanInputs: category === TARGET_FEEDBACK_CATEGORY.RESEARCH ? [] : corrections,
      lastAction: `athena_rejected:${category}`,
      nextAction: category === TARGET_FEEDBACK_CATEGORY.RESEARCH
        ? "run_target_research_refresh"
        : buildPlanningRetryAction(activeTargetSession),
    },
    feedback: {
      pendingResearchRefresh: category === TARGET_FEEDBACK_CATEGORY.RESEARCH,
      pendingIntentClarification: false,
      lastAthenaReview: reviewSnapshot,
    },
  });
}

async function clearSingleTargetFeedbackFlags(config: any, reviewStatus: "approved" | "rejected" = "approved"): Promise<void> {
  if (config?.platformModeState?.currentMode !== PLATFORM_MODE.SINGLE_TARGET_DELIVERY) {
    return;
  }

  const activeTargetSession = await loadActiveTargetSession(config);
  if (!activeTargetSession) {
    return;
  }

  await saveActiveTargetSession(config, {
    ...activeTargetSession,
    lifecycle: {
      ...activeTargetSession.lifecycle,
      updatedAt: new Date().toISOString(),
    },
    feedback: {
      pendingResearchRefresh: false,
      pendingIntentClarification: false,
      lastAthenaReview: {
        ...activeTargetSession.feedback?.lastAthenaReview,
        status: reviewStatus,
        updatedAt: new Date().toISOString(),
      },
    },
  });
}

export interface CloudAgentGovernanceProfileContract {
  profilePath: string;
  loaded: boolean;
  workflowDispatchEnabled: boolean;
  pullRequestEnabled: boolean;
  setupJobPresent: boolean;
  setupJobKeys: string[];
  validationTools: string[];
  violations: string[];
}

export async function readCloudAgentGovernanceProfileContract(config): Promise<CloudAgentGovernanceProfileContract> {
  const profilePath = String(
    config?.paths?.copilotSetupWorkflowFile
    || path.join(String(config?.rootDir || process.cwd()), ".github", "workflows", "copilot-setup-steps.yml")
  );
  const result: CloudAgentGovernanceProfileContract = {
    profilePath,
    loaded: false,
    workflowDispatchEnabled: false,
    pullRequestEnabled: false,
    setupJobPresent: false,
    setupJobKeys: [],
    validationTools: [],
    violations: [],
  };

  let raw: string;
  try {
    raw = await fs.readFile(profilePath, "utf8");
    result.loaded = true;
  } catch {
    result.violations.push("profile_missing");
    return result;
  }

  const lines = raw.split(/\r?\n/);
  const trimComment = (line: string): string => String(line || "").replace(/\s+#.*$/, "");
  const keyMatch = (line: string): { indent: number; key: string } | null => {
    const m = /^(\s*)([A-Za-z0-9_-]+)\s*:/.exec(trimComment(line));
    if (!m) return null;
    return { indent: m[1].length, key: m[2] };
  };

  const onLineIndex = lines.findIndex((line) => /^\s*on\s*:/i.test(trimComment(line)));
  if (onLineIndex >= 0) {
    const onMatch = keyMatch(lines[onLineIndex]);
    const onIndent = onMatch ? onMatch.indent : 0;
    for (let i = onLineIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!String(line || "").trim() || /^\s*#/.test(line)) continue;
      const km = keyMatch(line);
      if (!km) continue;
      if (km.indent <= onIndent) break;
      if (km.key === "workflow_dispatch") result.workflowDispatchEnabled = true;
      if (km.key === "pull_request") result.pullRequestEnabled = true;
    }
  }
  if (!result.workflowDispatchEnabled) result.violations.push("workflow_approval_missing_workflow_dispatch");
  if (!result.pullRequestEnabled) result.violations.push("workflow_approval_missing_pull_request");

  const setupJobIndex = lines.findIndex((line) => /^\s*copilot-setup-steps\s*:/i.test(trimComment(line)));
  if (setupJobIndex < 0) {
    result.violations.push("setup_job_missing");
    return result;
  }
  result.setupJobPresent = true;
  const setupJobMatch = keyMatch(lines[setupJobIndex]);
  const setupJobIndent = setupJobMatch ? setupJobMatch.indent : 0;

  let immediateChildIndent = -1;
  for (let i = setupJobIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!String(line || "").trim() || /^\s*#/.test(line)) continue;
    const km = keyMatch(line);
    if (!km) continue;
    if (km.indent <= setupJobIndent) break;
    if (immediateChildIndent === -1) immediateChildIndent = km.indent;
    if (km.indent === immediateChildIndent) {
      result.setupJobKeys.push(km.key);
      if (!CLOUD_AGENT_ALLOWED_SETUP_JOB_KEYS.has(km.key)) {
        result.violations.push(`setup_job_unsupported_key:${km.key}`);
      }
    }
  }

  for (let i = setupJobIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const km = keyMatch(line);
    if (km && km.indent <= setupJobIndent) break;
    const runInline = /^(\s*)run\s*:\s*(.+)\s*$/i.exec(trimComment(line));
    if (!runInline) continue;
    const runIndent = runInline[1].length;
    const runValue = String(runInline[2] || "").trim();
    if (runValue === "|" || runValue === ">") {
      for (let j = i + 1; j < lines.length; j++) {
        const nestedLine = lines[j];
        const nestedKey = keyMatch(nestedLine);
        if (nestedKey && nestedKey.indent <= runIndent) break;
        if (/^\s*-\s+/.test(nestedLine)) break;
        const cmd = String(nestedLine || "").trim();
        if (!cmd || cmd.startsWith("#")) continue;
        result.validationTools.push(cmd);
      }
    } else if (runValue) {
      result.validationTools.push(runValue);
    }
  }

  if (result.validationTools.length === 0) {
    result.violations.push("validation_tools_missing");
  }

  return result;
}

/**
 * Parse Athena correction text and map governance correction tokens to a
 * canonical dispatch block reason prefix.
 */
export function resolveAthenaCorrectionDispatchBlockReason(corrections: unknown): string | null {
  const correctionStrings = Array.isArray(corrections)
    ? corrections.map((entry) => String(entry || "").toLowerCase())
    : [String(corrections || "").toLowerCase()];
  let selected: { token: string; blockReason: string; gateKey: keyof typeof GATE_PRECEDENCE; gateIndex: number } | null = null;
  for (const [token, mapped] of Object.entries(
    GOVERNANCE_SIGNAL_REGISTRY as Record<string, { gateKey: string; dispatchBlockReason?: string; blocking?: boolean }>,
  )) {
    if (mapped?.blocking !== true || !mapped?.dispatchBlockReason) continue;
    if (!(mapped.gateKey in GATE_PRECEDENCE)) continue;
    const tokenPattern = new RegExp(`(^|[^a-z0-9_])${token}(?=$|[^a-z0-9_])`, "i");
    const found = correctionStrings.some((line) => tokenPattern.test(line));
    if (!found) continue;
    const gateIndex = GATE_PRECEDENCE[mapped.gateKey as keyof typeof GATE_PRECEDENCE];
    if (!selected || gateIndex < selected.gateIndex) {
      selected = {
        token,
        blockReason: mapped.dispatchBlockReason,
        gateKey: mapped.gateKey as keyof typeof GATE_PRECEDENCE,
        gateIndex,
      };
    }
  }
  if (!selected) return null;
  return `${selected.blockReason}:athena_correction_token=${selected.token}`;
}

/**
 * Health divergence state enum.
 * Describes how operational health (orchestrator) and planner health (Prometheus) relate.
 *
 *   none                       — both agree on a healthy state; no warning needed
 *   planner_warning            — orchestrator is operational but planner reports needs-work
 *   planner_critical           — orchestrator is operational but planner reports critical
 *   operational_degraded_planner_ok — orchestrator is degraded but planner reports good
 *   both_degraded              — orchestrator is degraded AND planner reports needs-work/critical
 *   unknown                    — insufficient data to determine divergence
 */
export const HEALTH_DIVERGENCE_STATE = Object.freeze({
  NONE:                          "none",
  PLANNER_WARNING:               "planner_warning",
  PLANNER_CRITICAL:              "planner_critical",
  OPERATIONAL_DEGRADED_PLANNER_OK: "operational_degraded_planner_ok",
  BOTH_DEGRADED:                 "both_degraded",
  UNKNOWN:                       "unknown",
});

/**
 * Resolved pipeline status values produced by the health divergence mapping.
 * These represent the single authoritative status a consumer should act on
 * when operational and planner health must be reconciled.
 */
export const PIPELINE_HEALTH_STATUS = Object.freeze({
  HEALTHY:  "healthy",
  WARNING:  "warning",
  CRITICAL: "critical",
  UNKNOWN:  "unknown",
});

/**
 * Compare operational health (orchestrator status) with planner health (Prometheus
 * projectHealth) and return a deterministic divergence record.
 *
 * Exported so tests and downstream consumers can verify the mapping logic.
 *
 * @param {string} operationalStatus — "operational" | "degraded" | unknown string
 * @param {string} plannerHealth     — "good" | "needs-work" | "critical" | unknown string
 * @param {string} plannerTruthStatus — "live" | "historical" | unknown
 * @returns {{ divergenceState, pipelineStatus, operationalStatus, plannerHealth, plannerTruthStatus, isWarning }}
 */
export function computeHealthDivergence(operationalStatus, plannerHealth, plannerTruthStatus: string = "live") {
  const opStatus = String(operationalStatus || "").toLowerCase().trim();
  // Normalize aliases: "healthy" → "good", "warning" → "needs-work"
  // so planner outputs using the prompt schema form are handled correctly.
  const phRaw = String(plannerHealth || "").toLowerCase().trim();
  const phStatus = phRaw === "healthy" ? "good" : phRaw === "warning" ? "needs-work" : phRaw;
  const truthStatusRaw = String(plannerTruthStatus || "").toLowerCase().trim();
  const truthStatus = truthStatusRaw === "live" || truthStatusRaw === "historical" ? truthStatusRaw : "unknown";

  const isOperational = opStatus === ORCHESTRATOR_STATUS.OPERATIONAL;
  const isDegraded    = opStatus === ORCHESTRATOR_STATUS.DEGRADED;
  const isGood        = phStatus === "good";
  const isNeedsWork   = phStatus === "needs-work";
  const isCritical    = phStatus === "critical";

  if (truthStatus !== "live") {
    return {
      divergenceState: HEALTH_DIVERGENCE_STATE.UNKNOWN,
      pipelineStatus:  PIPELINE_HEALTH_STATUS.UNKNOWN,
      operationalStatus: opStatus || "unknown",
      plannerHealth:     phStatus || "unknown",
      plannerTruthStatus: truthStatus,
      isWarning: false,
    };
  }

  if (isDegraded && (isNeedsWork || isCritical)) {
    return {
      divergenceState: HEALTH_DIVERGENCE_STATE.BOTH_DEGRADED,
      pipelineStatus:  PIPELINE_HEALTH_STATUS.CRITICAL,
      operationalStatus: opStatus,
      plannerHealth:     phStatus,
      plannerTruthStatus: truthStatus,
      isWarning: true,
    };
  }

  if (isDegraded && isGood) {
    return {
      divergenceState: HEALTH_DIVERGENCE_STATE.OPERATIONAL_DEGRADED_PLANNER_OK,
      pipelineStatus:  PIPELINE_HEALTH_STATUS.WARNING,
      operationalStatus: opStatus,
      plannerHealth:     phStatus,
      plannerTruthStatus: truthStatus,
      isWarning: true,
    };
  }

  if (isOperational && isCritical) {
    return {
      divergenceState: HEALTH_DIVERGENCE_STATE.PLANNER_CRITICAL,
      pipelineStatus:  PIPELINE_HEALTH_STATUS.CRITICAL,
      operationalStatus: opStatus,
      plannerHealth:     phStatus,
      plannerTruthStatus: truthStatus,
      isWarning: true,
    };
  }

  if (isOperational && isNeedsWork) {
    return {
      divergenceState: HEALTH_DIVERGENCE_STATE.PLANNER_WARNING,
      pipelineStatus:  PIPELINE_HEALTH_STATUS.WARNING,
      operationalStatus: opStatus,
      plannerHealth:     phStatus,
      plannerTruthStatus: truthStatus,
      isWarning: true,
    };
  }

  if (isOperational && isGood) {
    return {
      divergenceState: HEALTH_DIVERGENCE_STATE.NONE,
      pipelineStatus:  PIPELINE_HEALTH_STATUS.HEALTHY,
      operationalStatus: opStatus,
      plannerHealth:     phStatus,
      plannerTruthStatus: truthStatus,
      isWarning: false,
    };
  }

  // No recognised combination matched — missing, null, or unrecognised inputs.
  return {
    divergenceState: HEALTH_DIVERGENCE_STATE.UNKNOWN,
    pipelineStatus:  PIPELINE_HEALTH_STATUS.UNKNOWN,
    operationalStatus: opStatus || "unknown",
    plannerHealth:     phStatus || "unknown",
    plannerTruthStatus: truthStatus,
    isWarning: false,
  };
}

/** Max automatic retries when a worker hits transient API errors (circuit breaker). */
const MAX_TRANSIENT_RETRIES = 3;

type RetryTelemetryContext = {
  premiumUsageData: any[];
  benchmarkGroundTruth: any;
};

async function loadRetryTelemetryContext(config): Promise<RetryTelemetryContext> {
  const stateDir = config?.paths?.stateDir || "state";
  try {
    const [premiumUsageData, benchmarkGroundTruth] = await Promise.all([
      readJson(path.join(stateDir, "premium_usage_log.json"), []),
      readJson(path.join(stateDir, "benchmark_ground_truth.json"), null),
    ]);
    return {
      premiumUsageData: Array.isArray(premiumUsageData) ? premiumUsageData : [],
      benchmarkGroundTruth,
    };
  } catch (err) {
    warn(`[orchestrator] retry telemetry load failed: ${String(err?.message || err)}`);
    return { premiumUsageData: [], benchmarkGroundTruth: null };
  }
}

type WorkerSessionRecord = {
  status?: string;
  [key: string]: unknown;
};

type GithubPullRequestSummary = {
  number?: number;
  title?: string;
  merged_at?: string | null;
  head?: {
    ref?: string;
  };
};

type GithubBranchSummary = {
  name?: string;
};

type CriticalReadResult = {
  ok: boolean;
  reason?: string;
  data?: unknown;
  error?: {
    message?: string;
  } | null;
};

function normalizeTopicLabel(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectBenchmarkLinkageTopicsFromBatches(workerBatches: any[]): Set<string> {
  const topics = new Set<string>();
  for (const batch of Array.isArray(workerBatches) ? workerBatches : []) {
    const plans = Array.isArray(batch?.plans) ? batch.plans : [batch];
    for (const plan of plans) {
      const linked = Array.isArray(plan?.synthesis_sources)
        ? plan.synthesis_sources
        : [];
      for (const item of linked) {
        const topic = normalizeTopicLabel(item);
        if (topic) topics.add(topic);
      }
    }
  }
  return topics;
}

function topicMatchInSet(topic: string, linkedTopics: Set<string>): boolean {
  if (!topic || linkedTopics.size === 0) return false;
  for (const linked of linkedTopics) {
    if (!linked) continue;
    if (linked === topic) return true;
    if (linked.length >= 12 && topic.includes(linked)) return true;
    if (topic.length >= 12 && linked.includes(topic)) return true;
  }
  return false;
}

export function autoResolveBenchmarkRecommendations(
  benchmarkEntries: any[],
  opts: { verifiedDoneWorkers: number; workerBatches: any[]; workerResults?: any[]; atIso: string }
): { entries: any[]; resolvedCount: number; usedFallback: boolean } {
  if (!Array.isArray(benchmarkEntries) || benchmarkEntries.length === 0) {
    return { entries: benchmarkEntries, resolvedCount: 0, usedFallback: false };
  }

  const latest = benchmarkEntries[0];
  const recs = Array.isArray(latest?.recommendations) ? latest.recommendations : [];
  if (recs.length === 0) {
    return { entries: benchmarkEntries, resolvedCount: 0, usedFallback: false };
  }

  const linkedTopics = collectBenchmarkLinkageTopicsFromBatches(opts.workerBatches);
  const pendingIndexes = recs
    .map((rec: any, idx: number) => ({ rec, idx }))
    .filter(({ rec }) => {
      const status = String(rec?.implementationStatus || "pending").toLowerCase().trim();
      return status === "pending" || status === "in-progress" || status === "unknown";
    });
  if (pendingIndexes.length === 0) {
    return { entries: benchmarkEntries, resolvedCount: 0, usedFallback: false };
  }

  // Build lookup of done workers with verification evidence by synthesis source topic.
  const verifiedWorkerTopics = new Set<string>();
  const workerResultsArr = Array.isArray(opts.workerResults) ? opts.workerResults : [];
  for (const wr of workerResultsArr) {
    if (String(wr?.status || "").toLowerCase() !== "done") continue;
    if (wr?.dispatchContract?.doneWorkerWithVerificationReportEvidence !== true) continue;
    for (const src of (Array.isArray(wr?.synthesisSources) ? wr.synthesisSources : [])) {
      verifiedWorkerTopics.add(normalizeTopicLabel(String(src || "")));
    }
  }

  const nextRecs = [...recs];
  let resolvedCount = 0;
  const resolvedIdxs = new Set<number>();

  for (const { rec, idx } of pendingIndexes) {
    const topic = normalizeTopicLabel(rec?.topic || rec?.summary || rec?.id || "");
    if (!topicMatchInSet(topic, linkedTopics)) continue;
    const prevEvidence = String(rec?.evidence || "").trim();
    // Use "implemented_correctly" when a verified worker with verification report
    // evidence explicitly matches this topic; fall back to "implemented" otherwise.
    const resolvedStatus = verifiedWorkerTopics.has(topic) ? "implemented_correctly" : "implemented";
    nextRecs[idx] = {
      ...rec,
      implementationStatus: resolvedStatus,
      evidence: prevEvidence
        ? `${prevEvidence}; auto-resolved@${opts.atIso}: linked synthesis_sources match`
        : `auto-resolved@${opts.atIso}: linked synthesis_sources match`,
    };
    resolvedIdxs.add(idx);
    resolvedCount += 1;
  }

  // Partial fallback removed: promoting recommendations on generic worker completion
  // with no topic linkage is causally incorrect.  Only explicit synthesis_sources
  // matches (collected above) are accepted as resolution evidence.
  const usedFallback = false;

  const nextEntries = [...benchmarkEntries];
  nextEntries[0] = {
    ...latest,
    recommendations: nextRecs,
    evaluatedAt: opts.atIso,
  };
  return { entries: nextEntries, resolvedCount, usedFallback };
}

type PlanNoveltyFilterResult = {
  actionablePlans: any[];
  skippedPlans: Array<{ plan: any; reason: string }>;
};

async function filterAlreadyImplementedPlans(stateDir: string, plans: any[]): Promise<PlanNoveltyFilterResult> {
  return applyPlanLifecycleAdmissionFilter(stateDir, plans);
}

function buildNoveltyReplanPrompt(basePrompt: string, skippedPlans: Array<{ plan: any; reason: string }>): string {
  const skippedList = skippedPlans
    .slice(0, 20)
    .map((item, idx) => {
      const title = String(item?.plan?.title || item?.plan?.task || item?.plan?.task_id || `plan-${idx + 1}`);
      return `${idx + 1}. ${title} [${item.reason}]`;
    })
    .join("\n");

  return [
    String(basePrompt || "Full repository self-evolution analysis").trim(),
    "",
    "ADDITIONAL ORCHESTRATOR GATE CONTEXT:",
    "The following proposed plans are already closed, superseded, or already continuing in the same family. Do not reopen them as net-new work:",
    skippedList || "(none)",
    "",
    "MANDATORY OUTPUT UPDATE:",
    "- Return only net-new plans or delta plans for partially implemented capabilities.",
    "- If same-family work is already in progress, emit only a continuation/delta plan instead of reopening it as a new task.",
    "- For each plan include precise target files, acceptance criteria, and verification commands.",
    "- For each plan include implementationStatus and implementationEvidence.",
    "- If everything is already implemented correctly, return plans: [] and explain why.",
  ].join("\n");
}

function buildSourceLinkageReplanPrompt(basePrompt: string, topicCount: number): string {
  return [
    String(basePrompt || "Full repository self-evolution analysis").trim(),
    "",
    "ADDITIONAL ORCHESTRATOR GATE CONTEXT:",
    `Latest plan batch is blind to research context: researchContext.topicCount=${topicCount}, but no plan declared synthesis_sources and no informational_topics_consumed were emitted.`,
    "This causes low-relevance planning and backlog stagnation.",
    "",
    "MANDATORY OUTPUT UPDATE:",
    "- Every plan that uses research context MUST include synthesis_sources with one or more exact topic names from RESEARCH INTELLIGENCE.",
    "- Any topic reviewed but not converted into a plan MUST be listed in informational_topics_consumed.",
    "- Do not leave both fields empty when researchContext.topicCount > 0.",
    "- Keep plans actionable with deterministic verification commands.",
  ].join("\n");
}

/** Write orchestrator health record to state/orchestrator_health.json. Exported for downstream use. */
export async function writeOrchestratorHealth(stateDir, status, reason, details = null) {
  await writeJson(path.join(stateDir, "orchestrator_health.json"), {
    orchestratorStatus: status,
    reason,
    details: details || null,
    recordedAt: new Date().toISOString()
  });
}

function normalizeCrossCycleDispatchPrerequisite(plan: Record<string, unknown>): {
  gateName: string;
  confirmationToken: string;
  source: string;
} | null {
  const raw = plan?.dispatchPrerequisite;
  const rawObject = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const gateName = String(rawObject?.gateName || rawObject?.gate || "").trim();
  const confirmationToken = String(rawObject?.confirmationToken || rawObject?.confirmation_token || "").trim();
  if (gateName) {
    return { gateName, confirmationToken, source: "dispatchPrerequisite" };
  }

  const dependencies = Array.isArray(plan?.dependencies) ? plan.dependencies : [];
  for (const dep of dependencies) {
    const parsed = extractCrossCycleDispatchPrerequisiteFromDependency(dep);
    if (parsed) {
      return {
        gateName: parsed.gateName,
        confirmationToken: parsed.confirmationToken,
        source: "dependencies",
      };
    }
  }

  return null;
}

/**
 * Typed envelope produced by evaluatePreDispatchGovernanceGate.
 *
 * Every field is guaranteed present on all return paths so dispatch and
 * telemetry consumers have a single, uniform surface regardless of which gate
 * fires.  Optional fields appear only when the corresponding gate activates.
 *
 * Consumed by:
 *   - Dispatch paths (runSingleCycle, runResumeDispatch) via `gateDecision.blocked`
 *   - Telemetry (emitEvent GOVERNANCE_GATE_EVALUATED) via `gateDecision.reason`
 */
export interface GovernanceBlockDecision {
  /** True when any gate blocked dispatch. False on pass-through. */
  blocked: boolean;
  /**
   * Machine-readable reason string. null when not blocked.
   * Blocked reasons are prefixed with a BLOCK_REASON constant followed by ':'
   * and dynamic detail so callers can `reason.startsWith(BLOCK_REASON.X)`.
   */
  reason: string | null;
  /** Post-block action taken (e.g. "rollback" on canary breach), undefined otherwise. */
  action: "rollback" | undefined;
  /** Explicit machine-readable dispatch block reason outcome. Mirrors `reason` when blocked, null otherwise. */
  dispatchBlockReason: string | null;
  /** Dependency graph resolution result. null when the graph was not evaluated. */
  graphResult: Record<string, unknown> | null;
  /** Dispatch cycle identifier carried through for telemetry correlation. */
  cycleId: string;
  /** Budget eligibility state at gate evaluation time. Always present for observability. */
  budgetEligibility: BudgetEligibilityContract;
  /**
   * Gate precedence index of the blocking gate (matches GATE_PRECEDENCE.*).
   * Absent (undefined) on non-blocked results.
   */
  gateIndex?: number;
  /**
   * Stable blocking gate identifier (GATE_PRECEDENCE key).
   * Consumers should prefer this over numeric gateIndex for long-term contracts.
   */
  gateKey?: keyof typeof GATE_PRECEDENCE;
  /** Rollback execution result. Present only on GOVERNANCE_CANARY_BREACH blocks. */
  rollbackResult?: Record<string, unknown>;
  /**
   * Ghost file paths from unresolved mandatory drift debt.
   * Present only on MANDATORY_DRIFT_DEBT_UNRESOLVED blocks.
   */
  mandatoryDriftPaths?: string[];
  /**
   * Readiness gate evaluation result.
   * Present only on DEPENDENCY_READINESS_INCOMPLETE blocks.
   */
  readinessResult?: ReadinessGateResult;
  /**
   * Rolling completion yield contract.
   * Present only on ROLLING_YIELD_THROTTLE blocks for observability.
   */
  rollingYieldContract?: RollingYieldContract;
}

/**
 * Attempt to rebatch an oversized plan set by reassigning _batchIndex values
 * so that no role-group batch exceeds `cap` ordered steps.
 *
 * Plans in the same original _batchIndex are processed role-by-role. Each role
 * group is greedily repacked into sub-batches. When earlier batches split,
 * subsequent batches shift their index upward to preserve global ordering.
 *
 * Mutates plans in place. Returns true when all groups now fit within cap
 * (safe to dispatch), false when any single plan already exceeds cap (hard limit).
 *
 * @param plans — normalized plan objects with _batchIndex / _batchWorkerRole set
 * @param cap   — max ordered steps per batch group
 */
function tryRebatchOversizedPlans(plans: any[], cap: number): boolean {
  if (!Array.isArray(plans) || plans.length === 0) return true;

  // Verify no individual plan exceeds the cap — that is a hard limit.
  for (const plan of plans) {
    const steps = Array.isArray(plan?.orderedSteps) ? plan.orderedSteps.length
      : Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria.length
      : 1;
    if (steps > cap) return false;
  }

  // Pre-group plans by original batch index BEFORE modifying any values.
  // This prevents later iterations from picking up in-place _batchIndex mutations.
  const origGroupMap = new Map<number, any[]>();
  for (const plan of plans) {
    const orig = Number(plan._batchIndex) || 1;
    if (!origGroupMap.has(orig)) origGroupMap.set(orig, []);
    origGroupMap.get(orig)!.push(plan);
  }

  // Process batch groups in ascending order.
  const origIndices = [...origGroupMap.keys()].sort((a, b) => a - b);
  let cumulativeShift = 0;

  for (const origBatch of origIndices) {
    const batchPlans = origGroupMap.get(origBatch)!;
    const assignedBatch = origBatch + cumulativeShift;

    // Group plans within this batch by role.
    const byRole = new Map<string, any[]>();
    for (const plan of batchPlans) {
      const role = String(plan._batchWorkerRole || plan.role || "unknown").toLowerCase();
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role)!.push(plan);
    }

    let maxSlotUsedInBatch = assignedBatch;

    for (const rolePlans of byRole.values()) {
      let currentSlot = assignedBatch;
      let currentSteps = 0;

      for (const plan of rolePlans) {
        const steps = Array.isArray(plan?.orderedSteps) ? plan.orderedSteps.length
          : Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria.length
          : 1;

        // Overflow: start a new sub-batch slot.
        if (currentSteps > 0 && currentSteps + steps > cap) {
          currentSlot++;
          currentSteps = 0;
        }

        plan._batchIndex = currentSlot;
        currentSteps += steps;
        if (currentSlot > maxSlotUsedInBatch) maxSlotUsedInBatch = currentSlot;
      }
    }

    cumulativeShift += maxSlotUsedInBatch - assignedBatch;
  }

  return true;
}

/**
 * Exported wrapper for tryRebatchOversizedPlans that returns a rich result
 * with rewrite tracking and batchTotal annotation for all plans.
 *
 * Returns:
 *   rewrote       — true when batch indices were reassigned due to overflow
 *   splitGroups   — number of original batch groups that were split
 *   batchCount    — total distinct batch indices after rebatch
 *   blockedReason — non-null when a single plan exceeds the cap and cannot be split
 *
 * Side-effect: mutates plan._batchIndex and sets plan._batchTotal on all plans.
 */
export function rebatchOversizedAthenaPlanGroupsForAdmission(
  plans: any[],
  maxAcPerBatch: number,
): { rewrote: boolean; splitGroups: number; batchCount: number; blockedReason: string | null } {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { rewrote: false, splitGroups: 0, batchCount: 0, blockedReason: null };
  }

  const origBatchCount = new Set(plans.map((p) => Number(p?._batchIndex) || 1)).size;

  // tryRebatchOversizedPlans returns false when any single plan exceeds cap.
  const rebatchOk = tryRebatchOversizedPlans(plans, maxAcPerBatch);
  if (!rebatchOk) {
    return {
      rewrote: false,
      splitGroups: 0,
      batchCount: origBatchCount,
      blockedReason: `ordered_step_complexity_unsplittable: a single plan exceeds the max ${maxAcPerBatch} step cap and cannot be split`,
    };
  }

  const newBatchCount = new Set(plans.map((p) => Number(p?._batchIndex) || 1)).size;
  const rewrote = newBatchCount > origBatchCount;
  const splitGroups = rewrote ? newBatchCount - origBatchCount : 0;

  for (const plan of plans) {
    plan._batchTotal = newBatchCount;
  }

  return { rewrote, splitGroups, batchCount: newBatchCount, blockedReason: null };
}

/**
 * Determine whether the lane-diversity hard gate should be bypassed.
 *
 * Bypass is safe when same-lane conflicts will be serialized into distinct
 * batches (so all plans still run, just in sequence rather than parallel).
 * This prevents the hard gate from blocking valid work when the pool has
 * fewer active lanes than minLanes purely because of conflict serialization.
 */
export function shouldBypassLaneDiversityHardGate(opts: {
  plans: unknown[];
  minLanes: number;
  capabilityPoolResult: ({ activeLaneCount?: number } & Record<string, unknown>) | null;
  laneConflicts: unknown[];
  workerTopology?: { continuation?: { preservesMultiLaneAdmission?: boolean; reason?: string; admittedLaneCount?: number; remainingLaneCount?: number; missingLanes?: string[] } | null } | null;
  admittedWorkerTopology?: { laneCount?: number } | null;
}): { bypass: boolean; reason: string | null } {
  const laneConflicts = Array.isArray(opts?.laneConflicts) ? opts.laneConflicts : [];
  const activeLaneCount = Number(opts?.capabilityPoolResult?.activeLaneCount ?? 0);
  const minLanes = Number(opts?.minLanes ?? 2);
  const continuation = opts?.workerTopology?.continuation;
  const admittedLaneCount = Number(opts?.admittedWorkerTopology?.laneCount ?? continuation?.admittedLaneCount ?? 0);

  if (
    continuation?.preservesMultiLaneAdmission === true
    && admittedLaneCount >= minLanes
    && activeLaneCount < minLanes
  ) {
    const missingLanes = Array.isArray(continuation?.missingLanes) ? continuation.missingLanes.join(",") : "";
    return {
      bypass: true,
      reason: `admitted_multi_lane_continuation:${String(continuation?.reason || "preserved_admitted_multi_lane_topology_for_continuation")};admitted=${admittedLaneCount};remaining=${Number(continuation?.remainingLaneCount ?? activeLaneCount)};missing=${missingLanes || "none"}`,
    };
  }

  if (laneConflicts.length > 0 && activeLaneCount < minLanes) {
    return {
      bypass: true,
      reason: "same_lane_conflicts_will_serialize_into_distinct_batches",
    };
  }
  return { bypass: false, reason: null };
}

/**
 * Determine whether the specialization admission gate should be bypassed.
 *
 * When the lane-diversity gate was bypassed due to serialized same-lane batch
 * topology, the specialization target becomes infeasible (all batches share one
 * lane, so specialist utilization cannot be distributed as required).
 */
export function shouldBypassSpecializationAdmissionGate(opts: {
  laneDiversityBypassReason: string | null;
  capabilityPoolResult: Record<string, unknown> | null;
  workerTopology?: { continuation?: { preservesMultiLaneAdmission?: boolean; admittedLaneCount?: number; remainingLaneCount?: number; missingLanes?: string[] } | null } | null;
  admittedWorkerTopology?: { laneCount?: number } | null;
}): { bypass: boolean; reason: string | null } {
  const continuation = opts?.workerTopology?.continuation;
  const admittedLaneCount = Number(opts?.admittedWorkerTopology?.laneCount ?? continuation?.admittedLaneCount ?? 0);
  if (continuation?.preservesMultiLaneAdmission === true && admittedLaneCount > 1) {
    const missingLanes = Array.isArray(continuation?.missingLanes) ? continuation.missingLanes.join(",") : "";
    return {
      bypass: true,
      reason: `admitted_multi_lane_specialization_continuation:admitted=${admittedLaneCount};remaining=${Number(continuation?.remainingLaneCount ?? 0)};missing=${missingLanes || "none"}`,
    };
  }
  if (
    String(opts?.laneDiversityBypassReason || "") ===
    "same_lane_conflicts_will_serialize_into_distinct_batches"
  ) {
    return {
      bypass: true,
      reason: "serialized_same_lane_batch_topology_makes_specialization_target_infeasible",
    };
  }
  return { bypass: false, reason: null };
}

function isExplicitNoSignalJudgeDecision(decision: any): boolean {
  const finalDecision = String(decision?.decision || "").trim().toLowerCase();
  const reason = String(decision?.reason || decision?.deterministicReason || "").trim().toLowerCase();
  return finalDecision === "hold"
    && (
      reason.startsWith("insufficient_sample:")
      || reason.startsWith("sample_guard:")
      || reason.includes("no_signal")
    );
}

function mapJudgeDecisionToOutcomeScore(decision: string, noSignalOutcome: boolean): number {
  if (noSignalOutcome) return 0.35;
  if (decision === "promote") return 1;
  if (decision === "hold") return 0.55;
  if (decision === "rework") return 0.25;
  return 0;
}

/**
 * Check whether a worker outcome should be treated as resume-preferred.
 *
 * PROCESS_TIMEOUT errors with retryClass=cooldown indicate the worker was
 * cut short mid-execution. The orchestrator should attempt to resume from
 * the existing dispatch checkpoint rather than starting a fresh cycle.
 */
export function isResumePreferredTimeoutOutcome(outcome: {
  status: string;
  reasonCode: string;
  retryClass?: string;
}): boolean {
  return (
    String(outcome?.status || "").toLowerCase() === "error" &&
    String(outcome?.reasonCode || "").toUpperCase() === "PROCESS_TIMEOUT"
  );
}

/**
 * Extract the mandatory findings preflight admission telemetry from a
 * Prometheus analysis result for orchestrator-level logging and audit.
 *
 * Returns a structured record that the caller can log via appendProgress.
 * Pure function — no I/O.  Exported for testing.
 *
 * @param prometheusAnalysis — return value of runPrometheusAnalysis
 * @returns telemetry record, or null when no preflight data is available
 */
export function extractMandatoryFindingsPreflightAdmissionTelemetry(
  prometheusAnalysis: unknown,
): {
  quarantinedCount: number;
  trustedCount: number;
  preflightStatus: string;
  sourceAgeMs: number | null;
  sourceFresh: boolean;
  quarantineReasons: string[];
} | null {
  if (!prometheusAnalysis || typeof prometheusAnalysis !== "object") return null;
  const preflightResult = (prometheusAnalysis as any)?.mandatoryTasks?.preflightResult;
  if (!preflightResult || typeof preflightResult !== "object") return null;

  const quarantinedCount = Number(preflightResult.quarantinedCount ?? 0);
  const trustedCount = Array.isArray(preflightResult.trustedFindings)
    ? preflightResult.trustedFindings.length
    : 0;
  const preflightStatus = String(preflightResult.preflightStatus || "unknown");
  const rawAgeMs = preflightResult.sourceAgeMs;
  // Infinity is not JSON-safe — normalize to null for logging/serialization; callers check sourceFresh instead
  const sourceAgeMs = Number.isFinite(rawAgeMs) ? Math.round(rawAgeMs) : null;
  const sourceFresh = preflightResult.sourceFresh === true;
  const quarantineReasons = Array.isArray(preflightResult.quarantineReasons)
    ? preflightResult.quarantineReasons.map((r: unknown) => String(r || "")).filter(Boolean)
    : [];

  return { quarantinedCount, trustedCount, preflightStatus, sourceAgeMs, sourceFresh, quarantineReasons };
}

/**
 * Promote Prometheus analysis plan entries to "implemented_correctly" when
 * matching done-worker rows supply verification report evidence.
 *
 * Matches plan.task against row.planTasks (case-insensitive). Only rows
 * where status=done AND doneWorkerWithVerificationReportEvidence=true
 * trigger a promotion. Unmatched plans are returned unchanged.
 */
export function promotePrometheusAnalysisFromWorkerEvidence(
  analysis: any,
  rows: any[],
  atIso: string,
): { promotedCount: number; analysis: any } {
  const plans = Array.isArray(analysis?.plans) ? analysis.plans : [];
  if (plans.length === 0 || !Array.isArray(rows) || rows.length === 0) {
    return { promotedCount: 0, analysis };
  }

  const taskToFiles = new Map<string, string[]>();
  for (const row of rows) {
    const status = String(row?.status || "").toLowerCase();
    if (status !== "done" && status !== "success") continue;
    if (row?.dispatchContract?.doneWorkerWithVerificationReportEvidence !== true) continue;
    const tasks = Array.isArray(row?.planTasks) ? row.planTasks : [];
    const files = Array.isArray(row?.filesTouched) ? row.filesTouched : [];
    for (const task of tasks) {
      const key = String(task || "").trim().toLowerCase();
      if (!key) continue;
      if (!taskToFiles.has(key)) taskToFiles.set(key, []);
      taskToFiles.get(key)!.push(...files);
    }
  }

  let promotedCount = 0;
  const nextPlans = plans.map((plan: any) => {
    const planTask = String(plan?.task || "").trim().toLowerCase();
    if (!planTask) return plan;
    if (String(plan?.implementationStatus || "").toLowerCase() === "implemented_correctly") return plan;
    const matchedFiles = taskToFiles.get(planTask);
    if (!matchedFiles || matchedFiles.length === 0) return plan;
    promotedCount++;
    const existingEvidence = Array.isArray(plan.implementationEvidence) ? plan.implementationEvidence : [];
    const newEvidence = [...new Set([...existingEvidence, ...matchedFiles])];
    return {
      ...plan,
      implementationStatus: "implemented_correctly",
      implementationEvidence: newEvidence,
      promotedAt: atIso,
    };
  });

  return { promotedCount, analysis: { ...analysis, plans: nextPlans } };
}

export function buildCycleWorkerResultRow(batch: any, workerResult: any): {
  roleName: string;
  status: string;
  taskKind: string;
  batchSize: number;
  orderedStepCount: number;
  contextUtilizationPercent: number | null;
  verificationEvidence?: unknown;
  dispatchContract?: {
    doneWorkerWithVerificationReportEvidence?: boolean;
    doneWorkerWithCleanTreeStatusEvidence?: boolean;
    dispatchBlockReason?: string | null;
    closureBoundaryViolation?: boolean;
    replayClosure?: {
      contractSatisfied?: boolean;
      canonicalCommands?: string[];
      executedCommands?: string[];
      rawArtifactEvidenceLinks?: string[];
    } | null;
  } | null;
  dispatchBlockReason?: string | null;
  closureBoundaryViolation?: boolean;
  planTasks: string[];
  filesTouched: string[];
  synthesisSources: string[];
} {
  const batchPlans = Array.isArray(batch?.plans) ? batch.plans : [];
  const planTasks: string[] = [...new Set<string>(
    batchPlans
      .map((plan: any) => String(plan?.task || "").trim())
      .filter(Boolean) as string[],
  )];
  const synthesisSources: string[] = [...new Set<string>(
    batchPlans.flatMap((plan: any) => (
      Array.isArray(plan?.synthesis_sources)
        ? plan.synthesis_sources.map((source: unknown) => String(source || "").trim()).filter(Boolean) as string[]
        : [] as string[]
    )),
  )];
  const filesTouched = Array.isArray(workerResult?.filesTouched)
    ? workerResult.filesTouched.map((file: unknown) => String(file || "").trim()).filter(Boolean)
    : [];

  return {
    roleName: String(workerResult?.roleName || batch?.role || "unknown"),
    status: String(workerResult?.status || "unknown"),
    taskKind: String(batch?.taskKind || "implementation"),
    batchSize: batchPlans.length,
    orderedStepCount: Number.isFinite(Number(batch?.orderedStepCount))
      ? Math.max(1, Math.floor(Number(batch.orderedStepCount)))
      : Math.max(1, batchPlans.length),
    contextUtilizationPercent: Number.isFinite(Number(batch?.contextUtilizationPercent))
      ? Math.max(0, Math.min(100, Number(batch.contextUtilizationPercent)))
      : null,
    verificationEvidence: workerResult?.verificationEvidence || null,
    dispatchContract: workerResult?.dispatchContract || null,
    dispatchBlockReason: workerResult?.dispatchBlockReason || null,
    closureBoundaryViolation: workerResult?.dispatchContract?.closureBoundaryViolation === true,
    planTasks,
    filesTouched,
    synthesisSources,
  };
}

/**
 * Exported for integration tests and any callers that need the dispatch decision
 * surface without running a full orchestration cycle.
 */
export async function evaluatePreDispatchGovernanceGate(
  config,
  plans = [],
  cycleId = "",
  driftReport: ArchitectureDriftReport | null = null,
  opts: { admittedWorkerTopology?: WorkerTopologyContract | null } = {},
): Promise<GovernanceBlockDecision> {
  const stateDir = config?.paths?.stateDir || "state";
  const normalizedPlans = Array.isArray(plans) ? plans : [];
  const admittedWorkerTopology = opts?.admittedWorkerTopology || null;
  const continuationTopology = buildWorkerTopologyContract(normalizedPlans, {
    admittedWorkerTopology,
  });

  // Bind deterministic named verification targets before any dispatch admission
  // checks so every downstream gate evaluates the canonical verification surface.
  bindNamedVerificationTargets(normalizedPlans);

  // ── Budget reconciliation — resolved upfront so every dispatch decision
  // carries a uniform BudgetEligibilityContract regardless of which gate fires.
  const budgetEligibility = await reconcileBudgetEligibility(config);
  if (budgetEligibility.configured && budgetEligibility.reason?.startsWith("budget_read_error")) {
    warn(`[orchestrator] budget gate failed (non-fatal): ${budgetEligibility.reason}`);
  }

  // ── Budget eligibility gate (hard gate — first check) ────────────────────
  // Fires immediately after reconciliation, before all other gates so that
  // budget exhaustion short-circuits every subsequent operation (including
  // expensive canary rollback and ledger reads) with a uniform block signal.
  if (!budgetEligibility.eligible) {
    return {
      blocked: true,
      reason: budgetEligibility.reason,
      action: undefined,
      dispatchBlockReason: budgetEligibility.reason,
      graphResult: null,
      cycleId,
      budgetEligibility,
      gateKey: "BUDGET_ELIGIBILITY",
      gateIndex: GATE_PRECEDENCE.BUDGET_ELIGIBILITY,
    };
  }

  if (config?.systemGuardian?.enabled !== false) {
    try {
      const pauseActive = await isGuardrailActive(config, GUARDRAIL_ACTION.PAUSE_WORKERS);
      if (pauseActive) {
        return {
          blocked: true,
          reason: BLOCK_REASON.GUARDRAIL_PAUSE_WORKERS_ACTIVE,
          action: undefined,
          dispatchBlockReason: BLOCK_REASON.GUARDRAIL_PAUSE_WORKERS_ACTIVE,
          graphResult: null,
          cycleId,
          budgetEligibility,
          gateKey: "GUARDRAIL_PAUSE",
          gateIndex: GATE_PRECEDENCE.GUARDRAIL_PAUSE,
        };
      }
    } catch (err) {
      warn(`[orchestrator] pre-dispatch guardrail check failed: ${String(err?.message || err)}`);
    }
  }

  try {
    const forceCheckpoint = await readForceCheckpointValidationContract(config);
    const hasSloBreachCheckpoint = forceCheckpoint.active
      && isSloCascadingBreachScenario(forceCheckpoint.scenarioId);
    if (hasSloBreachCheckpoint) {
      if (forceCheckpoint.overrideActive) {
        const auditPath = path.join(stateDir, "governance_gate_audit.jsonl");
        const entry = {
          ts: new Date().toISOString(),
          kind: "force_checkpoint_override",
          cycleId,
          scenarioId: forceCheckpoint.scenarioId,
          reason: forceCheckpoint.overrideReason || "override_active",
          by: forceCheckpoint.overrideBy || "unknown",
        };
        try {
          await fs.mkdir(path.dirname(auditPath), { recursive: true });
          await fs.appendFile(auditPath, `${JSON.stringify(entry)}\n`, "utf8");
        } catch (auditErr) {
          warn(`[orchestrator] force-checkpoint override audit write failed: ${String(auditErr?.message || auditErr)}`);
        }
      } else {
        return {
          blocked: true,
          reason: `${BLOCK_REASON.GUARDRAIL_FORCE_CHECKPOINT_ACTIVE}:${forceCheckpoint.scenarioId || "unknown_scenario"}`,
          action: undefined,
          dispatchBlockReason: `${BLOCK_REASON.GUARDRAIL_FORCE_CHECKPOINT_ACTIVE}:${forceCheckpoint.scenarioId || "unknown_scenario"}`,
          graphResult: null,
          cycleId,
          budgetEligibility,
          gateKey: "FORCE_CHECKPOINT",
          gateIndex: GATE_PRECEDENCE.FORCE_CHECKPOINT,
        };
      }
    }
  } catch (err) {
    warn(`[orchestrator] force-checkpoint governance gate check failed: ${String(err?.message || err)}`);
  }

  const freezeStatus = isFreezeActive(config);
  if (freezeStatus.active) {
    return {
      blocked: true,
      reason: `${BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE}:${freezeStatus.reason}`,
      action: undefined,
      dispatchBlockReason: `${BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE}:${freezeStatus.reason}`,
      graphResult: null,
      cycleId,
      budgetEligibility,
      gateKey: "GOVERNANCE_FREEZE",
      gateIndex: GATE_PRECEDENCE.GOVERNANCE_FREEZE,
    };
  }

  if (config?.runtime?.autonomyBand?.enabled !== false) {
    try {
      const autonomyBandStatus = await readJson(path.join(stateDir, "autonomy_band_status.json"), null);
      const autonomyExecutionGate = resolveAutonomyExecutionGateBlockReason(autonomyBandStatus);
      if (autonomyExecutionGate.blocked && autonomyExecutionGate.blockReason) {
        return {
          blocked: true,
          reason: autonomyExecutionGate.blockReason,
          action: undefined,
          dispatchBlockReason: autonomyExecutionGate.blockReason,
          graphResult: null,
          cycleId,
          budgetEligibility,
          gateKey: "AUTONOMY_EXECUTION",
          gateIndex: GATE_PRECEDENCE.AUTONOMY_EXECUTION,
        };
      }
    } catch (autonomyErr) {
      warn(`[orchestrator] autonomy execution governance gate check failed: ${String(autonomyErr?.message || autonomyErr)}`);
    }
  }

  if (config?.runtime?.cloudAgentGovernanceGateEnabled !== false) {
    try {
      const cloudAgentProfile = await readCloudAgentGovernanceProfileContract(config);
      if (cloudAgentProfile.violations.length > 0) {
        const firstViolation = cloudAgentProfile.violations[0];
        const detail = `${firstViolation};non_retryable=true`;
        return {
          blocked: true,
          reason: `${BLOCK_REASON.CLOUD_AGENT_GOVERNANCE_POLICY_VIOLATION}:${detail}`,
          action: undefined,
          dispatchBlockReason: `${BLOCK_REASON.CLOUD_AGENT_GOVERNANCE_POLICY_VIOLATION}:${detail}`,
          graphResult: null,
          cycleId,
          budgetEligibility,
          gateKey: "CLOUD_AGENT_GOVERNANCE",
          gateIndex: GATE_PRECEDENCE.CLOUD_AGENT_GOVERNANCE,
        };
      }
    } catch (cloudAgentErr) {
      warn(`[orchestrator] cloud-agent governance profile gate failed (non-fatal): ${String(cloudAgentErr?.message || cloudAgentErr)}`);
    }

    // Agent contract validation: prometheus and athena must have valid frontmatter
    try {
      const agentContractResult = validateCriticalAgentContracts();
      if (!agentContractResult.allValid) {
        const firstViolation = agentContractResult.violations[0];
        // Map violation field names to machine-readable AGENT_CONTRACT_GOVERNANCE_REASON_CODEs
        const reasonCodes = (firstViolation.violations as string[]).map(v => {
          if (v === "model_missing" || v === "model")       return AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_MODEL_MISSING;
          if (v === "tools_missing" || v === "tools")       return AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_TOOLS_MISSING;
          if (v === "description_missing" || v === "description") return AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_DESCRIPTION_MISSING;
          if (v === "file_missing" || v === "file")        return AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_FILE_MISSING;
          if (v === "frontmatter_missing" || v === "frontmatter") return AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_FRONTMATTER_MISSING;
          return AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_SCHEMA_VIOLATION;
        }).join(",");
        const detail = `agent_contract_invalid:slug=${firstViolation.slug};reasonCodes=${reasonCodes};violations=${(firstViolation.violations as string[]).join(",")};non_retryable=false`;
        return {
          blocked: true,
          reason: `${BLOCK_REASON.CLOUD_AGENT_GOVERNANCE_POLICY_VIOLATION}:${detail}`,
          action: undefined,
          dispatchBlockReason: `${BLOCK_REASON.CLOUD_AGENT_GOVERNANCE_POLICY_VIOLATION}:${detail}`,
          graphResult: null,
          cycleId,
          budgetEligibility,
          gateKey: "CLOUD_AGENT_GOVERNANCE",
          gateIndex: GATE_PRECEDENCE.CLOUD_AGENT_GOVERNANCE,
        };
      }
    } catch (agentContractErr) {
      warn(`[orchestrator] agent contract governance gate failed (non-fatal): ${String(agentContractErr?.message || agentContractErr)}`);
    }
  }

  const graphInput = Array.isArray(normalizedPlans)
    ? normalizedPlans.map((plan, index) => ({
        id: String(plan?.id || plan?.task || plan?.role || `plan-${index + 1}`),
        dependsOn: Array.isArray(plan?.dependsOn) ? plan.dependsOn : [],
        filesInScope: Array.isArray(plan?.filesInScope) ? plan.filesInScope : []
      }))
    : [];

  const graphResult = resolveDependencyGraph(graphInput);
  if (graphResult.status === GRAPH_STATUS.CYCLE_DETECTED) {
    return {
      blocked: true,
      reason: `${BLOCK_REASON.LINEAGE_CYCLE_DETECTED}:${graphResult.reasonCode}`,
      action: undefined,
      dispatchBlockReason: `${BLOCK_REASON.LINEAGE_CYCLE_DETECTED}:${graphResult.reasonCode}`,
      graphResult,
      cycleId,
      budgetEligibility,
      gateKey: "LINEAGE_CYCLE",
      gateIndex: GATE_PRECEDENCE.LINEAGE_CYCLE,
    };
  }

  const canaryBreach = await isGovernanceCanaryBreachActive(config);
  if (canaryBreach.breachActive) {
    const rollbackConfig = {
      ...config,
      rollbackEngine: {
        ...(config?.rollbackEngine || {}),
        incidentLogPath: config?.rollbackEngine?.incidentLogPath || path.join(stateDir, "rollback_incidents.jsonl"),
        lockFilePath: config?.rollbackEngine?.lockFilePath || path.join(stateDir, "rollback_lock.json")
      }
    };

    const rollbackResult = await executeRollback({
      level: ROLLBACK_LEVEL.CONFIG_ONLY,
      trigger: ROLLBACK_TRIGGER.CANARY_ROLLBACK,
      evidence: {
        controlValue: config?.rollbackEngine?.controlValue || {},
        cycleId,
        breachReason: canaryBreach.reason || "GOVERNANCE_CANARY_BREACH"
      },
      config: rollbackConfig,
      stateDir
    });

    return {
      blocked: true,
      reason: `${BLOCK_REASON.GOVERNANCE_CANARY_BREACH}:${canaryBreach.reason || "GOVERNANCE_CANARY_BREACH"}`,
      action: "rollback",
      dispatchBlockReason: `${BLOCK_REASON.GOVERNANCE_CANARY_BREACH}:${canaryBreach.reason || "GOVERNANCE_CANARY_BREACH"}`,
      graphResult,
      rollbackResult,
      cycleId,
      budgetEligibility,
      gateKey: "GOVERNANCE_CANARY",
      gateIndex: GATE_PRECEDENCE.GOVERNANCE_CANARY,
    };
  }

  // ── Carry-forward debt gate ───────────────────────────────────────────────
  // Block dispatch when the count of critical overdue debt entries meets or
  // exceeds the configured limit (default: 3).  Fail-open on any ledger read
  // error so a corrupt/missing ledger never prevents legitimate work.
  try {
    const { entries: debtLedger, cycleCounter } = await loadLedgerMeta(config);
    const debtGate = shouldBlockOnDebt(debtLedger, cycleCounter, {
      maxCriticalOverdue: config?.carryForward?.maxCriticalOverdue,
    });
    if (debtGate.shouldBlock) {
        return {
          blocked: true,
          reason: `${BLOCK_REASON.CRITICAL_DEBT_OVERDUE}:${debtGate.reason}`,
          action: undefined,
          dispatchBlockReason: `${BLOCK_REASON.CRITICAL_DEBT_OVERDUE}:${debtGate.reason}`,
          graphResult,
          cycleId,
          budgetEligibility,
        gateKey: "CARRY_FORWARD_DEBT",
        gateIndex: GATE_PRECEDENCE.CARRY_FORWARD_DEBT,
      };
    }
  } catch (err) {
    warn(`[orchestrator] carry-forward debt gate failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Mandatory drift debt gate ─────────────────────────────────────────────
  // Block dispatch when high-priority architecture drift debt remains unresolved
  // after plan normalization. "Mandatory" drift debt = stale references to
  // src/core/ files (priority=high, confidence=0.50) that have not been remediated.
  // These indicate that the architecture doc is pointing to ghost paths in active
  // infrastructure, which can cause workers to build against non-existent files.
  //
  // Fail-open: any error processing the drift report is treated as no signal so
  // a transient scan failure never prevents legitimate work.
  // Disabled when config.runtime.disableDriftDebtGate === true.
  if (driftReport && config?.runtime?.disableDriftDebtGate !== true) {
    try {
      const driftCandidates = rankStaleRefsAsRemediationCandidates(driftReport);
      const mandatoryDebt = driftCandidates.filter(c => c.priority === "high");
      if (mandatoryDebt.length > 0) {
        const firstHint = mandatoryDebt[0].suggestedTask;
        // Collect the distinct missing file paths so callers can surface them directly.
        const mandatoryDriftPaths = [...new Set(
          mandatoryDebt.map(c => c.referencedPath).filter(Boolean) as string[]
        )];
        return {
          blocked: true,
          reason: `${BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED}:${mandatoryDebt.length} high-priority drift debt task(s) remain — ${firstHint}`,
          action: undefined,
          dispatchBlockReason: `${BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED}:${mandatoryDebt.length} high-priority drift debt task(s) remain — ${firstHint}`,
          graphResult,
          cycleId,
          budgetEligibility,
          mandatoryDriftPaths,
          gateKey: "MANDATORY_DRIFT_DEBT",
          gateIndex: GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT,
        };
      }
    } catch (driftDebtErr) {
      warn(`[orchestrator] mandatory drift debt gate failed (non-fatal): ${String(driftDebtErr?.message || driftDebtErr)}`);
    }
  }

  // ── Plan evidence coupling gate ───────────────────────────────────────────
  // Each plan entering dispatch must carry at least one verification command
  // and at least one acceptance criterion — this ensures automated completion
  // signals exist before work begins.  Plans that are missing these fields are
  // either AI output gaps or legacy plans from before the coupling requirement;
  // either way, dispatching them would produce unverifiable outcomes.
  if (Array.isArray(normalizedPlans) && normalizedPlans.length > 0) {
    const invalidPlans: string[] = [];
    for (const plan of normalizedPlans) {
      const coupling = validatePlanEvidenceCoupling(plan);
      if (!coupling.valid) {
        const planId = String((plan as any)?.task_id || (plan as any)?.id || (plan as any)?.task || "unknown");
        invalidPlans.push(`${planId}: ${coupling.errors.join("; ")}`);
      }
    }
    if (invalidPlans.length > 0) {
      return {
        blocked: true,
        reason: `${BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID}:${invalidPlans[0]}`,
        action: undefined,
        dispatchBlockReason: `${BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID}:${invalidPlans[0]}`,
        graphResult,
        cycleId,
        budgetEligibility,
        gateKey: "PLAN_EVIDENCE_COUPLING",
        gateIndex: GATE_PRECEDENCE.PLAN_EVIDENCE_COUPLING,
      };
    }
  }

  // ── Cross-cycle prerequisite gate ─────────────────────────────────────────
  // Block dispatch when a plan declares a cross-cycle prerequisite but does not
  // carry a confirmation token proving prior-cycle fulfillment.
  if (Array.isArray(normalizedPlans) && normalizedPlans.length > 0) {
    for (let pi = 0; pi < normalizedPlans.length; pi++) {
      const plan = normalizedPlans[pi] as Record<string, unknown>;
      const prerequisite = normalizeCrossCycleDispatchPrerequisite(plan);
      if (!prerequisite) continue;
      if (prerequisite.confirmationToken) continue;
      const planId = String(plan?.task_id || plan?.id || plan?.task || `plan[${pi}]`);
      const detail = `${planId}: missing confirmation token for cross-cycle prerequisite "${prerequisite.gateName}" (source=${prerequisite.source})`;
      return {
        blocked: true,
        reason: `${BLOCK_REASON.CROSS_CYCLE_PREREQUISITE_UNMET}:${detail}`,
        action: undefined,
        dispatchBlockReason: `${BLOCK_REASON.CROSS_CYCLE_PREREQUISITE_UNMET}:${detail}`,
        graphResult,
        cycleId,
        budgetEligibility,
        gateKey: "CROSS_CYCLE_PREREQUISITE",
        gateIndex: GATE_PRECEDENCE.CROSS_CYCLE_PREREQUISITE,
      };
    }
  }

  // ── Dependency readiness gate ─────────────────────────────────────────────
  // Gate dispatch when any plan carries explicit confidence metadata below the
  // minimum threshold.  Only fires for tasks that OPT IN by declaring at least
  // one of: shapeConfidence, budgetConfidence, or dependencyConfidence.
  // Plans without confidence fields pass through (fail-open for legacy plans).
  // Threshold configurable via config.runtime.minPlanConfidence (default: 0.5).
  //
  // Fail-open: any error during readiness evaluation is logged but never blocks.
  try {
    const readinessResult = computeReadinessGate(Array.isArray(normalizedPlans) ? normalizedPlans : [], {
      minConfidence: config?.runtime?.minPlanConfidence,
    });
    if (!readinessResult.ready) {
      return {
        blocked: true,
        reason: `${BLOCK_REASON.DEPENDENCY_READINESS_INCOMPLETE}:${readinessResult.reason}`,
        action: undefined,
        dispatchBlockReason: `${BLOCK_REASON.DEPENDENCY_READINESS_INCOMPLETE}:${readinessResult.reason}`,
        graphResult,
        cycleId,
        budgetEligibility,
        gateKey: "DEPENDENCY_READINESS",
        gateIndex: GATE_PRECEDENCE.DEPENDENCY_READINESS,
        readinessResult,
      };
    }
  } catch (readinessErr) {
    warn(`[orchestrator] dependency readiness gate failed (non-fatal): ${String(readinessErr?.message || readinessErr)}`);
  }

  // ── Lane diversity gate ───────────────────────────────────────────────────
  // Runs in pre-dispatch governance so both standard and resume dispatch paths
  // block before wave-1 using a canonical block reason contract.
  let laneDiversityBypassReason: string | null = null;
  const diversityMinLanesRaw = Number(config?.workerPool?.minLanes);
  const diversityMinLanes = Number.isFinite(diversityMinLanesRaw) && diversityMinLanesRaw > 1
    ? Math.floor(diversityMinLanesRaw)
    : null;
  if (diversityMinLanes !== null && normalizedPlans.length > 0) {
    let diversityMsg = "";
    let diversityBlocked = false;
    try {
      const diversityPool = assignWorkersToPlans(normalizedPlans, config);
      const diversityResult = enforceLaneDiversity(diversityPool, { minLanes: diversityMinLanes });
      if (!diversityResult.meetsMinimum) {
        const diversityBypass = shouldBypassLaneDiversityHardGate({
          plans: normalizedPlans,
          minLanes: diversityMinLanes,
          capabilityPoolResult: diversityPool,
          laneConflicts: detectLaneConflicts(diversityPool.assignments),
          workerTopology: continuationTopology,
          admittedWorkerTopology,
        });
        if (diversityBypass.bypass && String(diversityBypass.reason || "").startsWith("admitted_multi_lane_continuation:")) {
          laneDiversityBypassReason = diversityBypass.reason;
          warn(`[orchestrator] lane diversity gate bypassed for continuation topology: ${String(diversityBypass.reason || "unknown_reason")}`);
        } else {
          diversityBlocked = true;
          diversityMsg = String(diversityResult.warning || "insufficient lane diversity");
        }
      }
    } catch (diversityErr) {
      diversityBlocked = true;
      diversityMsg = `lane_diversity_gate_error:${String(diversityErr?.message || diversityErr)}`;
    }
    if (diversityBlocked) {
      const blockReason = `${BLOCK_REASON.LANE_DIVERSITY_INSUFFICIENT}:${diversityMsg}`;
      return {
        blocked: true,
        reason: blockReason,
        action: undefined,
        dispatchBlockReason: blockReason,
        graphResult,
        cycleId,
        budgetEligibility,
        gateKey: "LANE_DIVERSITY",
        gateIndex: GATE_PRECEDENCE.LANE_DIVERSITY,
      };
    }
  }

  // ── Gate 10: Rolling completion yield throttle ────────────────────────
  // If the rolling yield of recent dispatches falls at or below the throttle
  // threshold, pause dispatch to prevent premium-request waste spirals.
  try {
    const yieldContract: RollingYieldContract = await computeRollingCompletionYield(config);
    if (yieldContract.throttled) {
      return {
        blocked: true,
        reason: `${BLOCK_REASON.ROLLING_YIELD_THROTTLE}:yield=${yieldContract.yield.toFixed(2)},window=${yieldContract.windowSize},threshold=${yieldContract.threshold}`,
        action: undefined,
        dispatchBlockReason: `${BLOCK_REASON.ROLLING_YIELD_THROTTLE}:yield=${yieldContract.yield.toFixed(2)},window=${yieldContract.windowSize},threshold=${yieldContract.threshold}`,
        graphResult,
        cycleId,
        budgetEligibility,
        gateKey: "ROLLING_COMPLETION_YIELD",
        gateIndex: GATE_PRECEDENCE.ROLLING_COMPLETION_YIELD,
        rollingYieldContract: yieldContract,
      };
    }
  } catch (yieldErr) {
    warn(`[orchestrator] rolling yield gate failed (non-fatal): ${String(yieldErr?.message || yieldErr)}`);
  }

  // ── Gate 11: Specialization admission gate ────────────────────────────
  // Fires when the specialist share of the current plan set falls below the
  // adaptive lane utilization target.  Bounded fallback: after
  // SPECIALIZATION_ADMISSION_MAX_BLOCK_CYCLES consecutive blocks the gate
  // allows dispatch through with a warning to prevent deadlock.
  //
  // Opt-in: only active when config.workerPool.specializationTargets.minSpecializedShare
  // is explicitly set to a positive value.  When not configured the gate is a no-op
  // so existing workflows are not disrupted.
  const configuredSpecShareTarget = Number(
    (config as any)?.workerPool?.specializationTargets?.minSpecializedShare
  );
  const specializationGateEnabled = normalizedPlans.length > 0 && Number.isFinite(configuredSpecShareTarget) && configuredSpecShareTarget > 0;
  if (specializationGateEnabled) {
    try {
      const gateStatePath = path.join(stateDir, "specialization_gate_state.json");
      let consecutiveBlockCycles = 0;
      try {
        const raw = await fs.readFile(gateStatePath, "utf8");
        const parsed = JSON.parse(raw);
        consecutiveBlockCycles = Number(parsed?.consecutiveBlockCycles) || 0;
      } catch {
        // File absent or unreadable — start from 0.
      }

      let laneTelemetrySignalsForAdmission = {};
      try {
        const analyticsForAdmission = await readCycleAnalytics(config);
        const laneTelemetry = analyticsForAdmission?.lastCycle?.laneTelemetry;
        if (laneTelemetry && typeof laneTelemetry === "object") {
          laneTelemetrySignalsForAdmission = buildLaneTelemetrySignals(laneTelemetry);
        }
      } catch {
        // Missing lane telemetry is non-fatal; ROI admission falls back optimistic.
      }

      // assignWorkersToPlans is synchronous; call it with current plans to get fresh utilization.
      const poolSample = assignWorkersToPlans(normalizedPlans, config, undefined, {
        laneTelemetrySignals: laneTelemetrySignalsForAdmission,
      });

      // Compute topology feasibility: when no plans route to a specialist, the
      // gate must not block (infeasible topology — no amount of waiting will add
      // specialist-eligible plans). This converts the gate into a soft-gate for
      // monocultural plan sets where dispatch continuity is the correct choice.
      const topologyFeasibility = computeTopologyFeasibility(normalizedPlans, config);

      // Read reroute history to bind admission threshold to reroute reason intensity.
      // Specialists rerouted for token-fill reasons lower the effective threshold;
      // performance-degraded reroutes raise it.  Missing file is non-fatal.
      let admissionReroutePenaltyLedger = {};
      try {
        const rerouteHistoryPath = path.join(stateDir, "reroute_history.jsonl");
        const rawHistory = await fs.readFile(rerouteHistoryPath, "utf8");
        const historyRecords = rawHistory.split("\n").filter(Boolean).flatMap(line => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
        admissionReroutePenaltyLedger = buildReroutePenaltyLedger(historyRecords);
      } catch { /* reroute_history.jsonl absent or unreadable — proceed without intensity binding */ }

      const admissionResult = evaluateSpecializationAdmissionGate(
        poolSample.specializationUtilization,
        consecutiveBlockCycles,
        SPECIALIZATION_ADMISSION_MAX_BLOCK_CYCLES,
        admissionReroutePenaltyLedger,
        topologyFeasibility,
      );
      const laneROIAdmission = computeLaneROIAdmission(laneTelemetrySignalsForAdmission);
      const specializationBypass = shouldBypassSpecializationAdmissionGate({
        laneDiversityBypassReason,
        capabilityPoolResult: poolSample,
        workerTopology: continuationTopology,
        admittedWorkerTopology,
      });
      if (specializationBypass.bypass) {
        warn(`[orchestrator] specialization admission gate bypassed for continuation topology: ${String(specializationBypass.reason || "unknown_reason")}`);
      }

      const specializationBlocked = !specializationBypass.bypass && admissionResult.blocked && !laneROIAdmission.admitted;
      const roiBlocked = !specializationBypass.bypass && !laneROIAdmission.admitted && topologyFeasibility.feasible;
      const blockedReason = roiBlocked
        ? `${laneROIAdmission.reason}; shareGate=${admissionResult.reason || "pass"}`
        : admissionResult.reason;

      // Persist updated counter regardless of outcome so bypass counter resets on pass.
      const newCount = specializationBlocked ? admissionResult.consecutiveBlockCycles : 0;
      try {
        await fs.mkdir(path.dirname(gateStatePath), { recursive: true });
        await fs.writeFile(gateStatePath, JSON.stringify({ consecutiveBlockCycles: newCount, updatedAt: new Date().toISOString() }), "utf8");
      } catch (writeErr) {
        warn(`[orchestrator] specialization gate state write failed (non-fatal): ${String(writeErr?.message || writeErr)}`);
      }

      if (roiBlocked) {
        return {
          blocked: true,
          reason: blockedReason,
          action: undefined,
          dispatchBlockReason: blockedReason,
          graphResult,
          cycleId,
          budgetEligibility,
          gateKey: "SPECIALIZATION_ADMISSION",
          gateIndex: GATE_PRECEDENCE.SPECIALIZATION_ADMISSION,
        };
      } else if (admissionResult.blocked && laneROIAdmission.admitted) {
        warn(`[orchestrator] specialization share gate bypassed by positive lane ROI admission: ${laneROIAdmission.reason}`);
      } else if (admissionResult.reason && admissionResult.reason.includes("bypassed_fallback")) {
        warn(`[orchestrator] specialization admission gate bypassed (bounded fallback): ${admissionResult.reason}`);
      }
      // Record that specialization admission control was evaluated this cycle.
      await recordCapabilityExecution(
        config,
        "specialization-admission-control",
        `blocked=${String(roiBlocked)} shareGate=${String(admissionResult.reason || "pass").slice(0, 80)} roiGate=${String(laneROIAdmission.reason || "pass").slice(0, 80)}`,
      );
    } catch (specErr) {
      warn(`[orchestrator] specialization admission gate failed (non-fatal): ${String(specErr?.message || specErr)}`);
    }
  }

  // ── Gate 12: Oversized packet hard admission (always-on) ─────────────────
  // Two-layer check applied sequentially:
  //   1. Individual-plan complexity: checkOverbundleHardAdmission — blocks when any
  //      single plan's ordered-step count exceeds the cap (overbundle heuristic
  //      converted into a hard pre-dispatch gate per the admission architecture).
  //   2. Role-group aggregated complexity: validatePacketBatchAdmission — blocks
  //      when the sum of steps across all plans for a role group exceeds the cap.
  //
  // The cap is taken from config.planner.maxActionableStepsPerPacket when configured,
  // or falls back to OVERBUNDLE_STEPS_THRESHOLD so the gate is always active
  // regardless of config.
  //
  // Named verification targets are bound earlier in this function (above) so that
  // by the time this gate runs every plan already carries a resolved verification
  // target or a NON_SPECIFIC_VERIFICATION marker — preventing high-latency
  // low-yield worker calls from reaching dispatch with unresolvable targets.
  //
  {
    const rawActionableCap = Number((config as any)?.planner?.maxActionableStepsPerPacket);
    const actionableCap = Number.isFinite(rawActionableCap) && rawActionableCap > 0
      ? Math.floor(rawActionableCap)
      : OVERBUNDLE_STEPS_THRESHOLD;
    if (actionableCap > 0 && normalizedPlans.length > 0) {
      // Layer 1: individual-plan complexity (overbundle hard admission gate).
      const individualCheck = checkOverbundleHardAdmission(
        Array.isArray(normalizedPlans) ? normalizedPlans : [],
        actionableCap,
      );
      if (individualCheck.blocked) {
        const blockReason = `${BLOCK_REASON.OVERSIZED_PACKET}:${individualCheck.reason}`;
        return {
          blocked: true,
          reason: blockReason,
          action: undefined,
          dispatchBlockReason: blockReason,
          graphResult,
          cycleId,
          budgetEligibility,
          gateKey: "OVERSIZED_PACKET",
          gateIndex: GATE_PRECEDENCE.OVERSIZED_PACKET,
        };
      }
      // Layer 2: role-group aggregated complexity.
      // Soft-gate: when the role group is oversized but each individual plan fits
      // within the cap, rebatch by reassigning _batchIndex values instead of
      // blocking. This allows Athena-prebatched topologies to be split
      // deterministically rather than rejected outright.
      const oversizeCheck = validatePacketBatchAdmission(Array.isArray(normalizedPlans) ? normalizedPlans : [], actionableCap);
      if (oversizeCheck.blocked) {
        // Attempt rebatch: greedily repack each oversized role group into
        // sub-batches that fit within the cap, shifting subsequent batch indices.
        const rebatchSucceeded = tryRebatchOversizedPlans(
          Array.isArray(normalizedPlans) ? normalizedPlans : [],
          actionableCap,
        );
        if (!rebatchSucceeded) {
          const blockReason = `${BLOCK_REASON.OVERSIZED_PACKET}:${oversizeCheck.reason}`;
          return {
            blocked: true,
            reason: blockReason,
            action: undefined,
            dispatchBlockReason: blockReason,
            graphResult,
            cycleId,
            budgetEligibility,
            gateKey: "OVERSIZED_PACKET",
            gateIndex: GATE_PRECEDENCE.OVERSIZED_PACKET,
          };
        }
        // Rebatch succeeded — plans now carry updated _batchIndex values; proceed.
      }
    }
  }

  return {
    blocked: false,
    reason: null,
    action: undefined,
    dispatchBlockReason: null,
    graphResult,
    cycleId,
    budgetEligibility
  };
}

/**
 * Machine-readable signal written to state/auto_approve_telemetry.json when the
 * Athena plan review fast-path bypasses AI review.  Consumers (model_policy telemetry
 * readers, Prometheus postmortem analysis) can correlate auto-approved cycles with
 * realized outcomes to improve future fast-path accuracy.
 */
export const AUTO_APPROVE_DISPATCH_SIGNAL = Object.freeze({
  /** Review was skipped because the batch fingerprint matched a prior approved review. */
  LOW_RISK_UNCHANGED:    "LOW_RISK_UNCHANGED",
  /** Review was skipped because all plans cleared the high-quality deterministic threshold. */
  HIGH_QUALITY_LOW_RISK: "HIGH_QUALITY_LOW_RISK",
  /** Review was skipped because all plans in a changed batch cleared the delta-review threshold. */
  DELTA_REVIEW_APPROVED: "DELTA_REVIEW_APPROVED",
} as const);

/**
 * Append an auto-approve dispatch decision to state/auto_approve_telemetry.json.
 *
 * Called by the orchestrator dispatch path whenever Athena returns an auto-approved
 * result so that downstream telemetry consumers (model_policy ROI ledger, Prometheus)
 * can correlate fast-path approvals with realized cycle outcomes.
 *
 * Fails open: any write error is logged but never propagated so a telemetry failure
 * cannot block worker dispatch.
 *
 * @param config        — BOX config (stateDir resolved from config.paths.stateDir)
 * @param planReviewResult — Athena plan review result (autoApproved=true required)
 * @param cycleId       — dispatch cycle identifier for correlation
 */
export async function appendAutoApproveTelemetry(
  config: object,
  planReviewResult: Record<string, unknown>,
  cycleId: string
): Promise<void> {
  const stateDir = (config as any)?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, "auto_approve_telemetry.json");
  try {
    const rawResult = await readJsonSafe(filePath);
    const safeList: unknown[] = (rawResult.ok && Array.isArray(rawResult.data)) ? rawResult.data : [];
    const entry = {
      cycleId,
      signal: String((planReviewResult.autoApproveReason as any)?.code || AUTO_APPROVE_DISPATCH_SIGNAL.LOW_RISK_UNCHANGED),
      planCount: Array.isArray(planReviewResult.planReviews) ? (planReviewResult.planReviews as any[]).length : 0,
      recordedAt: new Date().toISOString(),
    };
    await writeJson(filePath, [...safeList, entry]);
  } catch (err) {
    warn(`[orchestrator] auto-approve telemetry write failed (non-fatal): ${String((err as any)?.message || err)}`);
  }
}

/**
 * Safe wrapper for updatePipelineProgress.
 *
 * Pipeline progress is observability state — a write failure must NEVER block
 * orchestration. Errors are logged explicitly (never silently dropped) so
 * the failure is observable via the progress log.
 *
 * Risk: medium — touches orchestrator transitions directly.
 */
async function safeUpdatePipelineProgress(config, stepId, detail, extra?) {
  try {
    await updatePipelineProgress(config, stepId, detail, extra);
  } catch (err) {
    warn(`[orchestrator] pipeline progress update failed (step=${stepId}): ${String(err?.message || err)}`);
  }
}

/**
 * Audit the three critical checkpoint state files using readJsonSafe.
 *
 * Critical vs non-critical classification:
 *   CRITICAL  (handled here): worker_sessions.json, janus_directive.json, prometheus_analysis.json
 *   NON-CRITICAL (handled by readJson with fallback + box:readError event): all other reads.
 *
 * A missing file (ENOENT) is expected on first run and is NOT an error.
 * An invalid file (corrupt JSON) is always an error — sets orchestratorStatus=degraded.
 *
 * Returns: { sessions, janusDirective, prometheusAnalysis, degraded: boolean }
 */
async function auditCriticalStateFiles(config, stateDir) {
  const criticalReads = await Promise.all([
    readJsonSafe(path.join(stateDir, "worker_sessions.json")),
    readJsonSafe(path.join(stateDir, "janus_directive.json")),
    readJsonSafe(path.join(stateDir, "prometheus_analysis.json"))
  ]);
  const [sessionsResult, janusDirectiveResult, prometheusAnalysisResult] = criticalReads;

  let sessions: Record<string, any> = {};
  let janusDirective = null;
  let prometheusAnalysis = null;
  const degradedReasons = [];

  for (const [label, result, defaultFallback, fileType] of ([
    ["worker_sessions.json",    sessionsResult,          {}, STATE_FILE_TYPE.WORKER_SESSIONS],
    ["janus_directive.json",    janusDirectiveResult,    null, null],
    ["prometheus_analysis.json", prometheusAnalysisResult, null, STATE_FILE_TYPE.PROMETHEUS_ANALYSIS]
  ] as Array<[string, CriticalReadResult, unknown, string | null]>)) {
    if (result.ok) {
      // Successfully parsed — run schema migration if this file type is versioned
      if (fileType && result.data !== null) {
        const migrated = migrateData(result.data, fileType);
        if (!migrated.ok) {
          // Unknown future version or structural mismatch — fail closed, log telemetry
          await recordMigrationTelemetry(stateDir, {
            fileType,
            filePath: path.join(stateDir, label),
            fromVersion: migrated.fromVersion,
            toVersion: migrated.toVersion,
            success: false,
            reason: migrated.reason
          });
          if (migrated.reason === MIGRATION_REASON.UNKNOWN_FUTURE_VERSION) {
            const detail = `${label}: unknown future schemaVersion (${migrated.fromVersion}) — fail-closed`;
            degradedReasons.push(detail);
            await appendProgress(config,
              `[STARTUP] WARNING: ${label} has unknown future schemaVersion (${migrated.fromVersion}) — treating as degraded to avoid data corruption`
            );
            await appendAlert(config, {
              severity: ALERT_SEVERITY.CRITICAL,
              source: "orchestrator",
              title: `Unknown future schemaVersion in ${label}`,
              message: `reason=${migrated.reason} fromVersion=${migrated.fromVersion}`
            });
          }
          // Use default fallback for this file (do not use unmigratable data)
          if (label === "worker_sessions.json") sessions = defaultFallback;
          if (label === "prometheus_analysis.json") prometheusAnalysis = defaultFallback;
          continue;
        }
        // Record telemetry only for actual migrations performed (not ALREADY_CURRENT)
        if (migrated.reason === MIGRATION_REASON.OK) {
          await recordMigrationTelemetry(stateDir, {
            fileType,
            filePath: path.join(stateDir, label),
            fromVersion: migrated.fromVersion,
            toVersion: migrated.toVersion,
            success: true,
            reason: migrated.reason
          });
        }
        if (label === "worker_sessions.json") sessions = migrated.data;
        if (label === "prometheus_analysis.json") prometheusAnalysis = migrated.data;
        continue;
      }
    } else if (result.reason === READ_JSON_REASON.MISSING) {
      // Expected on first run — use fallback silently
    } else {
      // Invalid JSON in a critical state file — record degraded reason and emit telemetry
      const detail = `${label}: ${result.error?.message || "parse error"}`;
      degradedReasons.push(detail);
      await appendProgress(config,
        `[STARTUP] CRITICAL: corrupt state file ${label} (reason=invalid) — entering degraded mode`
      );
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "orchestrator",
        title: `Corrupt critical state file: ${label}`,
        message: `reason=invalid error=${result.error?.message || "parse error"}`
      });
    }
    if (label === "worker_sessions.json") sessions = result.ok ? result.data : defaultFallback;
    if (label === "janus_directive.json") janusDirective = result.ok ? result.data : defaultFallback;
    if (label === "prometheus_analysis.json") prometheusAnalysis = result.ok ? result.data : defaultFallback;
  }

  if (degradedReasons.length > 0) {
    await writeOrchestratorHealth(stateDir, ORCHESTRATOR_STATUS.DEGRADED, "corrupt_state_files", degradedReasons);
    await appendProgress(config, `[STARTUP] orchestratorStatus=degraded reasons: ${degradedReasons.join("; ")}`);
  } else {
    await writeOrchestratorHealth(stateDir, ORCHESTRATOR_STATUS.OPERATIONAL, null);
  }

  return { sessions, janusDirective, prometheusAnalysis, degraded: degradedReasons.length > 0 };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Attempt to start the dashboard server alongside the daemon (non-blocking, non-fatal). */
async function tryStartDashboard() {
  try {
    const { startDashboard } = await import("../dashboard/live_dashboard.js");
    startDashboard();
  } catch (err) {
    warn(`[orchestrator] dashboard auto-start failed (non-fatal): ${String(err?.message || err)}`);
  }
}

export async function runDaemon(config) {
  const liveConfig = Object.assign({}, config);
  const stateDir = liveConfig.paths?.stateDir || "state";
  await fs.mkdir(stateDir, { recursive: true });
  const startupGuard = await evaluateSingleTargetStartupRequirements(liveConfig);
  if (!startupGuard.ok) {
    const message = buildSingleTargetStartupGuardMessage(startupGuard);
    await appendProgress(liveConfig, `[STARTUP][SINGLE_TARGET][BLOCKED] ${startupGuard.missing.join(", ")} missing — daemon startup aborted`);
    throw new Error(message);
  }

  const pid = process.pid;
  await writeDaemonPid(liveConfig, pid);
  await appendProgress(liveConfig, `[ATLAS] Daemon started pid=${pid}`);

  await tryStartDashboard();

  process.on("SIGTERM", async () => {
    await appendProgress(liveConfig, "[ATLAS] SIGTERM received, stopping");
    await clearDaemonPid(liveConfig);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await appendProgress(liveConfig, "[ATLAS] SIGINT received, stopping");
    await clearDaemonPid(liveConfig);
    process.exit(0);
  });

  // ── Checkpoint-based startup: clean up leftover .tmp files, then audit ──
  {
    const cleanupResult = await cleanupStaleTempFiles(stateDir);
    if (cleanupResult.removed.length > 0) {
      await appendProgress(liveConfig, `[STARTUP] Cleaned up ${cleanupResult.removed.length} stale temp file(s): ${cleanupResult.removed.join(", ")}`);
    }
    if (!cleanupResult.ok) {
      warn(`[orchestrator] stale-temp cleanup failed (non-fatal): ${String(cleanupResult.error?.message || cleanupResult.error)}`);
    }
  }

  // ── Validate preToolUse hook governance policy (runtime contract) ─────────
  {
    try {
      const hookPolicyData = await loadHookPolicy(String(liveConfig?.rootDir || process.cwd()));
      if (hookPolicyData) {
        await appendProgress(
          liveConfig,
          `[STARTUP] Hook governance policy loaded (schemaVersion=${hookPolicyData.schemaVersion ?? "unknown"}): ${DEFAULT_HOOK_POLICY_PATH}`,
        );
      } else {
        await appendProgress(
          liveConfig,
          `[STARTUP] WARNING: Hook governance policy absent — ${DEFAULT_HOOK_POLICY_PATH} not found. Tool-execution telemetry enforcement will use defaults.`,
        );
      }
    } catch (hookErr: unknown) {
      warn(`[orchestrator] hook policy load failed (non-fatal): ${String((hookErr as Error)?.message ?? hookErr)}`);
    }
  }

  const platformModeState = await loadPlatformModeState(liveConfig);
  (liveConfig as any).platformModeState = platformModeState;
  await appendProgress(
    liveConfig,
    `[MODE_STATE] ${summarizePlatformModeState(platformModeState)}`
  );
  if (Array.isArray(platformModeState.warnings) && platformModeState.warnings.length > 0) {
    for (const warningText of platformModeState.warnings) {
      await appendProgress(liveConfig, `[MODE_STATE] normalization ${warningText}`);
    }
  }

  const activeTargetSession = await loadActiveTargetSession(liveConfig);
  (liveConfig as any).activeTargetSession = activeTargetSession;
  bindRuntimeTargetContext(liveConfig, platformModeState, activeTargetSession);
  await appendProgress(
    liveConfig,
    `[TARGET_SESSION] ${summarizeActiveTargetSession(activeTargetSession)}`
  );
  if (Array.isArray(activeTargetSession?.warnings) && activeTargetSession.warnings.length > 0) {
    for (const warningText of activeTargetSession.warnings) {
      await appendProgress(liveConfig, `[TARGET_SESSION] normalization ${warningText}`);
    }
  }
  if (
    platformModeState.currentMode === "single_target_delivery"
    && activeTargetSession
    && activeTargetSession.currentStage === "onboarding"
  ) {
    const onboardingAgentContractResult = validateRequiredAgentContracts([TARGET_ONBOARDING_AGENT_SLUG]);
    if (!onboardingAgentContractResult.allValid) {
      const firstViolation = onboardingAgentContractResult.violations[0];
      const violations = Array.isArray(firstViolation?.violations) ? firstViolation.violations.join(",") : "unknown";
      throw new Error(`Onboarding agent contract invalid: slug=${String(firstViolation?.slug || TARGET_ONBOARDING_AGENT_SLUG)} violations=${violations}`);
    }
    const onboardingResult = await runTargetOnboarding(liveConfig, activeTargetSession);
    (liveConfig as any).activeTargetSession = onboardingResult.session;
    bindRuntimeTargetContext(liveConfig, platformModeState, onboardingResult.session);
    await appendProgress(
      liveConfig,
      `[ONBOARDING] readiness=${onboardingResult.report.readiness.status} nextStage=${onboardingResult.report.readiness.recommendedNextStage} score=${onboardingResult.report.readiness.readinessScore}`
    );
    await appendProgress(
      liveConfig,
      `[TARGET_SESSION] ${summarizeActiveTargetSession(onboardingResult.session)}`
    );
  }

  // ── Checkpoint-based startup: audit critical state files, then resume ──
  const { sessions, janusDirective, prometheusAnalysis } =
    await auditCriticalStateFiles(liveConfig, stateDir);

  // Reset zombie workers (stale > 2× timeout)
  const workerTimeoutMs = Number(liveConfig.runtime?.workerTimeoutMinutes || 30) * 60 * 1000;
  const staleThresholdMs = workerTimeoutMs * 2;
  const now = Date.now();
  let zombieReset = false;
  const knownRoles = Object.values(getRoleRegistry(liveConfig).workers).map((w: any) => w.name);
  for (const roleName of knownRoles) {
    const perWorkerPath = path.join(stateDir, `worker_${roleName.toLowerCase().replace(/\s+/g, "_")}.json`);
    const perWorker = await readJson(perWorkerPath, null);
    if (perWorker?.status === "working" && perWorker?.startedAt) {
      const age = now - new Date(perWorker.startedAt).getTime();
      if (age > staleThresholdMs) {
        perWorker.status = "idle";
        perWorker.startedAt = null;
        await writeJson(perWorkerPath, perWorker);
        if (sessions[roleName]) {
          sessions[roleName].status = "idle";
          sessions[roleName].startedAt = null;
        }
        zombieReset = true;
        await appendProgress(liveConfig, `[STARTUP] Reset zombie worker ${roleName} (stale ${Math.round(age / 60000)}min)`);
      }
    }
  }
  if (zombieReset) {
    await writeJson(path.join(stateDir, "worker_sessions.json"), addSchemaVersion(sessions, STATE_FILE_TYPE.WORKER_SESSIONS));
  }

  const activeWorkers = Object.entries(sessions)
    .filter(([, s]) => s?.status === "working")
    .map(([name]) => name);

  const hasCheckpoint = prometheusAnalysis?.analyzedAt || (janusDirective && janusDirective.decidedAt);

  if (activeWorkers.length > 0) {
    await appendProgress(liveConfig,
      `[STARTUP] Resuming — ${activeWorkers.length} workers active (${activeWorkers.join(", ")}). Waiting for them.`
    );
  } else if (!hasCheckpoint) {
    await appendProgress(liveConfig, "[STARTUP] No checkpoint found — first run, Janus activating");
    await capturePreWorkBaseline(liveConfig);
  } else {
    await appendProgress(liveConfig, "[STARTUP] Resuming from checkpoint — entering main loop");
  }

  await mainLoop(liveConfig);
}

// Implements dispatch interruption detection: reads dispatch_checkpoint.json and
// returns true when a previous dispatch was interrupted mid-flight (status=dispatching
// with completedPlans < totalPlans). The daemon resume-first path calls this to
// prioritise checkpoint resumption over running a fresh full cycle.
async function _wasDispatchInterrupted(_stateDir: string): Promise<boolean> {
  try {
    const checkpoint = await readDispatchCheckpoint({ paths: { stateDir: _stateDir } });
    return isDispatchCheckpointResumable(checkpoint);
  } catch {
    return false;
  }
}

const DISPATCH_CHECKPOINT_FILE = "dispatch_checkpoint.json";

async function readDispatchCheckpoint(config) {
  try {
    return await readVersionedCheckpoint(config, { fileName: DISPATCH_CHECKPOINT_FILE });
  } catch (err) {
    warn(`[orchestrator] dispatch checkpoint read failed: ${String(err?.message || err)}`);
    return null;
  }
}

async function writeDispatchCheckpoint(config, checkpoint) {
  const persisted = await writeVersionedCheckpoint(config, checkpoint, {
    fileName: DISPATCH_CHECKPOINT_FILE,
    checkpointKind: "dispatch",
    returnEnvelope: true,
  });
  if (checkpoint && typeof checkpoint === "object") {
    Object.assign(checkpoint, persisted);
  }
  return persisted;
}

export function isDispatchCheckpointResumable(checkpoint): boolean {
  if (!checkpoint || checkpoint.status !== "dispatching") return false;
  const totalPlans = Number(checkpoint.totalPlans || 0);
  const completedPlans = Number(checkpoint.completedPlans || 0);
  return totalPlans > 0 && completedPlans < totalPlans;
}

function isDispatchCheckpointCompleteForTotal(checkpoint, totalPlans) {
  if (!checkpoint || checkpoint.status !== "complete") return false;
  if (Number(checkpoint.totalPlans || 0) !== Number(totalPlans || 0)) return false;
  return Number(checkpoint.completedPlans || 0) >= Number(totalPlans || 0);
}

function computePlanSetSignature(plans: any[]): string {
  const normalized = (Array.isArray(plans) ? plans : []).map((p: any) => ({
    task: String(p?.task || "").trim(),
    role: String(p?.role || "").trim(),
    taskId: String(p?.task_id || p?.id || "").trim(),
    wave: Number.isFinite(Number(p?.wave)) ? Number(p.wave) : null,
  }));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function checkpointMatchesPlanSet(
  checkpoint: any,
  plans: any[],
  planAnalyzedAtIso?: string,
): boolean {
  if (!checkpoint || typeof checkpoint !== "object") return false;
  const checkpointPlanCount = Number(checkpoint?.planCount ?? checkpoint?.totalPlans ?? 0);
  if (checkpointPlanCount !== (Array.isArray(plans) ? plans.length : 0)) return false;

  const currentSignature = computePlanSetSignature(plans);
  const checkpointSignature = String(checkpoint?.planSetSignature || "").trim();
  if (checkpointSignature) {
    return checkpointSignature === currentSignature;
  }

  // Legacy fallback for old checkpoints without signature: trust only if the
  // checkpoint is at least as new as the currently analyzed plan set.
  const checkpointUpdatedAtMs = Date.parse(String(checkpoint?.updatedAt || checkpoint?.createdAt || ""));
  const analyzedAtMs = Date.parse(String(planAnalyzedAtIso || ""));
  if (!Number.isFinite(checkpointUpdatedAtMs) || !Number.isFinite(analyzedAtMs)) {
    return false;
  }
  return checkpointUpdatedAtMs >= analyzedAtMs;
}

function cloneCheckpointSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

function extractPlansFromWorkerBatches(workerBatches: any[]): any[] {
  return (Array.isArray(workerBatches) ? workerBatches : []).flatMap((batch: any) => (
    Array.isArray(batch?.plans) ? batch.plans : []
  ));
}

function resolveAdmittedWorkerTopology(workerBatches: any[]): WorkerTopologyContract | null {
  if (!Array.isArray(workerBatches) || workerBatches.length === 0) return null;
  const explicitTopology = workerBatches.find((batch) => batch?.workerTopology && typeof batch.workerTopology === "object")?.workerTopology;
  if (explicitTopology && typeof explicitTopology === "object") {
    return cloneCheckpointSnapshot(explicitTopology);
  }
  const topologyPlans = extractPlansFromWorkerBatches(workerBatches);
  if (topologyPlans.length === 0) return null;
  return buildWorkerTopologyContract(topologyPlans);
}

function getCheckpointWorkerBatchesSnapshot(checkpoint: any): any[] {
  return Array.isArray(checkpoint?.workerBatchesSnapshot)
    ? checkpoint.workerBatchesSnapshot
    : [];
}

function getCheckpointDispatchPlanSnapshot(checkpoint: any): any[] {
  return Array.isArray(checkpoint?.dispatchPlanSnapshot)
    ? checkpoint.dispatchPlanSnapshot
    : [];
}

function getCheckpointAdmittedWorkerTopology(checkpoint: any): WorkerTopologyContract | null {
  if (checkpoint?.admittedWorkerTopology && typeof checkpoint.admittedWorkerTopology === "object") {
    return checkpoint.admittedWorkerTopology;
  }
  return resolveAdmittedWorkerTopology(getCheckpointWorkerBatchesSnapshot(checkpoint));
}

export async function evaluateDispatchResumeReadiness(config): Promise<{
  checkpoint: any;
  interrupted: boolean;
  ready: boolean;
  reason:
    | "checkpoint_missing"
    | "checkpoint_not_resumable"
    | "active_workers_present"
    | "runtime_target_mismatch"
    | "checkpoint_snapshot_ready"
    | "missing_live_plan_source"
    | "empty_worker_batches"
    | "live_review_ready";
  planSource: "checkpoint_snapshot" | "live_review" | "none";
  planCount: number;
  workerBatchCount: number;
}> {
  const checkpoint = await readDispatchCheckpoint(config);
  if (!checkpoint) {
    return {
      checkpoint: null,
      interrupted: false,
      ready: false,
      reason: "checkpoint_missing",
      planSource: "none",
      planCount: 0,
      workerBatchCount: 0,
    };
  }

  if (!isDispatchCheckpointResumable(checkpoint)) {
    return {
      checkpoint,
      interrupted: false,
      ready: false,
      reason: "checkpoint_not_resumable",
      planSource: "none",
      planCount: 0,
      workerBatchCount: 0,
    };
  }

  if (await hasActiveWorkersAsync(config)) {
    return {
      checkpoint,
      interrupted: true,
      ready: false,
      reason: "active_workers_present",
      planSource: "none",
      planCount: 0,
      workerBatchCount: 0,
    };
  }

  if (!isRuntimeTargetSessionAlignedArtifact(checkpoint, config?.platformModeState, config?.activeTargetSession)) {
    return {
      checkpoint,
      interrupted: false,
      ready: false,
      reason: "runtime_target_mismatch",
      planSource: "none",
      planCount: 0,
      workerBatchCount: 0,
    };
  }

  const checkpointWorkerBatches = getCheckpointWorkerBatchesSnapshot(checkpoint);
  const checkpointPlanSnapshot = getCheckpointDispatchPlanSnapshot(checkpoint);
  if (checkpointWorkerBatches.length > 0 || checkpointPlanSnapshot.length > 0) {
    return {
      checkpoint,
      interrupted: true,
      ready: true,
      reason: "checkpoint_snapshot_ready",
      planSource: "checkpoint_snapshot",
      planCount: checkpointPlanSnapshot.length,
      workerBatchCount: checkpointWorkerBatches.length,
    };
  }

  const stateDir = config.paths?.stateDir || "state";
  const athenaReview = await readJson(path.join(stateDir, "athena_plan_review.json"), null);
  const prometheusAnalysisRaw = await readJson(path.join(stateDir, "prometheus_analysis.json"), null);
  const reviewPlansAvailable = Array.isArray(athenaReview?.patchedPlans) && athenaReview.patchedPlans.length > 0;
  if (reviewPlansAvailable && !isRuntimeTargetSessionAlignedArtifact(athenaReview, config?.platformModeState, config?.activeTargetSession)) {
    return {
      checkpoint,
      interrupted: false,
      ready: false,
      reason: "runtime_target_mismatch",
      planSource: "none",
      planCount: 0,
      workerBatchCount: 0,
    };
  }
  const prometheusAnalysis = isPrometheusAnalysisAlignedToRuntime(
    prometheusAnalysisRaw,
    config?.platformModeState,
    config?.activeTargetSession,
  )
    ? prometheusAnalysisRaw
    : null;
  const _plannerPromptLineage = clonePromptLineageState(
    checkpoint?.plannerPromptLineage || resolvePlannerPromptLineageFromAnalysis(prometheusAnalysis),
  );
  const _reviewerPromptLineage = clonePromptLineageState(
    checkpoint?.reviewerPromptLineage || resolveReviewerPromptLineageFromReview(athenaReview, prometheusAnalysis),
  );
  const livePlans = reviewPlansAvailable
    ? athenaReview.patchedPlans
    : (Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans : []);
  if (!athenaReview?.approved || livePlans.length === 0) {
    return {
      checkpoint,
      interrupted: true,
      ready: false,
      reason: "missing_live_plan_source",
      planSource: "none",
      planCount: 0,
      workerBatchCount: 0,
    };
  }

  const normalizedPlans = livePlans.map((plan: any) => {
    const resolved = resolveWorkerRole(plan?.role, plan?.taskKind || plan?.kind || "implementation");
    return resolved !== (plan?.role || "") ? { ...plan, role: resolved } : plan;
  });
  const workerBatches = applyDispatchBoundaryHardCap(buildRoleExecutionBatches(normalizedPlans, config) as any[]) as any[];
  if (workerBatches.length === 0) {
    return {
      checkpoint,
      interrupted: true,
      ready: false,
      reason: "empty_worker_batches",
      planSource: "live_review",
      planCount: livePlans.length,
      workerBatchCount: 0,
    };
  }

  return {
    checkpoint,
    interrupted: true,
    ready: true,
    reason: "live_review_ready",
    planSource: "live_review",
    planCount: livePlans.length,
    workerBatchCount: workerBatches.length,
  };
}

async function beginDispatchCheckpoint(
  config,
  plans,
  actualPlanCount?: number,
  opts: {
    planAnalyzedAt?: string;
    plannerPromptLineage?: unknown;
    reviewerPromptLineage?: unknown;
  } = {},
) {
  const nowIso = new Date().toISOString();
  const planSetSignature = computePlanSetSignature(plans);
  const admittedWorkerTopology = resolveAdmittedWorkerTopology(Array.isArray(plans) ? plans : []);
  const checkpoint = initializeRunSegmentState({
    schemaVersion: 2,
    status: "dispatching",
    createdAt: nowIso,
    updatedAt: nowIso,
    totalPlans: Array.isArray(plans) ? plans.length : 0,
    // planCount stores actual Prometheus plan count (totalPlans stores batch count)
    planCount: Number.isFinite(actualPlanCount) ? actualPlanCount : (Array.isArray(plans) ? plans.length : 0),
    completedPlans: 0,
    planSetSignature,
    planAnalyzedAt: opts?.planAnalyzedAt || null,
    plannerPromptLineage: clonePromptLineageState(opts?.plannerPromptLineage),
    reviewerPromptLineage: clonePromptLineageState(opts?.reviewerPromptLineage),
    dispatchPlanSnapshot: cloneCheckpointSnapshot(extractPlansFromWorkerBatches(Array.isArray(plans) ? plans : [])),
    workerBatchesSnapshot: cloneCheckpointSnapshot(Array.isArray(plans) ? plans : []),
    admittedWorkerTopology: cloneCheckpointSnapshot(admittedWorkerTopology),
    targetSession: resolveRuntimeTargetSessionStamp(config?.platformModeState, config?.activeTargetSession),
  }, {
    spanBatches: Number(config?.runtime?.runSegmentBatchSpan || RUN_SEGMENT_BATCH_SPAN_DEFAULT),
    historyMax: Number(config?.runtime?.runSegmentHistoryMax || RUN_SEGMENT_HISTORY_MAX_DEFAULT),
  });
  await writeDispatchCheckpoint(config, checkpoint);
  return checkpoint;
}

async function updateDispatchCheckpointProgress(config, checkpoint, completedPlans) {
  if (!checkpoint) return { rolledOver: false, activeSegment: null, previousSegment: null, historySize: 0 };
  checkpoint.completedPlans = Math.max(0, Math.min(Number(completedPlans || 0), Number(checkpoint.totalPlans || 0)));
  checkpoint.updatedAt = new Date().toISOString();
  const rolloverResult = applyRunSegmentRollover(checkpoint, {
    completedBatches: checkpoint.completedPlans,
    spanBatches: Number(config?.runtime?.runSegmentBatchSpan || RUN_SEGMENT_BATCH_SPAN_DEFAULT),
    historyMax: Number(config?.runtime?.runSegmentHistoryMax || RUN_SEGMENT_HISTORY_MAX_DEFAULT),
  });
  Object.assign(checkpoint, rolloverResult.checkpoint);
  await writeDispatchCheckpoint(config, checkpoint);
  return {
    rolledOver: rolloverResult.rolledOver,
    activeSegment: rolloverResult.activeSegment || null,
    previousSegment: rolloverResult.previousSegment || null,
    historySize: Array.isArray(checkpoint.runSegmentHistory) ? checkpoint.runSegmentHistory.length : 0,
  };
}

async function completeDispatchCheckpoint(config, checkpoint) {
  if (!checkpoint) return;
  checkpoint.completedPlans = Number(checkpoint.totalPlans || 0);
  checkpoint.status = "complete";
  checkpoint.updatedAt = new Date().toISOString();
  await writeDispatchCheckpoint(config, checkpoint);
}

export async function persistSkippedDispatchCheckpoint(
  config,
  plans,
  opts: {
    planAnalyzedAt?: string | null;
    plannerPromptLineage?: unknown;
    reviewerPromptLineage?: unknown;
  } = {},
) {
  const normalizedPlans = Array.isArray(plans) ? plans : [];
  if (normalizedPlans.length === 0) return null;
  const checkpoint = await beginDispatchCheckpoint(
    config,
    normalizedPlans,
    normalizedPlans.length,
    {
      planAnalyzedAt: opts?.planAnalyzedAt || null,
      plannerPromptLineage: opts?.plannerPromptLineage,
      reviewerPromptLineage: opts?.reviewerPromptLineage,
    },
  );
  await completeDispatchCheckpoint(config, checkpoint);
  return checkpoint;
}

export async function clearAthenaPlanRejectionLatch(config) {
  const stateDir = config.paths?.stateDir || "state";
  try {
    await fs.rm(path.join(stateDir, "athena_plan_rejection.json"), { force: true });
    return true;
  } catch (err) {
    warn(`[orchestrator] failed to clear athena rejection latch (non-fatal): ${String((err as Error)?.message || err)}`);
    return false;
  }
}

async function failCloseDispatchCheckpoint(config, checkpoint, detail: {
  reasonCode?: string | null;
  retryClass?: string | null;
  workerStatus?: string | null;
  batchIndex?: number | null;
  totalBatches?: number | null;
}) {
  if (!checkpoint) return;
  checkpoint.status = "failed_closed";
  checkpoint.updatedAt = new Date().toISOString();
  checkpoint.failClose = {
    failedAt: checkpoint.updatedAt,
    reasonCode: detail?.reasonCode || null,
    retryClass: detail?.retryClass || null,
    workerStatus: detail?.workerStatus || null,
    batchIndex: Number.isFinite(Number(detail?.batchIndex)) ? Number(detail?.batchIndex) : null,
    totalBatches: Number.isFinite(Number(detail?.totalBatches)) ? Number(detail?.totalBatches) : null,
  };
  await writeDispatchCheckpoint(config, checkpoint);
}

function isDispatchOutcomeSuccessful(workerResult) {
  return isCheckpointAdvanceEligibleStatus(workerResult?.status);
}

function clonePromptLineageState(value: unknown, defaults: Record<string, unknown> = {}) {
  if (!value || typeof value !== "object") return null;
  const normalized = normalizePromptLineageContract(value, defaults);
  return normalized.promptFamilyKey || normalized.lineageId ? normalized : null;
}

function resolvePlannerPromptLineageFromAnalysis(analysis: unknown) {
  const source = analysis && typeof analysis === "object" ? analysis as Record<string, unknown> : {};
  return clonePromptLineageState(
    source.promptLineage ?? (source.executionStrategy as Record<string, unknown> | undefined)?.promptLineage,
    {
      agent: "prometheus",
      stage: "planner",
      checkpointNs: CHECKPOINT_NS.PLANNER,
    },
  );
}

function resolveReviewerPromptLineageFromReview(review: unknown, analysis: unknown) {
  const reviewSource = review && typeof review === "object" ? review as Record<string, unknown> : {};
  const analysisLineage = resolvePlannerPromptLineageFromAnalysis(analysis);
  return clonePromptLineageState(
    reviewSource.promptLineage ?? analysisLineage,
    {
      parentLineageId: analysisLineage?.lineageId ?? null,
      promptFamilyKey: analysisLineage?.promptFamilyKey ?? null,
      stablePrefixHash: analysisLineage?.stablePrefixHash ?? null,
      familyLabel: analysisLineage?.familyLabel ?? "prometheus-cycle-delta",
      agent: "athena",
      stage: "reviewer",
      checkpointNs: CHECKPOINT_NS.REVIEWER,
    },
  );
}

function shouldFailCloseDispatchOutcome(workerResult) {
  const status = String(workerResult?.status || "").toLowerCase();
  if (status !== "error" && status !== "blocked") return false;
  const retryClass = String(workerResult?.retryClass || "").toLowerCase();
  const reasonCode = String(workerResult?.reasonCode || "").toUpperCase();
  if (retryClass === "no_retry" || reasonCode === "WIN32_PROCESS_TERMINATED") return true;
  // Runtime hook denials are always non-retryable — propagate as deterministic fail-close.
  const blockReason = String(workerResult?.dispatchBlockReason || "");
  return blockReason.startsWith("runtime_hook_denied:");
}

export function isCheckpointAdvanceEligibleStatus(status: unknown): boolean {
  return isAnalyticsCompletedWorkerStatus(status);
}

async function tryResumeDispatchFromCheckpoint(config, options: { force?: boolean } = {}) {
  const stateDir = config.paths?.stateDir || "state";
  const force = options?.force === true;
  const activeWorkers = await hasActiveWorkersAsync(config);
  if (activeWorkers) return false;

  let checkpoint = await readDispatchCheckpoint(config);
  if (!isRuntimeTargetSessionAlignedArtifact(checkpoint, config?.platformModeState, config?.activeTargetSession)) {
    await appendProgress(config, "[RESUME] Aborting resume — dispatch checkpoint target session is not aligned to the active runtime");
    return false;
  }
  const checkpointWorkerBatches = getCheckpointWorkerBatchesSnapshot(checkpoint);
  const checkpointPlanSnapshot = getCheckpointDispatchPlanSnapshot(checkpoint);
  const hasCheckpointBatchSnapshot = checkpointWorkerBatches.length > 0;
  const hasCheckpointPlanSnapshot = checkpointPlanSnapshot.length > 0;

  const athenaReview = await readJson(path.join(stateDir, "athena_plan_review.json"), null);
  const reviewPlansAvailable = Array.isArray(athenaReview?.patchedPlans) && athenaReview.patchedPlans.length > 0;
  if (reviewPlansAvailable && !isRuntimeTargetSessionAlignedArtifact(athenaReview, config?.platformModeState, config?.activeTargetSession)) {
    await appendProgress(config, "[RESUME] Aborting resume — Athena plan review belongs to a different target session/runtime");
    return false;
  }
  const prometheusAnalysisRaw = await readJson(path.join(stateDir, "prometheus_analysis.json"), null);
  const prometheusAnalysis = isPrometheusAnalysisAlignedToRuntime(
    prometheusAnalysisRaw,
    config?.platformModeState,
    config?.activeTargetSession,
  )
    ? prometheusAnalysisRaw
    : null;
  const plannerPromptLineage = clonePromptLineageState(
    checkpoint?.plannerPromptLineage || resolvePlannerPromptLineageFromAnalysis(prometheusAnalysis),
  );
  const reviewerPromptLineage = clonePromptLineageState(
    checkpoint?.reviewerPromptLineage || resolveReviewerPromptLineageFromReview(athenaReview, prometheusAnalysis),
  );
  const livePlans = reviewPlansAvailable
    ? athenaReview.patchedPlans
    : (Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans : []);
  const plans = hasCheckpointPlanSnapshot ? checkpointPlanSnapshot : livePlans;
  const planSource = hasCheckpointPlanSnapshot ? "checkpoint_snapshot" : "live_review";
  if (!hasCheckpointPlanSnapshot && (!athenaReview?.approved || plans.length === 0)) return false;
  const _normalizedPlansResume = plans.map((p: any) => {
    const resolved = resolveWorkerRole(p?.role, p?.taskKind || p?.kind || "implementation");
    return resolved !== (p?.role || "") ? { ...p, role: resolved } : p;
  });
  const _rawWorkerBatchesResume = hasCheckpointBatchSnapshot
    ? checkpointWorkerBatches
    : buildRoleExecutionBatches(_normalizedPlansResume, config);
  // ── Final dispatch-boundary hard cap (resume path) ───────────────────────
  // Apply only when rebuilding from live plans; checkpoint snapshots already
  // reflect the exact admitted dispatch topology from the interrupted run.
  const workerBatches = hasCheckpointBatchSnapshot
    ? _rawWorkerBatchesResume
    : applyDispatchBoundaryHardCap(_rawWorkerBatchesResume as any[]) as typeof _rawWorkerBatchesResume;
  if (workerBatches.length === 0) return false;

  // Stamp deterministic task IDs so resume-path artifact events carry non-empty taskIds.
  stampBatchPlanTaskIds(workerBatches as any[]);

  const checkpointMatchesPlanIdentity = checkpointMatchesPlanSet(
    checkpoint,
    plans,
    String(prometheusAnalysis?.analyzedAt || athenaReview?.reviewedAt || ""),
  );

  if (!force && checkpointMatchesPlanIdentity && isDispatchCheckpointCompleteForTotal(checkpoint, workerBatches.length)) {
    return false;
  }

  if (!isDispatchCheckpointResumable(checkpoint)) {
    if (!force && checkpoint && checkpoint.status === "complete" && checkpointMatchesPlanIdentity) {
      return false;
    }
    checkpoint = await beginDispatchCheckpoint(config, workerBatches, plans.length, {
      planAnalyzedAt: String(prometheusAnalysis?.analyzedAt || athenaReview?.reviewedAt || ""),
      plannerPromptLineage,
      reviewerPromptLineage,
    });
  }

  const startIndex = Math.max(0, Math.min(Number(checkpoint.completedPlans || 0), workerBatches.length));
  if (startIndex >= workerBatches.length) {
    await completeDispatchCheckpoint(config, checkpoint);
    return false;
  }
  const remainingWorkerBatches = workerBatches.slice(startIndex);
  const remainingPlans = extractPlansFromWorkerBatches(remainingWorkerBatches);
  const admittedWorkerTopologyForResume = getCheckpointAdmittedWorkerTopology(checkpoint) || resolveAdmittedWorkerTopology(workerBatches);

  // Pre-dispatch governance gate — same checks as runSingleCycle to prevent
  // resuming into a frozen/canary-breached/guardrail-paused state.
  const resumeCycleId = `resume-${Date.now()}`;
  try {
    const gateDecision = await evaluatePreDispatchGovernanceGate(
      config,
      remainingPlans,
      resumeCycleId,
      null,
      { admittedWorkerTopology: admittedWorkerTopologyForResume },
    );
    emitEvent(EVENTS.GOVERNANCE_GATE_EVALUATED, EVENT_DOMAIN.GOVERNANCE, resumeCycleId, {
      blocked: gateDecision.blocked,
      reason: gateDecision.reason || null,
      inputSnapshot: {
        planCount: remainingPlans.length,
        admittedPlanCount: plans.length,
        resumedFromCheckpoint: true,
        startIndex,
      }
    });
    if (gateDecision.blocked) {
      const reasonMsg = gateDecision.dispatchBlockReason || gateDecision.reason || "pre_dispatch_gate_blocked";
      await appendProgress(config,
        `[RESUME] Pre-dispatch governance gate blocked resumed dispatch — reason=${reasonMsg}`
      );
      await appendAlert(config, {
        severity: ALERT_SEVERITY.HIGH,
        source: "orchestrator",
        title: "Resumed worker dispatch blocked by pre-dispatch governance gate",
        message: `reason=${reasonMsg} action=${gateDecision.action || "none"} cycleId=${resumeCycleId}`
      });
      return true;
    }
  } catch (err) {
    warn(`[orchestrator] Pre-dispatch governance gate failed during resume (non-fatal): ${String(err?.message || err)}`);
    emitEvent(EVENTS.ORCHESTRATION_HEALTH_DEGRADED, EVENT_DOMAIN.ORCHESTRATION, resumeCycleId, {
      reason: "governance_gate_exception",
      error: String(err?.message || err),
      context: "resume_dispatch"
    });
  }

  await appendProgress(config,
    force
      ? `[RESUME] Force-resuming dispatch checkpoint: batch ${startIndex + 1}/${workerBatches.length}`
      : checkpointMatchesPlanIdentity
        ? `[RESUME] Resuming dispatch checkpoint: batch ${startIndex + 1}/${workerBatches.length}`
        : `[RESUME] Existing approved plan detected — dispatching from batch ${startIndex + 1}/${workerBatches.length} without replanning`
  );
  await appendProgress(config, `[RESUME] Source=${planSource} checkpointStatus=${String(checkpoint?.status || "missing")} checkpointVersion=${String(checkpoint?.checkpointVersion || "n/a")}`);

  await safeUpdatePipelineProgress(config, "workers_dispatching", `Resuming dispatch from batch ${startIndex + 1}/${workerBatches.length}`, {
    workersTotal: workerBatches.length,
    workersDone: startIndex,
    resumedFromCheckpoint: true,
    forcedResume: force
  });

  // ── Strict wave boundary tracking (resume path) ──────────────────────────
  // Mirror the same wave-boundary gate used in the primary dispatch path.
  // Initialise from the wave of the last completed batch if we are resuming
  // mid-run, so the first crossing event accurately reflects the transition.
  let resumeCurrentWave: number | null = startIndex > 0
    ? (typeof (workerBatches[startIndex - 1] as any)?.wave === "number"
       ? (workerBatches[startIndex - 1] as any).wave : null)
    : null;
  const resumeRetryTelemetry = await loadRetryTelemetryContext(config);
  const resumeArtifactCycleId = normalizeCycleId((await readPipelineProgress(config).catch(() => null))?.startedAt || checkpoint?.createdAt);

  for (let index = startIndex; index < workerBatches.length; index += 1) {
    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      await appendProgress(config, `[RESUME] Stop requested — checkpoint preserved at batch ${index + 1}/${workerBatches.length}`);
      return true;
    }

    const batch = workerBatches[index];

    // ── Wave boundary gate (resume) ────────────────────────────────────────
    const resumeBatchWave = typeof (batch as any).wave === "number" ? (batch as any).wave : null;
    if (resumeBatchWave !== null && resumeBatchWave !== resumeCurrentWave) {
      if (resumeCurrentWave !== null) {
        await appendProgress(config,
          `[WAVE_BOUNDARY] Wave ${resumeCurrentWave} complete — all batches succeeded. Crossing to wave ${resumeBatchWave}.`
        );
      }
      resumeCurrentWave = resumeBatchWave;
      await appendProgress(config,
        `[WAVE_BOUNDARY] Starting wave ${resumeBatchWave} — batch ${index + 1}/${workerBatches.length} roleBatch=${Number((batch as any)?.roleBatchIndex || 1)}/${Number((batch as any)?.roleBatchTotal || 1)} role=${String((batch as any)?.role || "worker")}`
      );
    }

    const resumeDispatchTarget = await resolveDispatchTargetForPlan(config, batch);
    const resumeWorkerLabel = resumeDispatchTarget.roleName === String(batch.role || "worker")
      ? resumeDispatchTarget.roleName
      : `${String(batch.role || "worker")} -> ${resumeDispatchTarget.roleName}`;

    await safeUpdatePipelineProgress(config, "workers_running", `Resumed worker batch ${index + 1}/${workerBatches.length}: ${resumeWorkerLabel}`, {
      workersTotal: workerBatches.length,
      workersDone: index,
      currentWorker: resumeDispatchTarget.roleName,
      resumedFromCheckpoint: true,
      forcedResume: force
    });

    let workerResult;
    let transientRetries = 0;
    await persistWorkerDispatchArtifacts(config, {
      cycleId: resumeArtifactCycleId,
      role: String(batch?.role || ""),
      phase: "start",
      batch,
      resolvedRole: resumeDispatchTarget.roleName,
    });
    for (;;) {
      try {
        workerResult = await dispatchWorker(config, batch);
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 200);
        await appendProgress(config, `[RESUME] Worker ${batch.role} failed: ${msg}`);
        warn(`[orchestrator] resumed worker dispatch error: ${msg}`);
        workerResult = { roleName: resumeDispatchTarget.roleName, status: "error", summary: msg };
      }

      // Auto-retry on transient API errors with escalating cooldown
      const isTransient = String(workerResult?.status || "") === "transient_error";
      const retryDecision = isTransient
        ? assessRetryExpectedROI({
            attempt: transientRetries + 1,
            maxRetries: MAX_TRANSIENT_RETRIES,
            taskKind: String((batch as any)?.taskKind || "implementation"),
            premiumUsageData: resumeRetryTelemetry.premiumUsageData,
            benchmarkGroundTruth: resumeRetryTelemetry.benchmarkGroundTruth,
            minExpectedGain: Number(config?.runtime?.retryRoiMinExpectedGain ?? 0.18),
          })
        : null;
      if (isTransient && retryDecision?.allowRetry) {
        transientRetries++;
        const cooldownMs = transientRetries * 3 * 60 * 1000; // 3min, 6min, 9min
        await appendProgress(config,
          `[RESUME] Transient API error — retry ${transientRetries}/${MAX_TRANSIENT_RETRIES}, expected_gain=${retryDecision.expectedGain.toFixed(3)} (threshold=${retryDecision.threshold.toFixed(3)}), cooling down ${Math.round(cooldownMs / 1000)}s`
        );
        await sleep(cooldownMs);
        continue;
      }
      if (isTransient && retryDecision && !retryDecision.allowRetry) {
        await appendProgress(
          config,
          `[RESUME] Transient API error — retry suppressed (low ROI): expected_gain=${retryDecision.expectedGain.toFixed(3)} threshold=${retryDecision.threshold.toFixed(3)} reason=${retryDecision.reason}`
        );
      }
      break;
    }
    await persistWorkerDispatchArtifacts(config, {
      cycleId: resumeArtifactCycleId,
      role: String(batch?.role || ""),
      phase: "complete",
      batch,
      workerResult,
      resolvedRole: resumeDispatchTarget.roleName,
    });

    if (!isDispatchOutcomeSuccessful(workerResult)) {
      if (shouldFailCloseDispatchOutcome(workerResult)) {
        await failCloseDispatchCheckpoint(config, checkpoint, {
          reasonCode: workerResult?.reasonCode || null,
          retryClass: workerResult?.retryClass || null,
          workerStatus: workerResult?.status || null,
          batchIndex: index + 1,
          totalBatches: workerBatches.length,
        });
        await appendProgress(config,
          `[RESUME][FAIL_CLOSE] Worker batch ${index + 1}/${workerBatches.length} ended with status=${workerResult?.status || "unknown"} reason_code=${workerResult?.reasonCode || "unknown"} retry_class=${workerResult?.retryClass || "none"}; checkpoint marked failed_closed (no retry)`
        );
        await safeUpdatePipelineProgress(config, "cycle_complete", `Resumed dispatch fail-closed at batch ${index + 1}/${workerBatches.length}`, {
          workersTotal: workerBatches.length,
          workersDone: index,
          resumedFromCheckpoint: true,
          forcedResume: force,
        });
        return true;
      }
      await appendProgress(config,
        `[RESUME] Worker batch ${index + 1}/${workerBatches.length} ended with status=${workerResult?.status || "unknown"}; checkpoint not advanced so it can be retried`
      );
      return true;
    }

    await waitForWorkersToFinish(config);
    const resumeCheckpointUpdate = await updateDispatchCheckpointProgress(config, checkpoint, index + 1);
    if (resumeCheckpointUpdate.rolledOver && resumeCheckpointUpdate.activeSegment && resumeCheckpointUpdate.previousSegment) {
      await appendProgress(
        config,
        `[RUN_SEGMENT] rollover complete: segment ${String((resumeCheckpointUpdate.previousSegment as any).segmentIndex)} -> ${String((resumeCheckpointUpdate.activeSegment as any).segmentIndex)}`
      );
      await safeUpdatePipelineProgress(config, "workers_running", `Run segment rollover to ${String((resumeCheckpointUpdate.activeSegment as any).segmentIndex)}`, {
        workersTotal: workerBatches.length,
        workersDone: index + 1,
        resumedFromCheckpoint: true,
        forcedResume: force,
        runSegment: resumeCheckpointUpdate.activeSegment,
        runSegmentRollover: resumeCheckpointUpdate.previousSegment,
        runSegmentHistorySize: resumeCheckpointUpdate.historySize,
      });
    }

    const resumeCooldown = resolveInterBatchCooldownDecision(config, {
      remainingBatches: workerBatches.length - (index + 1),
      workerStatus: String(workerResult?.status || ""),
      transientRetries,
      dispatchBlockReason: String(workerResult?.dispatchBlockReason || workerResult?.dispatchContract?.dispatchBlockReason || ""),
    });
    if (resumeCooldown.cooldownMs > 0) {
      await appendProgress(config, `[RESUME] Inter-batch cooldown ${Math.round(resumeCooldown.cooldownMs / 1000)}s reason=${resumeCooldown.reason}`);
      await sleep(resumeCooldown.cooldownMs);
    }
  }

  await completeDispatchCheckpoint(config, checkpoint);

  await safeUpdatePipelineProgress(config, "workers_finishing", "All resumed workers finishing up", {
    workersTotal: workerBatches.length,
    workersDone: workerBatches.length,
    resumedFromCheckpoint: true,
    forcedResume: force
  });

  await appendProgress(config, `[RESUME] Resumed dispatch complete — ${workerBatches.length} batch(es) processed`);
  await safeUpdatePipelineProgress(config, "cycle_complete", `Resumed cycle complete — ${workerBatches.length} batch(es)`, {
    workersTotal: workerBatches.length,
    workersDone: workerBatches.length,
    resumedFromCheckpoint: true,
    forcedResume: force
  });

  return true;
}

export async function runOnce(config) {
  const stateDir = config.paths?.stateDir || "state";
  await fs.mkdir(stateDir, { recursive: true });
  const startupGuard = await evaluateSingleTargetStartupRequirements(config);
  if (!startupGuard.ok) {
    await appendProgress(config, `[RUN_ONCE][SINGLE_TARGET][BLOCKED] ${startupGuard.missing.join(", ")} missing — one-shot startup aborted`);
    throw new Error(buildSingleTargetStartupGuardMessage(startupGuard));
  }
  await Promise.all([
    fs.writeFile(path.join(stateDir, "live_worker_janus.log"), "[leadership_live]\n[run_once] Janus live log ready...\n", "utf8"),
    fs.writeFile(path.join(stateDir, "live_worker_athena.log"), "[leadership_live]\n[run_once] Athena live log ready...\n", "utf8"),
    initializeAggregateLiveLog(stateDir, "run_once")
  ]);

  const targetLifecycle = await prepareTargetSessionForCycle(config);
  if (targetLifecycle.action !== "continue") {
    await appendProgress(config, `[RUN_ONCE][TARGET] ${targetLifecycle.message || "target session not ready"}`);
    await safeUpdatePipelineProgress(config, "idle", targetLifecycle.message || "Target session not ready");
    return;
  }

  await runSingleCycle(config);
}

export async function runResumeDispatch(config) {
  const stateDir = config.paths?.stateDir || "state";
  await fs.mkdir(stateDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(stateDir, "live_worker_janus.log"), "[leadership_live]\n[resume] Janus live log ready...\n", "utf8"),
    fs.writeFile(path.join(stateDir, "live_worker_athena.log"), "[leadership_live]\n[resume] Athena live log ready...\n", "utf8"),
    initializeAggregateLiveLog(stateDir, "resume")
  ]);

  const resumed = await tryResumeDispatchFromCheckpoint(config, { force: true });
  if (!resumed) {
    throw new Error("No resumable Step-4 checkpoint found (approved Athena review + plans required)");
  }
}

export async function runRebase(_config, _opts: Record<string, unknown> = {}) {
  return { triggered: false, reason: "not applicable in athena-gated architecture" };
}

export async function processEscalationQueueClosureWorkflow(config) {
  const closure = await processEscalationQueueClosures(config);
  if (closure.resolvedCount > 0) {
    await appendProgress(
      config,
      `[LOOP] Escalation closure workflow resolved ${closure.resolvedCount} item(s): ${closure.resolvedFingerprints.join(", ")}`
    );
  }
  if (closure.replayUpdatedCount > 0) {
    await appendProgress(
      config,
      `[LOOP] Escalation replay actions updated for ${closure.replayUpdatedCount} unresolved item(s)`
    );
  }
  return closure;
}

// ── Loop intervals ────────────────────────────────────────────────────────────
const WORKERS_DONE_POLL_MS = 30 * 1000;

function roleToWorkerStateFile(role) {
  const slug = String(role || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `worker_${slug}.json`;
}

type WorkerCycleRecord = {
  cycleId: string;
  status: string;
  updatedAt: string;
  workerSessions: Record<string, any>;
  workerActivity: Record<string, any[]>;
  completedTaskIds: string[];
};

function normalizeCycleId(value: unknown): string {
  const v = String(value || "").trim();
  return v || `cycle-${Date.now()}`;
}

function extractPlanTaskIds(planLike: any): string[] {
  const plans = Array.isArray(planLike?.plans) ? planLike.plans : [planLike];
  const ids: string[] = plans
    .map((p: any) => String(p?.task_id || p?.id || "").trim())
    .filter(Boolean);
  return [...new Set<string>(ids)];
}

/**
 * Derive a short task summary string from a batch object for activity-event
 * logging.  The batch object itself has no `.task` / `.title` field — those
 * live on the child plan objects.  This helper joins the first plan's task
 * text (up to 120 chars) with an ellipsis when multiple plans are present so
 * the logged `task` field is always non-empty when plans are available.
 */
export function extractBatchTaskSummary(batch: any): string {
  const plans: any[] = Array.isArray(batch?.plans) ? batch.plans : [];
  if (plans.length === 0) return String(batch?.task || batch?.title || "");
  const first = String(plans[0]?.task || plans[0]?.title || "").trim().slice(0, 120);
  return plans.length > 1 ? `${first} (+${plans.length - 1} more)` : first;
}

/**
 * Stamp deterministic `task_id` values on every plan in every batch that does
 * not already carry an explicit `task_id` or `id`.  IDs are generated at
 * plan-batch time (before dispatch) so they are stable across hot-reload
 * restarts and resume paths that rebuild batches from the same plan set.
 *
 * planOffset tracks the global position across all batches so plans in later
 * batches receive distinct IDs from plans in earlier batches that happen to
 * share the same task text.
 */
export function stampBatchPlanTaskIds(workerBatches: any[]): void {
  let planOffset = 0;
  for (const batch of workerBatches) {
    const plans: any[] = Array.isArray(batch?.plans) ? batch.plans : [];
    const role = String(batch?.role || "unknown").trim();
    for (const plan of plans) {
      if (!String(plan?.task_id || plan?.id || "").trim()) {
        plan.task_id = generateDeterministicTaskId(role, planOffset, String(plan?.task || ""));
      }
      planOffset += 1;
    }
  }
}

function toLegacySessionsBody(rawSessions: unknown): Record<string, any> {
  if (!rawSessions || typeof rawSessions !== "object" || Array.isArray(rawSessions)) return {};
  const out = { ...(rawSessions as Record<string, any>) };
  delete (out as any).schemaVersion;
  return out;
}

async function loadWorkerCycleArtifact(stateDir: string): Promise<{ payload: Record<string, any>; migrated: boolean }> {
  const artifactPath = path.join(stateDir, WORKER_CYCLE_ARTIFACTS_FILE);
  const raw = await readJsonSafe(artifactPath);
  if (!raw.ok) {
    return {
      payload: {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        latestCycleId: null,
        cycles: {},
      },
      migrated: false,
    };
  }
  const migrated = migrateWorkerCycleArtifacts(raw.data);
  if (!migrated.ok || !migrated.data) {
    warn(
      `[orchestrator] worker cycle artifact invalid; resetting canonical file: reason=${migrated.reason} fromVersion=${String(migrated.fromVersion)}`
    );
    return {
      payload: {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        latestCycleId: null,
        cycles: {},
      },
      migrated: false,
    };
  }
  return { payload: migrated.data as Record<string, any>, migrated: migrated.reason === "ok" };
}

let workerArtifactWriteQueue: Promise<void> = Promise.resolve();

async function withWorkerArtifactWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = workerArtifactWriteQueue;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  workerArtifactWriteQueue = prior.then(() => gate, () => gate);
  await prior;
  try {
    return await fn();
  } finally {
    if (release) release();
  }
}

async function persistWorkerDispatchArtifacts(config, input: {
  cycleId: string;
  role: string;
  phase: "start" | "complete" | "recovery";
  batch?: any;
  workerResult?: any;
  recoveredSignal?: string;
  resolvedRole?: string;
}) {
  const stateDir = config?.paths?.stateDir || "state";
  const nowIso = new Date().toISOString();
  const cycleId = normalizeCycleId(input.cycleId);
  const role = String(input.role || "").trim();
  if (!role) return;

  await withWorkerArtifactWriteLock(async () => {
    const loaded = await loadWorkerCycleArtifact(stateDir);
    const payload = loaded.payload;
    const cycles = payload.cycles && typeof payload.cycles === "object" && !Array.isArray(payload.cycles)
      ? payload.cycles as Record<string, any>
      : {};
    payload.cycles = cycles;
    payload.latestCycleId = cycleId;
    payload.updatedAt = nowIso;

    const existing = cycles[cycleId] && typeof cycles[cycleId] === "object" ? cycles[cycleId] : {};
    const cycleRecord: WorkerCycleRecord = {
      cycleId,
      status: String(existing.status || "dispatching"),
      updatedAt: nowIso,
      workerSessions: existing.workerSessions && typeof existing.workerSessions === "object" && !Array.isArray(existing.workerSessions)
        ? existing.workerSessions
        : {},
      workerActivity: existing.workerActivity && typeof existing.workerActivity === "object" && !Array.isArray(existing.workerActivity)
        ? existing.workerActivity
        : {},
      completedTaskIds: Array.isArray(existing.completedTaskIds)
        ? [...new Set<string>((existing.completedTaskIds as unknown[]).map((id) => String(id || "").trim()).filter(Boolean))]
        : [],
    };

    if (!cycleRecord.workerActivity[role]) cycleRecord.workerActivity[role] = [];
    if (!cycleRecord.workerSessions[role]) cycleRecord.workerSessions[role] = {};
    const session = cycleRecord.workerSessions[role];
    const taskIds = extractPlanTaskIds(input.batch);
    const taskSummary = extractBatchTaskSummary(input.batch);
    // Unify logical and resolved role identity in the session artifact.
    // resolvedRole is the final dispatched target (after access-fallback resolution);
    // role is the logical batch kind. Both are preserved so consumers can correlate.
    if (input.resolvedRole && input.resolvedRole !== role) {
      session.resolvedRole = input.resolvedRole;
    }

    if (input.phase === "start") {
      session.status = "working";
      session.startedAt = nowIso;
      session.updatedAt = nowIso;
      cycleRecord.workerActivity[role].push({
        at: nowIso,
        status: "working",
        task: taskSummary,
        taskIds,
        wave: Number.isFinite(Number(input.batch?.wave)) ? Number(input.batch.wave) : null,
      });
    } else if (input.phase === "complete") {
      const status = String(input.workerResult?.status || "unknown").toLowerCase();
      session.status = "idle";
      session.lastStatus = status;
      session.updatedAt = nowIso;
      if (!session.startedAt) session.startedAt = null;
      cycleRecord.workerActivity[role].push({
        at: nowIso,
        status,
        task: taskSummary,
        taskIds,
        pr: input.workerResult?.pr || null,
        dispatchBlockReason: input.workerResult?.dispatchBlockReason || null,
        wave: Number.isFinite(Number(input.batch?.wave)) ? Number(input.batch.wave) : null,
      });
      if (status === "done" || status === "success") {
        cycleRecord.completedTaskIds = [...new Set([...cycleRecord.completedTaskIds, ...taskIds])];
      }
    } else {
      session.status = "idle";
      session.updatedAt = nowIso;
      cycleRecord.workerActivity[role].push({
        at: nowIso,
        status: "recovered",
        signal: String(input.recoveredSignal || "stale"),
        taskIds,
        wave: Number.isFinite(Number(input.batch?.wave)) ? Number(input.batch.wave) : null,
      });
    }

    cycles[cycleId] = cycleRecord;
    // Canonical write is the source of truth — must succeed before compatibility snapshots.
    await writeJson(path.join(stateDir, WORKER_CYCLE_ARTIFACTS_FILE), payload);

    // Compatibility snapshots for existing consumers.
    // Each write is best-effort: a failure is logged but never propagates so the
    // canonical artifact remains the authoritative record when compat writes fail.
    try {
      const sessionsPath = path.join(stateDir, "worker_sessions.json");
      const legacySessionsRaw = await readJson(sessionsPath, {});
      const legacySessions = toLegacySessionsBody(legacySessionsRaw);
      legacySessions[role] = cycleRecord.workerSessions[role];
      await writeJson(sessionsPath, addSchemaVersion(legacySessions, STATE_FILE_TYPE.WORKER_SESSIONS));
    } catch (sessErr) {
      warn(`[orchestrator] compat worker_sessions.json write failed (non-fatal): ${String((sessErr as any)?.message || sessErr)}`);
    }

    try {
      const workerPath = path.join(stateDir, roleToWorkerStateFile(role));
      const existingWorkerState = await readJson(workerPath, {});
      const existingActivity = Array.isArray(existingWorkerState?.activityLog) ? existingWorkerState.activityLog : [];
      const latestEntry = cycleRecord.workerActivity[role][cycleRecord.workerActivity[role].length - 1] || null;
      const nextActivity = latestEntry ? [...existingActivity, latestEntry] : existingActivity;
      await writeJson(workerPath, {
        ...(existingWorkerState && typeof existingWorkerState === "object" ? existingWorkerState : {}),
        status: cycleRecord.workerSessions[role]?.status || "idle",
        startedAt: cycleRecord.workerSessions[role]?.startedAt || null,
        updatedAt: nowIso,
        activityLog: nextActivity.slice(-200),
      });
    } catch (workerStateErr) {
      warn(`[orchestrator] compat worker state file write failed (non-fatal): role=${role} ${String((workerStateErr as any)?.message || workerStateErr)}`);
    }
  });
}

function getLastWorkerReportedStatus(session, role) {
  const history = Array.isArray(session?.history) ? session.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry) continue;
    if (role && entry.from && entry.from !== role) continue;
    const status = String(entry.status || "").toLowerCase();
    if (status) return status;
  }
  return "";
}

function getLastWorkerTaskIds(session, role): string[] {
  const history = Array.isArray(session?.history) ? session.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry) continue;
    if (role && entry.from && entry.from !== role) continue;
    const taskIds = Array.isArray(entry.taskIds)
      ? entry.taskIds.map((taskId: unknown) => String(taskId || "").trim()).filter(Boolean)
      : [];
    if (taskIds.length > 0) return taskIds;
  }
  return [];
}

function getCompletedCheckpointTaskIds(checkpoint: any): Set<string> {
  const completedTaskIds = new Set<string>();
  const completedPlans = Math.max(0, Number(checkpoint?.completedPlans || 0));
  const workerBatches = getCheckpointWorkerBatchesSnapshot(checkpoint);
  for (let index = 0; index < Math.min(completedPlans, workerBatches.length); index += 1) {
    const batch = workerBatches[index];
    const plans = Array.isArray(batch?.plans) ? batch.plans : [];
    for (const plan of plans) {
      const taskId = String(plan?.task_id || plan?.id || "").trim();
      if (taskId) completedTaskIds.add(taskId);
    }
  }
  return completedTaskIds;
}

function shouldRecoverWorkingSessionFromCheckpoint(session: WorkerSessionRecord, role: string, checkpoint: any): boolean {
  if (String(session?.status || "") !== "working") return false;
  if (!isDispatchCheckpointResumable(checkpoint)) return false;
  const completedTaskIds = getCompletedCheckpointTaskIds(checkpoint);
  if (completedTaskIds.size === 0) return false;
  const lastTaskIds = getLastWorkerTaskIds(session, role);
  if (lastTaskIds.length === 0) return false;
  return lastTaskIds.every((taskId) => completedTaskIds.has(taskId));
}

function parseIsoTimestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

export function shouldRecoverWorkingSessionAfterDaemonRestart(session, daemonStartedAtIso) {
  if (String(session?.status || "") !== "working") return false;

  const daemonStartedAtMs = parseIsoTimestampMs(daemonStartedAtIso);
  if (daemonStartedAtMs === null) return false;

  const timestamps = [
    session?.startedAt,
    session?.updatedAt,
    ...(Array.isArray(session?.history) ? session.history.map((entry) => entry?.at) : []),
  ]
    .map(parseIsoTimestampMs)
    .filter((value) => value !== null);

  if (timestamps.length === 0) return false;
  return timestamps.every((value) => value < daemonStartedAtMs);
}

export async function recoverStaleWorkerSessions(config, stateDir, sessions) {
  const recoveredRoles = [];
  const recoveredSignals = new Map<string, string>();
  const daemonPid = await readDaemonPid(config).catch(() => null);
  const daemonStartedAtIso = typeof daemonPid?.startedAt === "string" ? daemonPid.startedAt : null;
  const checkpoint = await readDispatchCheckpoint(config).catch(() => null);

  for (const [role, session] of Object.entries(sessions || {}) as Array<[string, WorkerSessionRecord]>) {
    if (session?.status !== "working") continue;

    if (daemonStartedAtIso && shouldRecoverWorkingSessionAfterDaemonRestart(session, daemonStartedAtIso)) {
      session.status = "idle";
      recoveredRoles.push(role);
      recoveredSignals.set(role, "daemon-restart-stale-working-session");
      continue;
    }

    const reportedStatus = getLastWorkerReportedStatus(session, role);
    if (isTerminalWorkerStatus(reportedStatus)) {
      session.status = "idle";
      recoveredRoles.push(role);
      recoveredSignals.set(role, reportedStatus || "terminal-history");
      continue;
    }

    if (shouldRecoverWorkingSessionFromCheckpoint(session, role, checkpoint)) {
      session.status = "idle";
      recoveredRoles.push(role);
      recoveredSignals.set(role, "checkpoint-completed-batch");
      continue;
    }
  }

  if (recoveredRoles.length === 0) return false;

  const pipeline = await readPipelineProgress(config).catch(() => null);
  const cycleId = normalizeCycleId(pipeline?.startedAt);

  for (const role of recoveredRoles) {
    // Recovery updates flow through the canonical artifact write path so
    // session/activity state transitions stay atomic per role transition.
    await persistWorkerDispatchArtifacts(config, {
      cycleId,
      role,
      phase: "recovery",
      recoveredSignal: recoveredSignals.get(role) || "stale",
    });
  }

  await appendProgress(
    config,
    `[LOOP] Recovered stale worker states (${recoveredRoles.length}): ${recoveredRoles.join(", ")}`
  );
  warn(`[orchestrator] Recovered stale worker states: ${recoveredRoles.join(", ")}`);
  return true;
}

async function hasActiveWorkersAsync(config) {
  try {
    const stateDir = config.paths?.stateDir || "state";

    // Prefer canonical artifact (source of truth) over legacy worker_sessions.json.
    // The compat write to worker_sessions.json is best-effort; if it fails the
    // canonical file still has the authoritative session state.
    const rawArtifact = await readJsonSafe(path.join(stateDir, WORKER_CYCLE_ARTIFACTS_FILE));
    if (rawArtifact.ok) {
      const migrated = migrateWorkerCycleArtifacts(rawArtifact.data);
      if (migrated.ok && migrated.data) {
        const pipeline = await readPipelineProgress(config).catch(() => null);
        const selectedCycle = selectWorkerCycleRecord(migrated.data, pipeline?.startedAt);
        const cycle = selectedCycle.record;
        if (cycle && typeof cycle.workerSessions === "object" && !Array.isArray(cycle.workerSessions)) {
          const sessions = cycle.workerSessions as Record<string, WorkerSessionRecord>;
          const workerActivity = cycle.workerActivity && typeof cycle.workerActivity === "object"
            ? cycle.workerActivity as Record<string, any[]>
            : {};
          // Synthesize a history-augmented sessions map so recoverStaleWorkerSessions
          // can detect terminal statuses recorded in the activity log.
          const augmented: Record<string, WorkerSessionRecord> = {};
          for (const [role, session] of Object.entries(sessions)) {
            const log = Array.isArray(workerActivity[role]) ? workerActivity[role] : [];
            augmented[role] = {
              ...session,
              // Synthesize history from the activity log for recovery detection.
              history: log.map(e => ({
                status: String(e.status || ""),
                from: role,
                at: e.at || "",
                taskIds: Array.isArray(e.taskIds) ? e.taskIds : [],
              })),
            } as WorkerSessionRecord;
          }
          await recoverStaleWorkerSessions(config, stateDir, augmented);
          return Object.values(augmented).some(s => s?.status === "working");
        }
      }
    }

    // Fallback: legacy worker_sessions.json (compat snapshot).
    const sessions = await readJson(path.join(stateDir, "worker_sessions.json"), {});
    await recoverStaleWorkerSessions(config, stateDir, sessions);
    return (Object.values(sessions) as WorkerSessionRecord[]).some(s => s?.status === "working");
  } catch { return false; }
}

async function waitForWorkersToFinish(config) {
  while (true) {
    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      await appendProgress(config, `[LOOP] Stop requested while waiting workers: reason=${stopReq.reason || "unknown"}`);
      return false;
    }
    const stillActive = await hasActiveWorkersAsync(config);
    if (!stillActive) {
      await appendProgress(config, "[LOOP] All workers done — cycle complete");
      return true;
    }
    await sleep(WORKERS_DONE_POLL_MS);
  }
}

// ── Post-completion cleanup ──────────────────────────────────────────────────

async function postCompletionCleanup(config) {
  const repo = config.env?.targetRepo;
  const token = config.env?.githubToken;
  if (!repo || !token) return;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "BOX/1.0"
  };
  const base = `https://api.github.com/repos/${repo}`;

  try {
    const prsRes = await fetch(`${base}/pulls?state=open&per_page=50`, { headers });
    if (prsRes.ok) {
      const openPrsJson = await prsRes.json();
      const openPrs = Array.isArray(openPrsJson) ? openPrsJson as GithubPullRequestSummary[] : [];
      const mergedRes = await fetch(`${base}/pulls?state=closed&per_page=50&sort=updated&direction=desc`, { headers });
      const closedJson = mergedRes.ok ? await mergedRes.json() : [];
      const closedPrs = Array.isArray(closedJson) ? closedJson as GithubPullRequestSummary[] : [];
      const mergedTitles = closedPrs
        .filter(p => p.merged_at)
        .map(p => String(p.title || "").toLowerCase().trim());

      for (const pr of openPrs) {
        const title = String(pr.title || "").toLowerCase().trim();
        const branch = String(pr.head?.ref || "");
        // Only auto-close BOX-owned PRs with an exact title match against a merged PR.
        // Fuzzy/prefix matching is intentionally removed to prevent collateral closures.
        const isBoxBranch = ["box/", "wave", "pr-", "qa/", "scan/"].some(p => branch.startsWith(p));
        const isDuplicate = isBoxBranch && mergedTitles.some(mt => mt === title);
        if (isDuplicate) {
          await fetch(`${base}/pulls/${pr.number}`, {
            method: "PATCH",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ state: "closed" })
          });
          await fetch(`${base}/issues/${pr.number}/comments`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ body: "Duplicate of an already-merged PR. Auto-closed by BOX post-completion cleanup." })
          });
          await appendProgress(config, `[CLEANUP] Closed duplicate PR #${pr.number}: ${pr.title}`);
        }
      }
    }

    const branchesRes = await fetch(`${base}/branches?per_page=100`, { headers });
    if (branchesRes.ok) {
      const branchesJson = await branchesRes.json();
      const branches = Array.isArray(branchesJson) ? branchesJson as GithubBranchSummary[] : [];
      const openPrBranches = new Set();
      const openPrsRes = await fetch(`${base}/pulls?state=open&per_page=100`, { headers });
      if (openPrsRes.ok) {
        const opsJson = await openPrsRes.json();
        const ops = Array.isArray(opsJson) ? opsJson as GithubPullRequestSummary[] : [];
        for (const pr of ops) {
          if (pr.head?.ref) openPrBranches.add(pr.head.ref);
        }
      }

      const boxPrefixes = ["box/", "wave", "pr-", "qa/", "scan/"];
      for (const branch of branches) {
        const name = branch.name;
        if (name === "main" || name === "master" || name === "develop") continue;
        if (!boxPrefixes.some(p => name.startsWith(p))) continue;
        if (openPrBranches.has(name)) continue;

        try {
          const deleteRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(name)}`, {
            method: "DELETE",
            headers
          });
          if (deleteRes.ok) {
            await appendProgress(config, `[CLEANUP] Deleted stale branch: ${name}`);
          }
        } catch { /* non-fatal */ }
      }
    }

    await fetch(base, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ delete_branch_on_merge: true })
    });
  } catch (err) {
    warn(`[orchestrator] post-completion cleanup error: ${String(err?.message || err)}`);
  }
}

// ── Resolve logical plan role to actual worker agent ────────────────────────

const IMPLEMENTATION_WORKER = "evolution-worker";

// Roles that have agent files but lack implementation tools (read/edit/execute).
// Implementation tasks assigned to these roles must be redirected to evolution-worker.
const ANALYSIS_ONLY_ROLES = new Set(["athena", "prometheus", "janus"]);

const ATHENA_REVIEW_CAPABLE_ROLES = new Set(["evolution-worker", "quality-worker", "athena", "prometheus"]);

function resolveWorkerRole(logicalRole, taskKind, taskText = "") {
  const role = String(logicalRole || "").toLowerCase().trim();
  const kind = String(taskKind || "").toLowerCase();
  const isImplementation = !kind || kind === "implementation";
  const isAthenaRelated = isAthenaReviewOrPostmortemTask(kind, taskText);

  // Analysis-only roles cannot execute implementation tasks — redirect to evolution-worker
  if (isImplementation && ANALYSIS_ONLY_ROLES.has(role)) return IMPLEMENTATION_WORKER;
  if (isAthenaRelated && !ATHENA_REVIEW_CAPABLE_ROLES.has(role)) return IMPLEMENTATION_WORKER;

  // If the role has a dedicated agent file with full tools, use it as-is
  const slug = nameToSlug(role);
  if (slug && agentFileExists(slug)) return logicalRole;

  // Fallback: all implementation tasks without a matching agent go to evolution-worker
  return IMPLEMENTATION_WORKER;
}

async function resolveRoleWithAccessFallback(config, roleName) {
  const normalizedRole = String(roleName || "").toLowerCase().trim();
  const canonicalRole = nameToSlug(normalizedRole) || normalizedRole;
  if (!canonicalRole || canonicalRole === IMPLEMENTATION_WORKER) return roleName;

  const stateDir = config?.paths?.stateDir || "state";
  const queueState = await readJson(path.join(stateDir, "escalation_queue.json"), { entries: [] });
  const entries = Array.isArray(queueState?.entries) ? queueState.entries : [];
  const hasUnresolvedAccessBlocked = entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (entry.resolved === true) return false;
    const roleRaw = String(entry.role || "").toLowerCase().trim();
    const role = nameToSlug(roleRaw) || roleRaw;
    const cls = String(entry.blockingReasonClass || "").toUpperCase().trim();
    return role === canonicalRole && cls === "ACCESS_BLOCKED";
  });

  return hasUnresolvedAccessBlocked ? IMPLEMENTATION_WORKER : roleName;
}

function buildDispatchTaskText(plan) {
  const batchPlans = Array.isArray(plan?.plans) ? plan.plans : null;
  const orderedBatchLines = batchPlans
    ? batchPlans.map((item, i) => {
        const title = String(item?.task || item?.title || `Task ${i + 1}`);
        const deps = Array.isArray(item?.dependencies)
          ? item.dependencies
          : Array.isArray(item?.dependsOn)
            ? item.dependsOn
            : [];
        const files = Array.isArray(item?.target_files)
          ? item.target_files
          : Array.isArray(item?.targetFiles)
            ? item.targetFiles
            : [];
        const depText = deps.length > 0 ? ` | dependsOn=${deps.map((d) => String(d)).join(", ")}` : "";
        const fileText = files.length > 0 ? ` | files=${files.slice(0, 5).map((f) => String(f)).join(", ")}` : "";
        return `${i + 1}. ${title}${depText}${fileText}`;
      }).join("\n")
    : "";
  const task = batchPlans
    ? `Execute this bundled work package in a single worker session.\nYou MUST execute tasks in exact numeric order (1 -> N).\nDo not parallelize steps inside this batch.\nDo not skip a step; if a step is blocked, stop and report blocked with the exact blocker.\n\nOrdered steps:\n${orderedBatchLines}`
    : plan?.task;

  return { batchPlans, task };
}

async function resolveDispatchTargetForPlan(config, plan) {
  const logicalRole = plan?.role;
  const taskKind = plan?.taskKind || plan?.kind || "implementation";
  const { batchPlans, task } = buildDispatchTaskText(plan);
  const resolvedRoleName = resolveWorkerRole(logicalRole, taskKind, task);
  const roleName = await resolveRoleWithAccessFallback(config, resolvedRoleName);
  return {
    logicalRole: String(logicalRole || "").trim() || "worker",
    taskKind,
    batchPlans,
    task,
    resolvedRoleName,
    roleName,
  };
}

// ── Dispatch a single worker from a Prometheus plan item ───────────────────

async function dispatchWorker(config, plan) {
  // Resolve actual worker agent: plan.role is a logical category ("orchestrator", "athena", etc.).
  // Map roles without a dedicated .agent.md to "evolution-worker" for implementation tasks.
  const dispatchTarget = await resolveDispatchTargetForPlan(config, plan);
  const _logicalRole = dispatchTarget.logicalRole;
  const taskKind = dispatchTarget.taskKind;
  const batchPlans = dispatchTarget.batchPlans;
  const task = dispatchTarget.task;
  const resolvedRoleName = dispatchTarget.resolvedRoleName;
  const roleName = dispatchTarget.roleName;
  if (roleName !== resolvedRoleName) {
    await appendProgress(
      config,
      `[DISPATCH] Access fallback reroute: ${resolvedRoleName} -> ${roleName} (unresolved ACCESS_BLOCKED escalation)`
    );
  }
  const contextBlocks: string[] = [];
  if (batchPlans) {
    for (let i = 0; i < batchPlans.length; i += 1) {
      const item = batchPlans[i];
      const taskLine = String(item?.task || item?.title || `Task ${i + 1}`);
      const ctxLine = String(item?.context || item?.scope || "").trim();
      const deps = Array.isArray(item?.dependencies)
        ? item.dependencies
        : Array.isArray(item?.dependsOn)
          ? item.dependsOn
          : [];
      const files = Array.isArray(item?.target_files)
        ? item.target_files
        : Array.isArray(item?.targetFiles)
          ? item.targetFiles
          : [];
      const depsLine = deps.length > 0 ? `\nDepends On: ${deps.map((d) => String(d)).join(", ")}` : "";
      const filesLine = files.length > 0 ? `\nTarget Files: ${files.map((f) => String(f)).join(", ")}` : "";
      const baseLine = ctxLine
        ? `Task ${i + 1}: ${taskLine}\nContext: ${ctxLine}${depsLine}${filesLine}`
        : `Task ${i + 1}: ${taskLine}${depsLine}${filesLine}`;
      const hydrated = await hydrateDispatchContextWithCiEvidence(config, item, baseLine);
      contextBlocks.push(hydrated);
    }
  }
  const context = batchPlans
    ? contextBlocks.join("\n\n")
    : await hydrateDispatchContextWithCiEvidence(config, plan, (plan.context || ""));
  const verification = batchPlans
    ? batchPlans.map((item, i) => {
        const rule = String(item?.verification || "").trim();
        return rule ? `${i + 1}. ${rule}` : "";
      }).filter(Boolean).join("\n")
    : (plan.verification || "");
  const targetFiles = batchPlans
    ? [...new Set(batchPlans.flatMap((item) => {
        const files = Array.isArray(item?.target_files)
          ? item.target_files
          : Array.isArray(item?.targetFiles)
            ? item.targetFiles
            : [];
        return files.map((file) => String(file || "").trim()).filter(Boolean);
      }))]
    : (Array.isArray(plan?.target_files)
        ? plan.target_files
        : Array.isArray(plan?.targetFiles)
          ? plan.targetFiles
          : []).map((file) => String(file || "").trim()).filter(Boolean);

  const capabilityCheck = assertRoleCapabilityForTask(config, roleName, taskKind, task);
  if (!capabilityCheck.allowed) {
    const summary = `Dispatch blocked by role capability check: ${capabilityCheck.code} — ${capabilityCheck.message}`;
    await appendProgress(config, `[DISPATCH] ${summary}`);
    emitEvent(EVENTS.ORCHESTRATION_HEALTH_DEGRADED, EVENT_DOMAIN.ORCHESTRATION, `role-capability-${Date.now()}`, {
      reason: "role_capability_check_failed",
      roleName,
      taskKind: String(taskKind || "unknown"),
      code: capabilityCheck.code,
      message: capabilityCheck.message,
    });
    return {
      roleName,
      status: "blocked",
      pr: null,
      summary,
      filesChanged: "",
      raw: summary,
      verificationEvidence: null,
      dispatchContract: {
        doneWorkerWithVerificationReportEvidence: false,
        dispatchBlockReason: `role_capability_check_failed:${capabilityCheck.code}`,
        replayClosure: buildReplayClosureEvidence(summary),
      },
      dispatchBlockReason: `role_capability_check_failed:${capabilityCheck.code}`,
    };
  }

  if (batchPlans) {
    const headline = String(batchPlans[0]?.task || batchPlans[0]?.title || "bundled tasks");
    await appendProgress(config, `[DISPATCH] Sending ${batchPlans.length} plan(s) to ${roleName}: ${headline}`);
  } else {
    await appendProgress(config, `[DISPATCH] Sending task to ${roleName}: ${task}`);
  }

  // ── Model routing telemetry: log expected-value ranking for this taskKind ────
  // Reads previous cycle analytics and logs which model is preferred for the
  // current task kind, respecting MIN_TELEMETRY_SAMPLE_THRESHOLD.  Non-blocking —
  // routing decision is advisory only; actual model selection is in worker_runner.
  try {
    const { readCycleAnalytics } = await import("./cycle_analytics.js");
    const prevAnalytics = await readCycleAnalytics(config);
    const candidates = [
      config?.copilot?.defaultModel || "Claude Sonnet 4.6",
      config?.copilot?.strongModel,
      config?.copilot?.efficientModel,
    ].filter((m): m is string => typeof m === "string" && m.length > 0);
    if (candidates.length > 0) {
      const routing = rankModelsByTaskKindExpectedValue(taskKind, candidates, prevAnalytics);
      if (routing.usedTelemetry) {
        await appendProgress(config,
          `[DISPATCH][MODEL_ROUTING] taskKind=${taskKind} preferredModel=${routing.rankedModels[0]} (telemetry-backed)`
        );
      }
    }
  } catch { /* non-critical — routing telemetry log must never block dispatch */ }

  const result = await runWorkerConversation(config, roleName, {
    task,
    context,
    verification,
    taskKind,
    targetFiles,
  });

  const workerResult = {
    roleName,
    status: result?.status || "unknown",
    pr: result?.prUrl || null,
    summary: result?.summary || "",
    filesChanged: result?.filesTouched || "",
    raw: String(result?.fullOutput || "").slice(0, 3000),
    verificationEvidence: result?.verificationEvidence || null,
    dispatchContract: result?.dispatchContract || null,
    dispatchBlockReason: result?.dispatchContract?.dispatchBlockReason || null,
  };

  // Log worker dispatch to live agents log
  appendAggregateLiveLogSync(
    config.paths.stateDir,
    `worker:${workerResult.roleName}`,
    JSON.stringify(
      {
        status: workerResult.status,
        summary: workerResult.summary,
        pr: workerResult.pr,
        filesChanged: workerResult.filesChanged,
        wave: (plan as any)?.wave ?? null
      },
      null,
      2
    )
  );

  return workerResult;
}

// ── Count completed plans from worker state files ─────────────────────────

async function countCompletedPlans(config, plans) {
  const stateDir = config.paths?.stateDir || "state";

  const checkpoint = await readDispatchCheckpoint(config);
  const prometheusAnalysis = await readJson(path.join(stateDir, "prometheus_analysis.json"), null);
  const checkpointMatchesIdentity = checkpointMatchesPlanSet(
    checkpoint,
    plans,
    String(prometheusAnalysis?.analyzedAt || ""),
  );
  // Match on planCount (actual plan count) if present, fall back to legacy totalPlans comparison
  const checkpointPlanCount = Number(checkpoint?.planCount ?? checkpoint?.totalPlans ?? 0);
  if (checkpoint && checkpointPlanCount === plans.length && checkpointMatchesIdentity) {
    // When all batches have completed the checkpoint status is set to "complete"
    // and completedPlans is set to totalPlans (batch count). Treat that as all plans done.
    if (checkpoint.status === "complete") {
      return {
        completed: plans.map((plan) => ({ plan, workerState: null, lastLog: null })),
        pending: []
      };
    }
    // Otherwise use the batch-progress ratio to approximate plan progress
    const batchTotal = Number(checkpoint.totalPlans || 1);
    const batchDone = Math.min(Number(checkpoint.completedPlans || 0), batchTotal);
    const completedCount = Math.round((batchDone / batchTotal) * plans.length);
    return {
      completed: plans.slice(0, completedCount).map((plan) => ({ plan, workerState: null, lastLog: null })),
      pending: plans.slice(completedCount)
    };
  }

  // Fallback: inspect individual worker state files
  const completed = [];
  const pending = [];

  for (const plan of plans) {
    const role = String(plan.role || "").toLowerCase().replace(/\s+/g, "_");
    const workerFile = path.join(stateDir, `worker_${role}.json`);
    const ws = await readJson(workerFile, null);
    if (!ws) {
      pending.push(plan);
      continue;
    }
    const lastLog = Array.isArray(ws.activityLog) ? ws.activityLog[ws.activityLog.length - 1] : null;
    if (isCheckpointAdvanceEligibleStatus(lastLog?.status)) {
      completed.push({ plan, workerState: ws, lastLog });
    } else {
      pending.push(plan);
    }
  }

  return { completed, pending };
}

function hasExplicitPlanDependencies(plan: any): boolean {
  const dependsOn = Array.isArray(plan?.dependsOn) ? plan.dependsOn : [];
  const dependencies = Array.isArray(plan?.dependencies) ? plan.dependencies : [];
  const waveDepends = Array.isArray(plan?.waveDepends) ? plan.waveDepends : [];
  return dependsOn.length > 0 || dependencies.length > 0 || waveDepends.length > 0;
}

function getPlanOrderedStepComplexity(plan: any): number {
  const orderedSteps = Array.isArray(plan?.orderedSteps) ? plan.orderedSteps.length
    : Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria.length
    : 1;
  return Math.max(1, Number.isFinite(Number(orderedSteps)) ? Number(orderedSteps) : 1);
}

function splitBatchByOrderedStepComplexity(batch: any, cap: number): any[] {
  const plans = Array.isArray(batch?.plans) ? batch.plans : [];
  if (plans.length === 0) return [batch];
  const maxSteps = Math.max(1, Math.floor(cap));
  const chunks: any[][] = [];
  let current: any[] = [];
  let currentCost = 0;

  for (const plan of plans) {
    const cost = getPlanOrderedStepComplexity(plan);
    if (cost > maxSteps) {
      return [];
    }
    if (current.length > 0 && currentCost + cost > maxSteps) {
      chunks.push(current);
      current = [plan];
      currentCost = cost;
    } else {
      current.push(plan);
      currentCost += cost;
    }
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length <= 1) return [batch];

  return chunks.map((chunk, idx) => {
    const orderedStepCount = chunk.reduce((sum, p) => sum + getPlanOrderedStepComplexity(p), 0);
    return {
      ...batch,
      plans: chunk,
      orderedStepCount,
      bundleIndex: Number(batch?.bundleIndex || 1) + idx,
      _orderedStepComplexitySplit: true,
    };
  });
}

function tightenRoleWaveBatches(workerBatches: any[], config: any): { batches: any[]; mergedCount: number } {
  if (!Array.isArray(workerBatches) || workerBatches.length <= 1) {
    return { batches: Array.isArray(workerBatches) ? workerBatches : [], mergedCount: 0 };
  }
  const enabled = config?.runtime?.tightRoleWavePacking !== false;
  if (!enabled) return { batches: workerBatches, mergedCount: 0 };

  const maxMergedPlansRaw = Number(config?.runtime?.tightRoleWavePackingMaxMergedPlans ?? 3);
  const maxMergedPlans = Number.isFinite(maxMergedPlansRaw) && maxMergedPlansRaw > 0
    ? Math.floor(maxMergedPlansRaw)
    : 3;

  const compacted: any[] = [];
  let mergedCount = 0;

  for (const batch of workerBatches) {
    const currentPlans = Array.isArray(batch?.plans) ? batch.plans : [];
    if (compacted.length === 0) {
      compacted.push(batch);
      continue;
    }

    const prev = compacted[compacted.length - 1];
    const prevPlans = Array.isArray(prev?.plans) ? prev.plans : [];
    const sameRole = String(prev?.role || "") === String(batch?.role || "");
    const sameWave = Number(prev?.wave || 1) === Number(batch?.wave || 1);
    const withinPlanCap = prevPlans.length + currentPlans.length <= maxMergedPlans;
    const dependencySafe = [...prevPlans, ...currentPlans].every((p) => !hasExplicitPlanDependencies(p));
    const tokenCap = Number(prev?.usableContextTokens || 0) || Number(batch?.usableContextTokens || 0) || 0;
    const combinedTokens = Number(prev?.estimatedTokens || 0) + Number(batch?.estimatedTokens || 0);
    const withinTokenCap = tokenCap <= 0 || combinedTokens <= tokenCap;

    if (sameRole && sameWave && withinPlanCap && dependencySafe && withinTokenCap) {
      prev.plans = [...prevPlans, ...currentPlans];
      prev.estimatedTokens = combinedTokens;
      prev.contextUtilizationPercent = tokenCap > 0 ? Math.round((combinedTokens / tokenCap) * 100) : Number(prev?.contextUtilizationPercent || 0);
      mergedCount += 1;
      continue;
    }

    compacted.push(batch);
  }

  const roleTotals = new Map<string, number>();
  for (const batch of compacted) {
    const role = String(batch?.role || "evolution-worker");
    roleTotals.set(role, (roleTotals.get(role) || 0) + 1);
  }
  const roleIndices = new Map<string, number>();
  const reindexed = compacted.map((batch, index) => {
    const role = String(batch?.role || "evolution-worker");
    const roleIndex = (roleIndices.get(role) || 0) + 1;
    roleIndices.set(role, roleIndex);
    return {
      ...batch,
      bundleIndex: index + 1,
      totalBundles: compacted.length,
      roleBatchIndex: roleIndex,
      roleBatchTotal: roleTotals.get(role) || 1,
      githubFinalizer: roleIndex === (roleTotals.get(role) || 1),
    };
  });

  return { batches: reindexed, mergedCount };
}

export function resolveInterBatchCooldownDecision(
  config: any,
  options: {
    remainingBatches?: number;
    workerStatus?: string | null;
    transientRetries?: number;
    dispatchBlockReason?: string | null;
  } = {},
): { cooldownMs: number; reason: string } {
  const baseDelayRaw = Number(config?.runtime?.interBatchDelayMs || 90000);
  const baseDelay = Number.isFinite(baseDelayRaw) && baseDelayRaw > 0
    ? Math.floor(baseDelayRaw)
    : 0;
  if (baseDelay <= 0) return { cooldownMs: 0, reason: "disabled" };

  const remainingBatches = Number(options.remainingBatches || 0);
  if (remainingBatches <= 0) return { cooldownMs: 0, reason: "no_remaining_batches" };

  const transientRetries = Number(options.transientRetries || 0);
  if (transientRetries > 0) {
    return { cooldownMs: baseDelay, reason: "transient_retry_recovery" };
  }

  const fastDelayDefault = Math.min(baseDelay, 15000);
  const fastDelayRaw = Number(config?.runtime?.interBatchSuccessDelayMs ?? fastDelayDefault);
  const fastDelay = Number.isFinite(fastDelayRaw) && fastDelayRaw >= 0
    ? Math.min(baseDelay, Math.floor(fastDelayRaw))
    : fastDelayDefault;
  const dispatchBlockReason = String(options.dispatchBlockReason || "").trim().toLowerCase();
  if (
    dispatchBlockReason.startsWith("access_blocked:")
    || dispatchBlockReason.startsWith("environment_blocked:")
    || dispatchBlockReason.includes("permission denied and could not request permission from user")
  ) {
    return {
      cooldownMs: fastDelay,
      reason: fastDelay > 0 ? "environment_blocker_fast_path" : "environment_blocker_no_delay",
    };
  }
  const workerStatus = String(options.workerStatus || "").toLowerCase().trim();
  if (workerStatus === "done" || workerStatus === "success" || workerStatus === "skipped") {
    return {
      cooldownMs: fastDelay,
      reason: fastDelay < baseDelay ? "successful_batch_fast_path" : "successful_batch_default_delay",
    };
  }

  return { cooldownMs: baseDelay, reason: "conservative_fallback" };
}

async function resolveAdaptivePlanCap(config: any, stateDir: string): Promise<{ cap: number; reason: string }> {
  const enabled = config?.runtime?.adaptivePlanCap?.enabled !== false;
  if (!enabled) return { cap: Number(config?.runtime?.adaptivePlanCap?.highCap ?? 6), reason: "disabled" };

  const lowCapRaw = Number(config?.runtime?.adaptivePlanCap?.lowCap ?? 4);
  const mediumCapRaw = Number(config?.runtime?.adaptivePlanCap?.mediumCap ?? 5);
  const highCapRaw = Number(config?.runtime?.adaptivePlanCap?.highCap ?? 6);
  const lowCap = Math.max(3, Math.min(6, Number.isFinite(lowCapRaw) ? Math.floor(lowCapRaw) : 4));
  const mediumCap = Math.max(lowCap, Math.min(6, Number.isFinite(mediumCapRaw) ? Math.floor(mediumCapRaw) : 5));
  const highCap = Math.max(mediumCap, Math.min(6, Number.isFinite(highCapRaw) ? Math.floor(highCapRaw) : 6));

  try {
    const autonomy = await readJson(path.join(stateDir, "autonomy_band_status.json"), null);
    const history = Array.isArray(autonomy?.history) ? autonomy.history.slice(-3) : [];
    if (history.length === 0) return { cap: lowCap, reason: "no_history" };

    const completionVals = history
      .map((h: any) => Number(h?.completionRate))
      .filter((v: number) => Number.isFinite(v));
    const premiumVals = history
      .map((h: any) => Number(h?.premiumEfficiency))
      .filter((v: number) => Number.isFinite(v));

    const completionAvg = completionVals.length > 0
      ? completionVals.reduce((sum: number, v: number) => sum + v, 0) / completionVals.length
      : 0;
    const premiumAvg = premiumVals.length > 0
      ? premiumVals.reduce((sum: number, v: number) => sum + v, 0) / premiumVals.length
      : 0;

    if (completionAvg >= 0.85 && premiumAvg >= 0.55) {
      return { cap: highCap, reason: `high_perf completionAvg=${completionAvg.toFixed(2)} premiumAvg=${premiumAvg.toFixed(2)}` };
    }
    if (completionAvg >= 0.75 && premiumAvg >= 0.40) {
      return { cap: mediumCap, reason: `mid_perf completionAvg=${completionAvg.toFixed(2)} premiumAvg=${premiumAvg.toFixed(2)}` };
    }
    return { cap: lowCap, reason: `low_perf completionAvg=${completionAvg.toFixed(2)} premiumAvg=${premiumAvg.toFixed(2)}` };
  } catch {
    return { cap: lowCap, reason: "fallback_on_read_error" };
  }
}

function estimateAthenaPlanPromptChars(plan: any): number {
  if (!plan || typeof plan !== "object") return 0;
  const targetFiles = Array.isArray(plan.target_files)
    ? plan.target_files
    : Array.isArray(plan.targetFiles)
      ? plan.targetFiles
      : [];
  const acceptance = Array.isArray(plan.acceptance_criteria) ? plan.acceptance_criteria : [];
  const dependencies = Array.isArray(plan.dependencies) ? plan.dependencies : [];
  const text = [
    String(plan.role || ""),
    String(plan.task || ""),
    String(plan.scope || ""),
    String(plan.before_state || plan.beforeState || ""),
    String(plan.after_state || plan.afterState || ""),
    String(plan.verification || ""),
    String(plan.riskLevel || ""),
    JSON.stringify(targetFiles),
    JSON.stringify(acceptance),
    JSON.stringify(dependencies),
    JSON.stringify(plan.premortem || {}),
  ].join("\n");
  return text.length;
}

async function resolveAthenaReviewAdmission(
  config: any,
  stateDir: string,
  plans: any[],
): Promise<{ admittedPlans: any[]; deferredPlans: any[]; reason: string; estimatedPromptChars: number; cap: number }> {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { admittedPlans: [], deferredPlans: [], reason: "empty", estimatedPromptChars: 0, cap: 0 };
  }

  const adaptive = await resolveAdaptivePlanCap(config, stateDir);
  const hardCapRaw = Number(config?.runtime?.athenaReviewMaxPlans ?? config?.runtime?.athenaReview?.maxPlans ?? 6);
  const hardCap = Number.isFinite(hardCapRaw) && hardCapRaw > 0
    ? Math.max(1, Math.min(12, Math.floor(hardCapRaw)))
    : 6;
  const planCountCap = Math.max(1, Math.min(adaptive.cap, hardCap));

  const charBudgetRaw = Number(config?.runtime?.athenaReviewPromptCharBudget ?? config?.runtime?.athenaReview?.promptCharBudget ?? 22_000);
  const charBudget = Number.isFinite(charBudgetRaw) && charBudgetRaw > 2000
    ? Math.floor(charBudgetRaw)
    : 22_000;

  const scored = plans.map((plan: any, index: number) => {
    const priority = Number.isFinite(Number(plan?.priority)) ? Number(plan.priority) : 99;
    const wave = Number.isFinite(Number(plan?.wave)) ? Number(plan.wave) : 99;
    const risk = String(plan?.riskLevel || "low").toLowerCase();
    const highRiskBoost = risk === "high" ? -1 : 0;
    const promptChars = estimateAthenaPlanPromptChars(plan);
    return { plan, index, priority, wave, highRiskBoost, promptChars };
  });

  scored.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.highRiskBoost !== b.highRiskBoost) return a.highRiskBoost - b.highRiskBoost;
    if (a.wave !== b.wave) return a.wave - b.wave;
    return a.index - b.index;
  });

  let runningChars = 0;
  const admittedScored: typeof scored = [];
  const deferredScored: typeof scored = [];

  for (const item of scored) {
    const withinCount = admittedScored.length < planCountCap;
    const nextChars = runningChars + item.promptChars;
    const withinChars = admittedScored.length === 0 || nextChars <= charBudget;

    if (withinCount && withinChars) {
      admittedScored.push(item);
      runningChars = nextChars;
    } else {
      deferredScored.push(item);
    }
  }

  if (admittedScored.length === 0) {
    admittedScored.push(scored[0]);
    deferredScored.splice(0, deferredScored.length, ...scored.slice(1));
    runningChars = scored[0]?.promptChars || 0;
  }

  // Preserve original order for review determinism.
  admittedScored.sort((a, b) => a.index - b.index);
  deferredScored.sort((a, b) => a.index - b.index);

  const reason = `adaptiveCap=${adaptive.cap} hardCap=${hardCap} finalCap=${planCountCap} charBudget=${charBudget} estimated=${runningChars}`;
  return {
    admittedPlans: admittedScored.map((i) => i.plan),
    deferredPlans: deferredScored.map((i) => i.plan),
    reason,
    estimatedPromptChars: runningChars,
    cap: planCountCap,
  };
}

// ── Single full cycle: Janus → Prometheus → Athena → Workers → Athena ──────

async function runSingleCycle(config, _token?: CancellationToken | null) {
  const stateDir = config.paths?.stateDir || "state";
  const cycleStartedAt = new Date().toISOString();
  let _cycleRequests = 0;
  let _premiumEventSeq = 0;
  const premiumEvents: Array<{
    id: number;
    agent: string;
    reason: string;
    success: boolean | null;
  }> = [];
  const leadershipBudgetRaw = Number(config?.runtime?.maxLeadershipRequestsPerCycle ?? 5);
  const leadershipBudget = Number.isFinite(leadershipBudgetRaw) && leadershipBudgetRaw >= 3
    ? Math.floor(leadershipBudgetRaw)
    : 5;
  const spendPremium = async (
    agentLabel: string,
    reason: string,
    options: { pendingOutcome?: boolean } = {},
  ) => {
    _cycleRequests += 1;
    const eventId = ++_premiumEventSeq;
    premiumEvents.push({
      id: eventId,
      agent: agentLabel,
      reason,
      success: options.pendingOutcome === true ? null : true,
    });
    await appendProgress(config, `[PREMIUM_USAGE] spent=${_cycleRequests} agent=${agentLabel} reason=${reason}`);
    return { requestCount: _cycleRequests, eventId };
  };
  const markPremiumOutcome = (eventId: number, success: boolean) => {
    const idx = premiumEvents.findIndex((row) => row.id === eventId);
    if (idx >= 0) {
      premiumEvents[idx] = { ...premiumEvents[idx], success };
    }
  };
  const canSpendLeadership = (cost = 1) => (_cycleRequests + Math.max(1, Math.floor(cost))) <= leadershipBudget;
  await appendProgress(config, `[CYCLE] ════════════════════════════════════════`);
  await appendProgress(config, `[CYCLE START] ${cycleStartedAt}`);

  // Clean up any leftover .tmp files from a previous crash before reading state.
  const cleanupResult = await cleanupStaleTempFiles(stateDir);
  if (cleanupResult.removed.length > 0) {
    await appendProgress(config, `[CYCLE] Cleaned up ${cleanupResult.removed.length} stale temp file(s): ${cleanupResult.removed.join(", ")}`);
  }
  if (!cleanupResult.ok) {
    warn(`[orchestrator] stale-temp cleanup failed (non-fatal): ${String(cleanupResult.error?.message || cleanupResult.error)}`);
  }

  // Audit critical state files at cycle start — writes orchestrator_health.json.
  // This ensures runOnce (used in tests and CLI) also surfaces corrupt state.
  await auditCriticalStateFiles(config, stateDir);

  // ── Preflight capability checks ───────────────────────────────────────────
  // Validate system readiness before spending premium requests.
  if (config.runtime?.disablePreflight !== true) {
    try {
      const doctorResult = await runDoctor(config);
      if (!doctorResult.ok) {
        const failedChecks = Object.entries(doctorResult.checks)
          .filter(([, v]) => !v).map(([k]) => k).join(", ");
        await appendProgress(config,
          `[CYCLE][PREFLIGHT] Capability checks failed: ${failedChecks}. Warnings: ${doctorResult.warnings.join("; ")}`
        );
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: "Preflight capability checks failed",
          message: `Failed: ${failedChecks}. ${doctorResult.warnings.join("; ")}`
        });
        // Non-blocking: log but continue (critical checks would have thrown)
      } else if (doctorResult.warnings.length > 0) {
        await appendProgress(config, `[CYCLE][PREFLIGHT] All checks passed. Warnings: ${doctorResult.warnings.join("; ")}`);
      }
    } catch (err) {
      warn(`[orchestrator] preflight check failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  // Guardrail gate: if SKIP_CYCLE is active, skip planning to avoid acting on stale state.
  // Gated by systemGuardian.enabled (rollback: set to false to retain detection without enforcement).
  if (config.systemGuardian?.enabled !== false) {
    try {
      const skipActive = await isGuardrailActive(config, GUARDRAIL_ACTION.SKIP_CYCLE);
      if (skipActive) {
        await appendProgress(config,
          "[CYCLE] SKIP_CYCLE guardrail active — skipping this planning cycle (stale state detected)"
        );
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: "Planning cycle skipped by SKIP_CYCLE guardrail",
          message: "SKIP_CYCLE guardrail is active — catastrophe scenario may still be present. Revert guardrail to resume."
        });
        return;
      }
    } catch (err) {
      // Non-fatal: guardrail check failure must not block the cycle
      warn(`[orchestrator] SKIP_CYCLE guardrail check failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  // Step 1: Janus analyzes state and decides what to do (1 request)
  await appendProgress(config, "[CYCLE] ── Step 1: Janus analyzing system state ──");
  await appendProgress(config, `[AGENT] ★ ═══[ JANUS ]═══ ★  req#${_cycleRequests + 1} this cycle`);
  const janusPremiumEvent = await spendPremium("janus", "cycle_directive", { pendingOutcome: true });

  // ── Closure SLA audit: flag stale escalations (advisory) ────────────────
  try {
    const escalationQ = await loadEscalationQueue(config);
    const slaViolations = checkClosureSLA(Array.isArray(escalationQ) ? escalationQ : escalationQ?.entries || []);
    if (slaViolations.length > 0) {
      await appendProgress(config, `[CLOSURE_SLA] ${slaViolations.length} escalation(s) exceed SLA: ${slaViolations.map(v => v.title).join(", ")}`);
    }
  } catch (err) {
    warn(`[orchestrator] Closure SLA check failed (non-fatal): ${String(err?.message || err)}`);
  }
  await safeUpdatePipelineProgress(config, "janus_awakening", "Janus starting system state analysis");
  let janusDecision;
  try {
    await safeUpdatePipelineProgress(config, "janus_reading", "Janus reading system state");
    janusDecision = await runJanusCycle(config);
  } catch (err) {
    markPremiumOutcome(janusPremiumEvent.eventId, false);
    await appendProgress(config, `[CYCLE] Janus failed: ${String(err?.message || err)}`);
    warn(`[orchestrator] Janus cycle error: ${String(err?.message || err)}`);
    return;
  }

  if (!janusDecision || janusDecision.wait === true) {
    markPremiumOutcome(janusPremiumEvent.eventId, true);
    await appendProgress(config, "[CYCLE] Janus says: wait — nothing to do");
    return;
  }

  markPremiumOutcome(janusPremiumEvent.eventId, true);
  await appendProgress(config, `[JANUS] ✓ Done — requests this cycle: ${_cycleRequests}`);

  await safeUpdatePipelineProgress(config, "janus_decided", "Janus decision ready", {
    janusDecision: typeof janusDecision === "object" ? String(janusDecision.thinking || "").slice(0, 200) : ""
  });

  // Step 1.5: Research Scout — conditional trigger before Prometheus
  // Gate: only run Scout if synthesis is stale (>48h) AND Prometheus topic memory
  // has no more than `maxActiveResearchTopics` active (unfinished) topics.
  // This prevents Scout from piling on new topics when Prometheus hasn't acted on existing ones.
  //
  // ── WHY CONSUMPTION-TRIGGERED (not time-based) ──────────────────────────────
  // Originally Scout ran on a fixed 48h timer. This was broken in two ways:
  //
  //   1. One-way pipeline: Scout → Prometheus → Workers had no feedback loop.
  //      Prometheus consumed the synthesis, the knowledge was "spent", but Scout
  //      wouldn't run again for 48h regardless of how many cycles had passed.
  //
  //   2. BOX itself regressed this: a worker (CF-001-CF-005, PR #183) added the
  //      48h gate "to avoid piling on topics", which silently killed the loop.
  //      The system optimized itself into a dead-end pipeline.
  //
  // Decision (2026-04-04, owner: Caner): replace the time gate with a
  // consumption signal. Prometheus writes `lastConsumedAt` to research_synthesis.json
  // after injecting the data into its prompt. The scout gate reads this field:
  // if lastConsumedAt > synthesizedAt, the knowledge was used since the last scout
  // run → run Scout now so the next cycle has fresh data.
  //
  // This creates a proper feedback loop:
  //   Scout → synthesis → Prometheus (consumes, writes lastConsumedAt)
  //     → next cycle Scout gate sees consumed → Scout runs → fresh synthesis
  //
  // The 1h guard on synthesisAgeHours prevents double-running within the same
  // cycle (Scout runs at Step 1.5, Prometheus at Step 2 — both in one cycle).
  //
  // If BOX proposes reverting to a time-based gate, this comment explains why
  // that was deliberately removed. Any such change should be treated as a
  // regression unless there is explicit evidence of resource abuse.
  // ────────────────────────────────────────────────────────────────────────────
  try {
    const stateDir = config.paths?.stateDir || "state";
    const targetModeActive = config?.platformModeState?.currentMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY;
    const activeTargetSession = config?.activeTargetSession || null;
    const pendingTargetResearchRefresh = targetModeActive
      && activeTargetSession?.feedback?.pendingResearchRefresh === true;

    // Read synthesis state
    const synthesisPath = path.join(stateDir, "research_synthesis.json");
    let synthesisConsumedAt: Date | null = null;
    let synthJson: Record<string, unknown> | null = null;
    try {
      synthJson = await readJson(synthesisPath, null);
      if (synthJson?.lastConsumedAt) {
        synthesisConsumedAt = new Date(synthJson.lastConsumedAt as string);
      }
    } catch { /* ok — file missing means first run, treat as consumed */ }

    const synthesisAligned = !targetModeActive || isResearchArtifactAlignedToTargetSession(synthJson, activeTargetSession);
    if (targetModeActive && activeTargetSession && !synthesisAligned) {
      synthJson = null;
      synthesisConsumedAt = null;
    }

    // Consumption-triggered scout gate:
    // Scout runs when Prometheus consumed the previous synthesis in a DIFFERENT cycle
    // from when it was produced (gap > 5 minutes rules out same-cycle consumption).
    // ALSO triggers when all synthesis topics are marked consumed in topic memory
    // (every topic either produced a plan or was marked informational by Prometheus).
    const MIN_CONSUMED_GAP_MS = 5 * 60 * 1000; // 5 minutes
    const synthesisConsumedSinceLastScout =
      synthJson === null || // first run — no synthesis exists yet
      (
        synthesisConsumedAt !== null &&
        synthJson?.synthesizedAt != null &&
        synthesisConsumedAt > new Date(synthJson.synthesizedAt as string) &&
        (synthesisConsumedAt.getTime() - new Date(synthJson.synthesizedAt as string).getTime()) > MIN_CONSUMED_GAP_MS
      );

    // Check if ALL synthesis topics are now consumed in topic memory
    let allSynthesisTopicsConsumed = false;
    let allTopicsConsumedReason = "";
    try {
      const synthTopics = Array.isArray((synthJson as any)?.topics) ? (synthJson as any).topics as Array<{ topic: string }> : [];
      if (synthTopics.length > 0) {
        const topicMem = await loadTopicMemory(stateDir);
        const existingKeys = Object.keys(topicMem.topics);
        const unconsumed = synthTopics.filter(t => {
          const key = findCanonicalTopicKey(prometheusTopicKey(String(t.topic || "")), existingKeys);
          const status = topicMem.topics[key]?.status;
          return !status || (status !== "completed" && status !== "archived");
        });
        if (unconsumed.length === 0) {
          allSynthesisTopicsConsumed = true;
          allTopicsConsumedReason = `all ${synthTopics.length} synthesis topic(s) consumed in topic memory`;
        }
      }
    } catch { /* non-fatal */ }

    const shouldRunScout = pendingTargetResearchRefresh || synthesisConsumedSinceLastScout || allSynthesisTopicsConsumed;

    const scoutBlockedByBudget = shouldRunScout && !canSpendLeadership(1);
    if (shouldRunScout && !scoutBlockedByBudget) {
      const scoutPremiumEvent = await spendPremium("research-scout", "consumption_triggered_refresh", { pendingOutcome: true });
      const scoutReason = pendingTargetResearchRefresh
        ? "single-target research refresh requested by Athena"
        : synthJson === null
        ? "first-run (no synthesis exists)"
        : allSynthesisTopicsConsumed && !synthesisConsumedSinceLastScout
          ? `all-topics-consumed (${allTopicsConsumedReason})`
          : `consumption-triggered (consumed=${synthesisConsumedAt?.toISOString()}, synthesized=${synthJson.synthesizedAt})`;
      await appendProgress(config, `[CYCLE] ── Step 1.5: Research Scout (${scoutReason}) ──`);
      await appendProgress(config, `[AGENT] ↯↯↯ RESEARCH SCOUT ↯↯↯  req#${_cycleRequests + 1} this cycle`);
      try {
        const scoutResult = await runResearchScout(config);
        if (scoutResult.success && scoutResult.sourceCount > 0) {
          await appendProgress(config, `[RESEARCH_SCOUT] Collected ${scoutResult.sourceCount} sources — running synthesizer`);
          const synthesisResult = await runResearchSynthesizer(config, scoutResult);
          if (synthesisResult?.success === true && Array.isArray(synthesisResult.topics) && synthesisResult.topics.length > 0) {
            await persistBenchmarkEntry(config, String(cycleStartedAt || new Date().toISOString()), synthesisResult.topics);
            await appendProgress(config, `[RESEARCH_SCOUT] Benchmark ground-truth entry persisted - topics=${synthesisResult.topics.length}`);
            await clearSingleTargetFeedbackFlags(config, "rejected");
          }
          markPremiumOutcome(
            scoutPremiumEvent.eventId,
            Boolean(synthesisResult?.success === true && Array.isArray(synthesisResult?.topics) && synthesisResult.topics.length > 0),
          );
          await appendProgress(config, "[RESEARCH_SCOUT] Synthesis complete — Prometheus will receive updated research context");
          await appendProgress(config, `[RESEARCH_SCOUT] ✓ Done — requests this cycle: ${_cycleRequests}`);
        } else {
          markPremiumOutcome(scoutPremiumEvent.eventId, false);
          await appendProgress(config, `[RESEARCH_SCOUT] Scout returned no sources (success=${scoutResult.success}) — skipping synthesis`);
        }
      } catch (scoutErr) {
        markPremiumOutcome(scoutPremiumEvent.eventId, false);
        warn(`[orchestrator] Research Scout failed (non-fatal): ${String((scoutErr as any)?.message || scoutErr)}`);
        await appendProgress(config, `[RESEARCH_SCOUT] Failed (non-fatal): ${String((scoutErr as any)?.message || scoutErr)}`);
      }
    } else if (scoutBlockedByBudget) {
      await appendProgress(config,
        `[CYCLE] Research Scout skipped — leadership budget reached (${_cycleRequests}/${leadershipBudget})`
      );
    } else {
      const skipReason = `synthesis not yet fully consumed (lastConsumedAt=${synthesisConsumedAt?.toISOString() ?? "none"}, synthesizedAt=${synthJson?.synthesizedAt ?? "none"}, gap must exceed ${MIN_CONSUMED_GAP_MS / 60000}m OR all synthesis topics consumed in topic memory)`;
      await appendProgress(config, `[CYCLE] Research Scout skipped — ${skipReason}`);
    }
  } catch (scoutGateErr) {
    warn(`[orchestrator] Scout gate evaluation failed (non-fatal): ${String((scoutGateErr as any)?.message || scoutGateErr)}`);
  }

  // Step 2: Prometheus plans (single-prompt, no autopilot)
  await appendProgress(config, "[CYCLE] ── Step 2: Prometheus scanning & planning ──");
  await appendProgress(config, `[AGENT] ⚡⚡ PROMETHEUS ⚡⚡  req#${_cycleRequests + 1} this cycle`);
  const primaryPrometheusPremiumEvent = await spendPremium("prometheus", "primary_planning", { pendingOutcome: true });
  await safeUpdatePipelineProgress(config, "prometheus_starting", "Prometheus starting repository scan");

  // ── Architecture drift check: run before Prometheus to surface stale refs ──
  let architectureDriftReport = null;
  try {
    const rootDir = config.paths?.repoRoot || process.cwd();
    architectureDriftReport = await checkArchitectureDrift({ rootDir });
    const unresolvedCount = (architectureDriftReport.staleCount || 0) + (architectureDriftReport.deprecatedTokenCount || 0);
    await appendProgress(config,
      `[DRIFT_CHECK] Architecture drift scan complete — staleRefs=${architectureDriftReport.staleCount} deprecatedTokens=${architectureDriftReport.deprecatedTokenCount} scannedDocs=${architectureDriftReport.scannedDocs.length}`
    );
    if (unresolvedCount > 0) {
      await appendProgress(config,
        `[DRIFT_CHECK] ${unresolvedCount} unresolved drift item(s) — injecting summary into Prometheus context`
      );
    }
  } catch (driftErr) {
    warn(`[orchestrator] Architecture drift check failed (non-fatal): ${String(driftErr?.message || driftErr)}`);
  }

  let prometheusAnalysis;
  try {
    await safeUpdatePipelineProgress(config, "prometheus_reading_repo", "Prometheus reading repository");
    prometheusAnalysis = await runPrometheusAnalysis(config, {
      prompt: janusDecision.briefForPrometheus || janusDecision.thinking || "Full repository analysis",
      requestedBy: "Janus",
      driftReport: architectureDriftReport
    });
  } catch (err) {
    markPremiumOutcome(primaryPrometheusPremiumEvent.eventId, false);
    await appendProgress(config, `[CYCLE] Prometheus failed: ${String(err?.message || err)}`);
    warn(`[orchestrator] Prometheus analysis error: ${String(err?.message || err)}`);
    return;
  }

  markPremiumOutcome(primaryPrometheusPremiumEvent.eventId, true);
  prometheusAnalysis = stampPrometheusAnalysisTargetSession(config, prometheusAnalysis);
  await writeJson(path.join(stateDir, "prometheus_analysis.json"), prometheusAnalysis);
  let plannerPromptLineage = resolvePlannerPromptLineageFromAnalysis(prometheusAnalysis);

  // ── Mandatory findings preflight admission telemetry ─────────────────────
  // Emit structured log about any findings quarantined by the pre-planning
  // truth preflight so operators can audit what was suppressed and why.
  {
    const preflightTelemetry = extractMandatoryFindingsPreflightAdmissionTelemetry(prometheusAnalysis);
    if (preflightTelemetry && preflightTelemetry.quarantinedCount > 0) {
      await appendProgress(config,
        `[CYCLE][PREFLIGHT_TRUTH] Mandatory findings preflight: quarantined=${preflightTelemetry.quarantinedCount} ` +
        `trusted=${preflightTelemetry.trustedCount} ` +
        `preflightStatus=${preflightTelemetry.preflightStatus} ` +
        `sourceAgeMs=${preflightTelemetry.sourceAgeMs ?? "unknown"}`
      );
    }
  }

  if (!prometheusAnalysis || !Array.isArray(prometheusAnalysis.plans) || prometheusAnalysis.plans.length === 0) {
    await appendProgress(config, "[CYCLE] Prometheus produced no plans — cycle complete");
    await safeUpdatePipelineProgress(config, "cycle_complete", "Prometheus produced no plans — nothing to dispatch");
    return;
  }

  // Planner boundary checkpoint: persist stable snapshot after successful Prometheus analysis.
  {
    const plannerThreadId = String((config as any)?.cycleId || (prometheusAnalysis as any)?.cycleId || Date.now());
    const plannerCheckpointId = `${plannerThreadId}/${CHECKPOINT_NS.PLANNER}/1`;
    plannerPromptLineage = clonePromptLineageState(plannerPromptLineage, {
      checkpointNs: CHECKPOINT_NS.PLANNER,
      checkpointId: plannerCheckpointId,
    });
    if (plannerPromptLineage) {
      (prometheusAnalysis as any).promptLineage = plannerPromptLineage;
      (prometheusAnalysis as any).executionStrategy = {
        ...((prometheusAnalysis as any).executionStrategy || {}),
        promptLineage: plannerPromptLineage,
      };
    }
    await writeBoundaryCheckpoint(config, {
      planCount: Array.isArray(prometheusAnalysis.plans) ? prometheusAnalysis.plans.length : 0,
      planTitles: Array.isArray(prometheusAnalysis.plans) ? prometheusAnalysis.plans.map((p: any) => String(p?.title || "")) : [],
      prometheusCompletedAt: new Date().toISOString(),
      promptLineage: plannerPromptLineage,
      promptCache: plannerPromptLineage ? {
        promptFamilyKey: plannerPromptLineage.promptFamilyKey,
        cacheableSegments: plannerPromptLineage.cacheableSegments,
        totalSegments: plannerPromptLineage.totalSegments,
        estimatedSavedTokens: plannerPromptLineage.estimatedSavedTokens,
      } : null,
    }, { thread_id: plannerThreadId, checkpoint_ns: CHECKPOINT_NS.PLANNER }).catch(() => { /* non-fatal */ });
  }

  // ── Source-linkage quality gate (research-context blindness) ─────────────
  // When research context is injected but neither plan synthesis_sources nor
  // informational_topics_consumed are present, force one corrective Prometheus
  // re-plan (budget permitting). This prevents low-relevance, context-blind
  // plans from flowing into dispatch.
  {
    const researchTopicCount = Number((prometheusAnalysis as any)?.researchContext?.topicCount || 0);
    const sourceLinkedPlanCount = (Array.isArray((prometheusAnalysis as any)?.plans) ? (prometheusAnalysis as any).plans : [])
      .filter((p: any) => Array.isArray(p?.synthesis_sources) && p.synthesis_sources.length > 0)
      .length;
    const informationalConsumedCount = Array.isArray((prometheusAnalysis as any)?.informational_topics_consumed)
      ? (prometheusAnalysis as any).informational_topics_consumed.length
      : 0;
    const blindPlanningDetected =
      researchTopicCount > 0 &&
      sourceLinkedPlanCount === 0 &&
      informationalConsumedCount === 0;

    if (blindPlanningDetected) {
      await appendProgress(config,
        `[CYCLE] Source-linkage gate detected blind planning: researchTopics=${researchTopicCount} linkedPlans=${sourceLinkedPlanCount} informationalConsumed=${informationalConsumedCount}`
      );
      if (canSpendLeadership(1)) {
        const linkageReplanPremiumEvent = await spendPremium("prometheus", "source_linkage_replan", { pendingOutcome: true });
        try {
          const linkagePrompt = buildSourceLinkageReplanPrompt(
            janusDecision.briefForPrometheus || janusDecision.thinking || "Full repository analysis",
            researchTopicCount
          );
          const replannedWithLinkage = await runPrometheusAnalysis(config, {
            prompt: linkagePrompt,
            requestedBy: "OrchestratorSourceLinkageGate",
            driftReport: architectureDriftReport,
            bypassCache: true,
            bypassReason: "missing_source_linkage",
            promptLineage: plannerPromptLineage,
            resumeFromCheckpointId: plannerPromptLineage?.checkpointId || null,
          });
          markPremiumOutcome(
            linkageReplanPremiumEvent.eventId,
            Boolean(replannedWithLinkage && Array.isArray(replannedWithLinkage.plans) && replannedWithLinkage.plans.length > 0),
          );
          const replannedSourceLinkedCount = (Array.isArray((replannedWithLinkage as any)?.plans) ? (replannedWithLinkage as any).plans : [])
            .filter((p: any) => Array.isArray(p?.synthesis_sources) && p.synthesis_sources.length > 0)
            .length;
          const replannedInformationalCount = Array.isArray((replannedWithLinkage as any)?.informational_topics_consumed)
            ? (replannedWithLinkage as any).informational_topics_consumed.length
            : 0;
          await appendProgress(config,
            `[PROMETHEUS] ↺ Source-linkage re-plan complete — linkedPlans=${replannedSourceLinkedCount} informationalConsumed=${replannedInformationalCount} req#${_cycleRequests} this cycle`
          );
          if (replannedWithLinkage && Array.isArray(replannedWithLinkage.plans) && replannedWithLinkage.plans.length > 0) {
            prometheusAnalysis = stampPrometheusAnalysisTargetSession(config, replannedWithLinkage);
            await writeJson(path.join(stateDir, "prometheus_analysis.json"), prometheusAnalysis);
            plannerPromptLineage = resolvePlannerPromptLineageFromAnalysis(prometheusAnalysis);
          }
        } catch (err) {
          markPremiumOutcome(linkageReplanPremiumEvent.eventId, false);
          warn(`[orchestrator] Source-linkage re-plan failed (non-fatal): ${String((err as any)?.message || err)}`);
          await appendProgress(config,
            `[CYCLE] Source-linkage re-plan failed (non-fatal): ${String((err as any)?.message || err)}`
          );
        }
      } else {
        await appendProgress(config,
          `[CYCLE] Source-linkage re-plan skipped — leadership budget reached (${_cycleRequests}/${leadershipBudget})`
        );
      }
    }
  }

  // ── Parser confidence hard-stop gate ──────────────────────────────────────
  // Block dispatch when Prometheus output confidence is below threshold.
  const PARSER_CONFIDENCE_THRESHOLD = config.runtime?.parserConfidenceThreshold ?? 0.3;
  const parsedConfidence = prometheusAnalysis.parserConfidence ?? 1.0;
  if (parsedConfidence < PARSER_CONFIDENCE_THRESHOLD) {
    await appendProgress(config,
      `[CYCLE] Parser confidence too low (${parsedConfidence} < ${PARSER_CONFIDENCE_THRESHOLD}) — blocking dispatch`
    );
    await appendAlert(config, {
      severity: ALERT_SEVERITY.HIGH,
      source: "orchestrator",
      title: "Low parser confidence — dispatch blocked",
      message: `parserConfidence=${parsedConfidence} threshold=${PARSER_CONFIDENCE_THRESHOLD}. Plans not dispatched.`
    });
    await safeUpdatePipelineProgress(config, "cycle_complete", `Parser confidence too low (${parsedConfidence}) — dispatch blocked`);
    return;
  }

  // ── Baseline recovery mode ────────────────────────────────────────────────
  // When parserConfidence is below PARSER_CONFIDENCE_RECOVERY_THRESHOLD (0.9)
  // but above the hard-stop, enter advisory "baseline recovery" mode:
  //   - Persist structural/schema component metrics for trend analysis.
  //   - Emit progress + advisory alert so operators can see which components
  //     are dragging confidence below the recovery target.
  // Dispatch is NOT blocked here — the hard-stop gate above handles that.
  let baselineRecoveryRecord = null;
  if (parsedConfidence < PARSER_CONFIDENCE_RECOVERY_THRESHOLD) {
    try {
      const cycleIdForBaseline = (await readPipelineProgress(config))?.startedAt ?? null;
      baselineRecoveryRecord = computeBaselineRecoveryState(prometheusAnalysis, cycleIdForBaseline);
      await persistBaselineMetrics(config, baselineRecoveryRecord);
      const gapSummary = Object.entries(baselineRecoveryRecord.componentGap)
        .filter(([, gap]) => (gap as number) > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      await appendProgress(config,
        `[CYCLE] Baseline recovery mode active — parserConfidence=${parsedConfidence} target=${PARSER_CONFIDENCE_RECOVERY_THRESHOLD}` +
        (gapSummary ? ` componentGaps=[${gapSummary}]` : "")
      );
      await appendAlert(config, {
        severity: ALERT_SEVERITY.MEDIUM,
        source: "orchestrator",
        title: "Baseline recovery mode — parser confidence below target",
        message: `parserConfidence=${parsedConfidence} target=${PARSER_CONFIDENCE_RECOVERY_THRESHOLD}. ` +
          `Component gaps: ${gapSummary || "none"}. ` +
          `Penalties: ${baselineRecoveryRecord.penalties.map(p => p.reason).join(", ") || "none"}.`
      });
    } catch (err) {
      warn(`[orchestrator] Baseline recovery metrics persist failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  // ── Dispatch strictness gate (replay harness regressions) ────────────────
  // Load the last persisted replay regression state and combine it with the
  // current baseline recovery record to determine how strictly dispatch should
  // behave.  This is fail-open: any error loading state is treated as no signal
  // (NORMAL strictness) so a missing corpus file never blocks legitimate work.
  //
  //   NORMAL   → proceed as usual
  //   ELEVATED → advisory log; dispatch continues
  //   STRICT   → warning alert; dispatch continues (caller may reduce concurrency)
  //   BLOCKED  → hard-stop: dispatch blocked, alert emitted, cycle exits
  try {
    const replayRegressionState = await loadReplayRegressionState(config);
    const strictnessResult = computeDispatchStrictness(replayRegressionState, baselineRecoveryRecord);

    if (strictnessResult.strictness !== DISPATCH_STRICTNESS.NORMAL) {
      await appendProgress(config,
        `[DISPATCH_STRICTNESS] level=${strictnessResult.strictness} regressionRate=${(strictnessResult.regressionRate * 100).toFixed(0)}% recoveryActive=${strictnessResult.recoveryActive} — ${strictnessResult.reason}`
      );
    }

    if (strictnessResult.strictness === DISPATCH_STRICTNESS.BLOCKED) {
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "orchestrator",
        title: "Dispatch blocked — replay harness regression rate exceeds threshold",
        message: strictnessResult.reason,
      });
      await safeUpdatePipelineProgress(config, "cycle_complete", `Dispatch blocked: ${strictnessResult.reason}`);
      return;
    }

    if (strictnessResult.strictness === DISPATCH_STRICTNESS.STRICT) {
      await appendAlert(config, {
        severity: ALERT_SEVERITY.HIGH,
        source: "orchestrator",
        title: "Strict dispatch mode — replay harness regressions detected",
        message: strictnessResult.reason,
      });
    } else if (strictnessResult.strictness === DISPATCH_STRICTNESS.ELEVATED) {
      await appendAlert(config, {
        severity: ALERT_SEVERITY.MEDIUM,
        source: "orchestrator",
        title: "Elevated dispatch mode — parser regressions or recovery active",
        message: strictnessResult.reason,
      });
    }
  } catch (err) {
    warn(`[orchestrator] Dispatch strictness gate failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Plan novelty gate ─────────────────────────────────────────────────────
  // Skip plans that Prometheus itself marked as already implemented correctly.
  // If all plans are already implemented, force one fresh re-plan with an
  // explicit "net-new or delta only" instruction and continue with that output.
  let noveltyResult = await filterAlreadyImplementedPlans(stateDir, prometheusAnalysis.plans);
  if (noveltyResult.skippedPlans.length > 0) {
    await appendProgress(
      config,
      `[CYCLE] Plan novelty gate skipped ${noveltyResult.skippedPlans.length}/${prometheusAnalysis.plans.length} already-implemented plan(s)`
    );
  }

  if (noveltyResult.actionablePlans.length === 0) {
    await appendProgress(config,
      "[CYCLE] All Prometheus plans are already implemented/completed — refreshing Scout+Synth before requesting net-new plans"
    );

    const refinedPrompt = buildNoveltyReplanPrompt(
      janusDecision.briefForPrometheus || janusDecision.thinking || "Full repository analysis",
      noveltyResult.skippedPlans
    );

    try {
      // Refresh research context first so Prometheus re-plans from fresh Scout output,
      // not only from existing stale synthesis.
      try {
        if (canSpendLeadership(1)) {
          const noveltyScoutPremiumEvent = await spendPremium("research-scout", "novelty_gate_refresh", { pendingOutcome: true });
          await appendProgress(config, "[CYCLE] Novelty gate triggering Research Scout refresh");
          const scoutRefresh = await runResearchScout(config);
          if (scoutRefresh.success && scoutRefresh.sourceCount > 0) {
            await appendProgress(config, `[RESEARCH_SCOUT] Refresh collected ${scoutRefresh.sourceCount} source(s) — running synthesizer`);
            const refreshSynthesisResult = await runResearchSynthesizer(config, scoutRefresh);
            if (refreshSynthesisResult?.success === true && Array.isArray(refreshSynthesisResult.topics) && refreshSynthesisResult.topics.length > 0) {
              await persistBenchmarkEntry(config, String(cycleStartedAt || new Date().toISOString()), refreshSynthesisResult.topics);
              await appendProgress(config, `[RESEARCH_SCOUT] Benchmark ground-truth entry persisted - topics=${refreshSynthesisResult.topics.length}`);
              await clearSingleTargetFeedbackFlags(config, "rejected");
            }
            markPremiumOutcome(
              noveltyScoutPremiumEvent.eventId,
              Boolean(refreshSynthesisResult?.success === true && Array.isArray(refreshSynthesisResult?.topics) && refreshSynthesisResult.topics.length > 0),
            );
            await appendProgress(config, `[RESEARCH_SCOUT] ✓ Refresh complete — requests this cycle: ${_cycleRequests}`);
          } else {
            markPremiumOutcome(noveltyScoutPremiumEvent.eventId, false);
            await appendProgress(config, `[RESEARCH_SCOUT] Refresh produced no sources (success=${scoutRefresh.success}) — continuing with novelty re-plan`);
          }
        } else {
          await appendProgress(config, `[CYCLE] Novelty-gate Scout refresh skipped — leadership budget reached (${_cycleRequests}/${leadershipBudget})`);
        }
      } catch (refreshErr) {
        warn(`[orchestrator] Novelty gate Scout/Synth refresh failed (non-fatal): ${String((refreshErr as any)?.message || refreshErr)}`);
        await appendProgress(config,
          `[CYCLE] Scout/Synth refresh failed (non-fatal) — continuing with novelty re-plan: ${String((refreshErr as any)?.message || refreshErr)}`
        );
      }

      if (!canSpendLeadership(1)) {
        await appendProgress(config, `[CYCLE] Novelty re-plan skipped — leadership budget reached (${_cycleRequests}/${leadershipBudget})`);
        await safeUpdatePipelineProgress(config, "cycle_complete", "Novelty re-plan skipped due to leadership budget");
        return;
      }

      const noveltyReplanPremiumEvent = await spendPremium("prometheus", "novelty_replan", { pendingOutcome: true });
      const replanned = await runPrometheusAnalysis(config, {
        prompt: refinedPrompt,
        requestedBy: "OrchestratorNoveltyGate",
        driftReport: architectureDriftReport,
        bypassCache: true,
        bypassReason: "all_plans_already_implemented_or_completed",
        promptLineage: plannerPromptLineage,
        resumeFromCheckpointId: plannerPromptLineage?.checkpointId || null,
      });

      markPremiumOutcome(
        noveltyReplanPremiumEvent.eventId,
        Boolean(replanned && Array.isArray(replanned.plans) && replanned.plans.length > 0),
      );
      await appendProgress(config, `[PROMETHEUS] ↺ Re-plan run complete — requests this cycle: ${_cycleRequests}`);

      if (!replanned || !Array.isArray(replanned.plans) || replanned.plans.length === 0) {
        await appendProgress(config, "[CYCLE] Re-plan returned no plans — cycle complete");
        await safeUpdatePipelineProgress(config, "cycle_complete", "No net-new actionable plans after novelty re-plan");
        return;
      }

      stampPrometheusAnalysisTargetSession(config, replanned);
      await writeJson(path.join(stateDir, "prometheus_analysis.json"), replanned);

      const replannedConfidence = replanned.parserConfidence ?? 1.0;
      if (replannedConfidence < PARSER_CONFIDENCE_THRESHOLD) {
        await appendProgress(config,
          `[CYCLE] Re-plan parser confidence too low (${replannedConfidence} < ${PARSER_CONFIDENCE_THRESHOLD}) — blocking dispatch`
        );
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: "Low parser confidence on novelty re-plan — dispatch blocked",
          message: `parserConfidence=${replannedConfidence} threshold=${PARSER_CONFIDENCE_THRESHOLD}. Re-planned plans not dispatched.`
        });
        await safeUpdatePipelineProgress(config, "cycle_complete", `Re-plan parser confidence too low (${replannedConfidence})`);
        return;
      }

      noveltyResult = await filterAlreadyImplementedPlans(stateDir, replanned.plans);
      if (noveltyResult.actionablePlans.length === 0) {
        await appendProgress(config,
          "[CYCLE] Re-plan still produced only already-implemented/completed items — cycle complete"
        );
        await safeUpdatePipelineProgress(config, "cycle_complete", "No net-new actionable plans after novelty filtering");
        return;
      }

      prometheusAnalysis = {
        ...replanned,
        plans: noveltyResult.actionablePlans,
      };
      plannerPromptLineage = resolvePlannerPromptLineageFromAnalysis(prometheusAnalysis);
    } catch (replanErr) {
      warn(`[orchestrator] Novelty re-plan failed (non-fatal): ${String((replanErr as any)?.message || replanErr)}`);
      await appendProgress(config,
        `[CYCLE] Novelty re-plan failed — stopping cycle to avoid redispatching already-implemented plans: ${String((replanErr as any)?.message || replanErr)}`
      );
      await safeUpdatePipelineProgress(config, "cycle_complete", "Novelty re-plan failed");
      return;
    }
  } else {
    prometheusAnalysis = {
      ...prometheusAnalysis,
      plans: noveltyResult.actionablePlans,
    };
  }

  {
    const plannerThreadId = String((config as any)?.cycleId || (prometheusAnalysis as any)?.cycleId || Date.now());
    const plannerCheckpointId = `${plannerThreadId}/${CHECKPOINT_NS.PLANNER}/1`;
    plannerPromptLineage = clonePromptLineageState(
      plannerPromptLineage || resolvePlannerPromptLineageFromAnalysis(prometheusAnalysis),
      {
        checkpointNs: CHECKPOINT_NS.PLANNER,
        checkpointId: plannerCheckpointId,
      },
    );
    if (plannerPromptLineage) {
      (prometheusAnalysis as any).promptLineage = plannerPromptLineage;
      (prometheusAnalysis as any).executionStrategy = {
        ...((prometheusAnalysis as any).executionStrategy || {}),
        promptLineage: plannerPromptLineage,
      };
    }
    await writeBoundaryCheckpoint(config, {
      planCount: Array.isArray(prometheusAnalysis.plans) ? prometheusAnalysis.plans.length : 0,
      planTitles: Array.isArray(prometheusAnalysis.plans) ? prometheusAnalysis.plans.map((p: any) => String(p?.title || "")) : [],
      prometheusCompletedAt: new Date().toISOString(),
      promptLineage: plannerPromptLineage,
      promptCache: plannerPromptLineage ? {
        promptFamilyKey: plannerPromptLineage.promptFamilyKey,
        cacheableSegments: plannerPromptLineage.cacheableSegments,
        totalSegments: plannerPromptLineage.totalSegments,
        estimatedSavedTokens: plannerPromptLineage.estimatedSavedTokens,
      } : null,
    }, { thread_id: plannerThreadId, checkpoint_ns: CHECKPOINT_NS.PLANNER }).catch(() => { /* non-fatal */ });
  }

  await safeUpdatePipelineProgress(config, "prometheus_done", `Prometheus complete — ${prometheusAnalysis.plans.length} plan(s)`, {
    planCount: prometheusAnalysis.plans.length
  });
  await appendProgress(config, `[PROMETHEUS] ✓ Done — ${prometheusAnalysis.plans.length} plan(s) — requests this cycle: ${_cycleRequests}`);

  // Pre-Athena admission: cap review payload to what Athena can reliably process.
  // This avoids feeding oversized plan sets into Athena and timing out fail-closed.
  if (Array.isArray(prometheusAnalysis.plans) && prometheusAnalysis.plans.length > 0) {
    const athenaAdmission = await resolveAthenaReviewAdmission(config, stateDir, prometheusAnalysis.plans);
    const deferredCount = athenaAdmission.deferredPlans.length;
    if (deferredCount > 0) {
      prometheusAnalysis = {
        ...prometheusAnalysis,
        plans: athenaAdmission.admittedPlans,
        _athenaReviewAdmission: {
          admittedCount: athenaAdmission.admittedPlans.length,
          deferredCount,
          cap: athenaAdmission.cap,
          estimatedPromptChars: athenaAdmission.estimatedPromptChars,
          reason: athenaAdmission.reason,
          deferredTaskIds: athenaAdmission.deferredPlans.map((p: any) => String(p?.task_id || p?.task || "unknown")),
        },
      };
      await appendProgress(
        config,
        `[ATHENA_ADMISSION] Deferred ${deferredCount}/${athenaAdmission.admittedPlans.length + deferredCount} plan(s) before review — ${athenaAdmission.reason}`,
      );
    } else {
      await appendProgress(
        config,
        `[ATHENA_ADMISSION] No deferral (${athenaAdmission.admittedPlans.length} plan(s)) — ${athenaAdmission.reason}`,
      );
    }
  }

  // Step 3: Athena validates the plan (1 request)
  await appendProgress(config, "[CYCLE] ── Step 3: Athena reviewing plan ──");
  await appendProgress(config, `[AGENT] ◈◈◈ ATHENA ◈◈◈  req#${_cycleRequests + 1} this cycle`);
  const athenaPremiumEvent = await spendPremium("athena", "plan_review", { pendingOutcome: true });
  await safeUpdatePipelineProgress(config, "athena_reviewing", "Athena reviewing Prometheus plan");
  // Trace: Athena review entry — proves Athena was invoked this cycle.
  await recordCapabilityExecution(
    config,
    "athena-review-entry",
    `planCount=${Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : 0} cycleReqs=${_cycleRequests}`,
  );
  let planReview;
  try {
    planReview = await runAthenaPlanReview(config, prometheusAnalysis);
  } catch (err) {
    markPremiumOutcome(athenaPremiumEvent.eventId, false);
    const msg = String(err?.message || err).slice(0, 200);
    await appendProgress(config, `[CYCLE] Athena plan review threw exception: ${msg} — blocking cycle (fail-closed)`);
    warn(`[orchestrator] Athena plan review exception: ${msg}`);
    const reason = { code: ATHENA_PLAN_REVIEW_REASON_CODE.REVIEW_EXCEPTION, message: msg };
    const blocker = {
      stage: "athena_plan_review",
      code: reason.code,
      source: "orchestrator",
      retryable: false,
    };
    emitEvent(EVENTS.ORCHESTRATION_HEALTH_DEGRADED, EVENT_DOMAIN.ORCHESTRATION, `athena-review-exception-${Date.now()}`, {
      reason: "athena_plan_review_exception",
      blockerCode: blocker.code,
      blockerStage: blocker.stage,
      error: msg,
    });
    await appendAlert(config, {
      severity: ALERT_SEVERITY.CRITICAL,
      source: "orchestrator",
      title: "Athena plan review exception — cycle blocked",
      message: `code=${reason.code} message=${reason.message}`
    });
    await writeJson(path.join(stateDir, "athena_plan_rejection.json"), {
      rejectedAt: new Date().toISOString(),
      reason,
      blocker,
      corrections: [],
      summary: `Plan review exception: ${msg}`
    });
    planReview = { approved: false, reason, blocker, corrections: [] };
  }

  if (planReview?.approved === true && !hasFiniteAthenaOverallScore(planReview)) {
    const reason = {
      code: ATHENA_PLAN_REVIEW_REASON_CODE.SCORE_CONTRACT_VIOLATION,
      message: "Athena approved response missing valid overallScore (expected numeric 1-10)"
    };
    const blocker = {
      stage: "athena_plan_review",
      code: reason.code,
      source: "orchestrator",
      retryable: false,
    };
    await appendProgress(config, `[CYCLE] Athena plan review score contract violation — blocking cycle (fail-closed)`);
    await appendProgress(config, `[ATHENA][BLOCKER] code=${blocker.code} stage=${blocker.stage} retryable=${String(blocker.retryable)}`);
    planReview = { ...planReview, approved: false, reason, blocker, corrections: planReview?.corrections || [] };
  }

  const athenaCorrectionDispatchBlockReason = resolveAthenaCorrectionDispatchBlockReason(planReview?.corrections || []);

  if (!planReview.approved) {
    markPremiumOutcome(athenaPremiumEvent.eventId, false);
    const rejectionReason = planReview.reason || { code: "PLAN_REJECTED", message: planReview.summary || "Rejected by Athena" };
    const correctionsList = planReview.corrections || [];
    const blocker = planReview.blocker && typeof planReview.blocker === "object"
      ? planReview.blocker
      : {
        stage: "athena_plan_review",
        code: typeof rejectionReason === "object" ? (rejectionReason as Record<string, unknown>).code : String(rejectionReason),
        source: "athena_reviewer",
        retryable: false,
      };
    const blockerCode = String((blocker as Record<string, unknown>).code || "PLAN_REJECTED");
    await appendProgress(config, `[CYCLE] Athena REJECTED plan — code=${typeof rejectionReason === "object" ? rejectionReason.code : rejectionReason} blocker=${blockerCode} corrections: ${correctionsList.join("; ")}`);
    emitEvent(EVENTS.PLANNING_PLAN_REJECTED, EVENT_DOMAIN.PLANNING, `plan-reject-${Date.now()}`, {
      code: typeof rejectionReason === "object" ? (rejectionReason as Record<string, unknown>).code : String(rejectionReason),
      blockerCode,
      corrections: correctionsList,
      summary: planReview.summary || ""
    });
    // Save rejection for Prometheus to read on next cycle
    await writeJson(path.join(stateDir, "athena_plan_rejection.json"), {
      rejectedAt: new Date().toISOString(),
      reason: rejectionReason,
      blocker,
      corrections: correctionsList,
      dispatchBlockReason: athenaCorrectionDispatchBlockReason,
      summary: planReview.summary || ""
    });
    await persistSingleTargetAthenaFeedback(config, planReview).catch((feedbackErr) => {
      warn(`[orchestrator] failed to persist single-target Athena feedback (non-fatal): ${String((feedbackErr as Error)?.message || feedbackErr)}`);
    });
    return;
  }

  if (athenaCorrectionDispatchBlockReason) {
    markPremiumOutcome(athenaPremiumEvent.eventId, false);
    await appendProgress(
      config,
      `[CYCLE] Athena corrections indicate active governance block — reason=${athenaCorrectionDispatchBlockReason}`
    );
    await appendAlert(config, {
      severity: ALERT_SEVERITY.HIGH,
      source: "orchestrator",
      title: "Worker dispatch blocked by Athena governance correction token",
      message: `reason=${athenaCorrectionDispatchBlockReason}`,
    });
    try {
      const blockedAnalytics = computeCycleAnalytics(config, {
        phase: CYCLE_PHASE.INCOMPLETE,
        dispatchBlockReason: athenaCorrectionDispatchBlockReason,
        pipelineProgress: null,
        workerResults: null,
      });
      await persistCycleAnalytics(config, blockedAnalytics);
      await appendGovernanceBlockEvent(config, {
        cycleId: `cycle-${cycleStartedAt || Date.now()}`,
        blockReason: athenaCorrectionDispatchBlockReason,
        blockedAt: new Date().toISOString(),
        gateSource: "athena_correction_token",
      });
      await recordCapabilityExecution(
        config,
        "dispatch-block-reason-reporting",
        `gateSource=athena_correction_token reason=${athenaCorrectionDispatchBlockReason.slice(0, 120)}`,
      );
    } catch (analyticsErr) {
      warn(`[orchestrator] Athena correction block analytics write failed (non-fatal): ${String(analyticsErr?.message || analyticsErr)}`);
    }
    return;
  }

  markPremiumOutcome(athenaPremiumEvent.eventId, true);
  await safeUpdatePipelineProgress(config, "athena_approved", "Athena approved the plan");
  await appendProgress(config, `[ATHENA] ✓ Done — plan approved — requests this cycle: ${_cycleRequests}`);
  // Trace: Athena review exit — proves Athena completed and approved this cycle.
  await recordCapabilityExecution(
    config,
    "athena-review-exit",
    `approved=true autoApproved=${String((planReview as any)?.autoApproved ?? false)} overallScore=${String((planReview as any)?.overallScore ?? "n/a")}`,
  );

  // Reviewer boundary checkpoint: persist stable snapshot after Athena approval.
  {
    const reviewerThreadId = String((config as any)?.cycleId || (prometheusAnalysis as any)?.cycleId || Date.now());
    const reviewerCheckpointId = `${reviewerThreadId}/${CHECKPOINT_NS.REVIEWER}/1`;
    const reviewerPromptLineage = clonePromptLineageState(
      resolveReviewerPromptLineageFromReview(planReview, prometheusAnalysis),
      {
        checkpointNs: CHECKPOINT_NS.REVIEWER,
        checkpointId: reviewerCheckpointId,
      },
    );
    await writeBoundaryCheckpoint(config, {
      athenaApproved: true,
      overallScore: (planReview as any)?.overallScore ?? null,
      autoApproved: (planReview as any)?.autoApproved ?? false,
      athenaCompletedAt: new Date().toISOString(),
      promptLineage: reviewerPromptLineage,
    }, { thread_id: reviewerThreadId, checkpoint_ns: CHECKPOINT_NS.REVIEWER }).catch(() => { /* non-fatal */ });
    if (reviewerPromptLineage) {
      (planReview as any).promptLineage = reviewerPromptLineage;
    }
  }

  // Record that Athena's gate feasibility check was invoked this cycle.
  await recordCapabilityExecution(
    config,
    "athena-gate-pre-check",
    `gateBlockRisk=${String((planReview as any)?.gateBlockRiskAtApproval ?? (planReview as any)?.gateBlockRisk ?? "unknown")} autoApproved=${String((planReview as any)?.autoApproved ?? false)}`,
  );
  await recordCapabilityExecution(
    config,
    "athena-gate-feasibility-check",
    `gateBlockRisk=${String((planReview as any)?.gateBlockRiskAtApproval ?? (planReview as any)?.gateBlockRisk ?? "unknown")}`,
  );

  // A prior Athena rejection must not force fresh replans after a later approval.
  await clearAthenaPlanRejectionLatch(config);
  await clearSingleTargetFeedbackFlags(config, "approved").catch((feedbackErr) => {
    warn(`[orchestrator] failed to clear single-target Athena feedback flags (non-fatal): ${String((feedbackErr as Error)?.message || feedbackErr)}`);
  });

  // Persist auto-approve telemetry whenever Athena's deterministic fast-path
  // fires.  This was previously defined but never called, leaving the
  // auto_approve_telemetry.json empty and breaking downstream ROI analysis.
  if (planReview.autoApproved === true) {
    const autoApproveCycleId = `cycle-${cycleStartedAt || Date.now()}`;
    await appendAutoApproveTelemetry(config, planReview as Record<string, unknown>, autoApproveCycleId);
  }

  // ── Stale-artifact closure fastpath ───────────────────────────────────────
  // When main CI is green and all stale automated PR debt is already terminal
  // (superseded or applied), skip worker dispatch.  The system is healthy and
  // the stale PR guard has already resolved the debt — no worker work needed.
  try {
    const closurePlans = Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans : [];
    const staleClosureFastpath = await runStaleArtifactClosureFastpath(
      config,
      closurePlans as Array<Record<string, unknown>>,
    );
    if (staleClosureFastpath.eligible) {
      await persistSkippedDispatchCheckpoint(config, closurePlans, {
        planAnalyzedAt: String(prometheusAnalysis?.analyzedAt || ""),
      });
      await appendProgress(
        config,
        `[CYCLE] Stale-artifact closure fastpath — skipping worker dispatch: reason=${staleClosureFastpath.reason} stalePrCount=${staleClosureFastpath.stalePrCount}`,
      );
      await safeUpdatePipelineProgress(
        config,
        "cycle_complete",
        `Stale-artifact closure fastpath: all ${staleClosureFastpath.stalePrCount} stale PR record(s) superseded and main CI green`,
      );
      return;
    }
    if (staleClosureFastpath.stalePrCount > 0) {
      await appendProgress(
        config,
        `[CYCLE] Stale-artifact closure fastpath not eligible — reason=${staleClosureFastpath.reason} stalePrCount=${staleClosureFastpath.stalePrCount} mainCiGreen=${String(staleClosureFastpath.mainCiGreen)}`,
      );
    }
  } catch (fastpathErr) {
    warn(`[orchestrator] stale-artifact closure fastpath check failed (non-fatal): ${String((fastpathErr as Error)?.message || fastpathErr)}`);
  }

  // Step 4: Dispatch workers sequentially (1 request per worker)
  let rawPlans = Array.isArray(planReview.patchedPlans) && planReview.patchedPlans.length > 0
    ? planReview.patchedPlans
    : prometheusAnalysis.plans;

  const adaptiveCap = await resolveAdaptivePlanCap(config, stateDir);
  if (Array.isArray(rawPlans) && rawPlans.length > adaptiveCap.cap) {
    rawPlans = [...rawPlans]
      .sort((a: any, b: any) => Number(a?.priority ?? 99) - Number(b?.priority ?? 99))
      .slice(0, adaptiveCap.cap);
    await appendProgress(config,
      `[CYCLE] Adaptive plan cap applied: selected ${rawPlans.length}/${prometheusAnalysis.plans.length} plan(s) — ${adaptiveCap.reason}`
    );
  } else {
    await appendProgress(config,
      `[CYCLE] Adaptive plan cap: no trim (${Array.isArray(rawPlans) ? rawPlans.length : 0} plan(s)) — ${adaptiveCap.reason}`
    );
  }

  // ── Ensure synthesizable defaults on all plans ─────────────────────────────
  // Athena's patchedPlans come from AI output and may lack fields that
  // normalizePlanFromTask would synthesize (capacityDelta, requestROI,
  // verification_commands, acceptance_criteria, dependencies).
  // Fill only missing fields with safe defaults so downstream gates pass.
  const plans = rawPlans.map((p: any) => ({
    ...p,
    capacityDelta: Number.isFinite(Number(p.capacityDelta)) && Number(p.capacityDelta) >= -1 && Number(p.capacityDelta) <= 1
      ? Number(p.capacityDelta) : 0.1,
    requestROI: Number.isFinite(Number(p.requestROI)) && Number(p.requestROI) > 0
      ? Number(p.requestROI) : 1.0,
    verification_commands: Array.isArray(p.verification_commands) && p.verification_commands.length > 0
      ? p.verification_commands : [String(p.verification || "npm test")],
    acceptance_criteria: Array.isArray(p.acceptance_criteria) && p.acceptance_criteria.length > 0
      ? p.acceptance_criteria : [String(p.task || "Task completes successfully")],
    dependencies: Array.isArray(p.dependencies) ? p.dependencies : [],
  }));

  // Bind deterministic named verification targets before dispatch admission.
  // This prevents generic verification commands from reaching worker calls when
  // a specific target already exists in verification_commands.
  bindNamedVerificationTargets(plans as any[]);

  // Funnel tracking: capture approved count before quality/freeze gates reduce plans.
  const funnelApprovedCount: number = plans.length;

  // ── Lane performance: read previous cycle telemetry for informed dispatch ───
  // Building lanePerformance before the capability pool call lets the pool use
  // measured lane ROI (rather than static estimates) to route plans to the
  // strongest available worker lane.
  let lanePerformanceFromCycle: ReturnType<typeof buildLanePerformanceFromCycleTelemetry> = {};
  let laneTelemetrySignalsFromCycle = {};
  try {
    const prevAnalyticsForLane = await readCycleAnalytics(config);
    const prevLaneTelemetry = (prevAnalyticsForLane as any)?.lastCycle?.laneTelemetry;
    if (prevLaneTelemetry && typeof prevLaneTelemetry === "object") {
      lanePerformanceFromCycle = buildLanePerformanceFromCycleTelemetry(prevLaneTelemetry);
      laneTelemetrySignalsFromCycle = buildLaneTelemetrySignals(prevLaneTelemetry);
    }
  } catch { /* non-fatal: no previous cycle analytics yet */ }

  // ── Capability pool: assign workers based on task capability matching ──────
  let capabilityPoolResult = null;
  try {
    const poolResult = assignWorkersToPlans(plans, config, lanePerformanceFromCycle, {
      laneTelemetrySignals: laneTelemetrySignalsFromCycle,
    });
    capabilityPoolResult = poolResult;
    if (poolResult.diversityIndex > 0) {
      await appendProgress(config, `[CAPABILITY_POOL] Worker diversity index: ${poolResult.diversityIndex} (0=single-worker, 1=fully diversified)`);
    }
    if (poolResult.specializationUtilization && !poolResult.specializationUtilization.specializationTargetsMet) {
      const roiNote = poolResult?.laneROIAdmission?.admitted
        ? `, roiGate=pass:${String(poolResult.laneROIAdmission.reason || "pass")}`
        : `, roiGate=block:${String(poolResult?.laneROIAdmission?.reason || "unknown")}`;
      const collapseNote = Number(poolResult.specializationUtilization.fallbackCollapseCount || 0) > 0
        ? `, collapsedLanes=${(poolResult.specializationUtilization.collapsedReservedLanes || []).join(",") || "none"}`
        : "";
      await appendProgress(
        config,
        `[CAPABILITY_POOL] Specialist utilization below target: ${Math.round(poolResult.specializationUtilization.specializedShare * 100)}% < ${Math.round(poolResult.specializationUtilization.minSpecializedShare * 100)}%${roiNote}${collapseNote}`
      );
    }
    // Apply pool assignment — update plan.role to the capability-assigned role when it improves on the default.
    // _originalRole preserves the Prometheus-suggested role for audit; _capabilityLane tracks the lane.
    for (const { plan, selection } of poolResult.assignments) {
      if (!selection.isFallback && selection.role !== plan.role) {
        plan._originalRole = plan.role;
        plan.role = selection.role;
        plan._capabilityLane = selection.lane;
      } else {
        // Always stamp lane even for fallback selections so batch planner can use it.
        plan._capabilityLane = plan._capabilityLane || selection.lane;
      }
    }

    // ── Lane conflict detection ──────────────────────────────────────────────
    // Warn when plans within the same lane target overlapping files — these
    // should ideally run in separate waves to avoid concurrent write conflicts.
    const conflicts = detectLaneConflicts(poolResult.assignments);
    if (conflicts.length > 0) {
      await appendProgress(config,
        `[CAPABILITY_POOL] ${conflicts.length} lane conflict(s) detected — conflicting plans will be separated into distinct batches`
      );
      for (const c of conflicts) {
        warn(`[orchestrator] Lane conflict: lane="${c.lane}" plans="${c.plan1Task}" ↔ "${c.plan2Task}" share files: ${c.sharedFiles.join(", ")}`);
      }
    }
  } catch (err) {
    warn(`[orchestrator] Capability pool assignment failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Plan quality gate (Packet 12): skip plans failing contract validation ──
  try {
    const contractReport = validateAllPlans(plans);
    if (contractReport.passRate < 1) {
      await appendProgress(config,
        `[PLAN_QUALITY] Contract pass rate: ${(contractReport.passRate * 100).toFixed(0)}% — ${contractReport.results.filter(r => !r.valid).length} plan(s) have violations`
      );
      // Collect indices with critical violations; sort descending to preserve splice indices
      const toRemove = contractReport.results
        .filter(r => !r.valid && r.violations.some(v => v.severity === "critical"))
        .map(r => r.planIndex)
        .sort((a, b) => b - a);
      for (const idx of toRemove) {
        const plan = plans[idx];
        warn(`[orchestrator] Plan "${String(plan?.task || "unknown").slice(0, 60)}" has critical contract violation(s) — removing from dispatch`);
        plans.splice(idx, 1);
      }
      if (plans.length === 0) {
        await appendProgress(config, "[CYCLE] All plans removed by contract quality gate — cycle complete");
        await safeUpdatePipelineProgress(config, "cycle_complete", "All plans failed contract quality gate");
        return;
      }
    }
  } catch (err) {
    warn(`[orchestrator] Plan quality gate failed (non-fatal): ${String(err?.message || err)}`);
  }

  await appendProgress(config, `[CYCLE] ── Step 4: Evaluating dispatch admission for ${plans.length} worker plans ──`);

  // Pre-dispatch governance gate: single decision source for guardrail pause,
  // governance freeze, dependency cycle detection, and governance canary breach.
  // Replaces the inline PAUSE_WORKERS check and adds canary + cycle guards.
  {
    const cycleId = `cycle-${Date.now()}`;
    try {
      const gateDecision = await evaluatePreDispatchGovernanceGate(config, plans, cycleId, architectureDriftReport);
      emitEvent(EVENTS.GOVERNANCE_GATE_EVALUATED, EVENT_DOMAIN.GOVERNANCE, cycleId, {
        blocked: gateDecision.blocked,
        reason: gateDecision.reason || null,
        inputSnapshot: { planCount: plans.length, cycleId }
      });
      if (gateDecision.blocked) {
        const reasonMsg = gateDecision.dispatchBlockReason || gateDecision.reason || "pre_dispatch_gate_blocked";
        await appendProgress(config,
          `[CYCLE] Pre-dispatch governance gate blocked dispatch — reason=${reasonMsg}`
        );
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: "Worker dispatch blocked by pre-dispatch governance gate",
          message: `reason=${reasonMsg} action=${gateDecision.action || "none"} cycleId=${cycleId}`
        });
        try {
          const blockedAnalytics = computeCycleAnalytics(config, {
            phase: CYCLE_PHASE.INCOMPLETE,
            dispatchBlockReason: reasonMsg,
            pipelineProgress: null,
            workerResults: null,
          });
          await persistCycleAnalytics(config, blockedAnalytics);
          await appendGovernanceBlockEvent(config, {
            cycleId: cycleId,
            blockReason: reasonMsg,
            blockedAt: new Date().toISOString(),
            gateSource: "pre_dispatch_gate",
          });
          await recordCapabilityExecution(
            config,
            "dispatch-block-reason-reporting",
            `gateSource=pre_dispatch_gate reason=${reasonMsg.slice(0, 120)}`,
          );
        } catch (analyticsErr) {
          warn(`[orchestrator] Blocked-cycle analytics write failed (non-fatal): ${String(analyticsErr?.message || analyticsErr)}`);
        }
        return;
      }
      // Gate passed — record execution evidence so Janus can prove evaluation occurred.
      await recordCapabilityExecution(
        config,
        "governance-gate-evaluation",
        `blocked=false planCount=${plans.length}`,
      );
    } catch (err) {
      warn(`[orchestrator] Pre-dispatch governance gate failed (non-fatal): ${String(err?.message || err)}`);
      emitEvent(EVENTS.ORCHESTRATION_HEALTH_DEGRADED, EVENT_DOMAIN.ORCHESTRATION, cycleId, {
        reason: "governance_gate_exception",
        error: String(err?.message || err),
        context: "cycle_dispatch"
      });
    }
  }

  // Governance freeze gate (T-040): check per-plan risk before dispatching.
  // During month-12 freeze, high-risk plans (riskLevel=high|critical) are blocked
  // unless a critical incident override is attached to the plan.
  {
    const freezeStatus = isFreezeActive(config);
    if (freezeStatus.active) {
      await appendProgress(config,
        `[CYCLE] Governance freeze active (reason=${freezeStatus.reason}) — evaluating plan risk levels`
      );
    }

    const filteredPlans = [];
    for (const plan of plans) {
      const gateResult = evaluateFreezeGate(config, {
        riskLevel:       plan.riskLevel || null,
        riskScore:       typeof plan.riskScore === "number" ? plan.riskScore : 0,
        criticalOverride: plan.criticalOverride || null
      });
      if (!gateResult.allowed) {
        await appendProgress(config,
          `[CYCLE] FREEZE BLOCKED plan for ${plan.role}: ${gateResult.reason}`
        );
        warn(`[orchestrator] governance freeze blocked plan for ${plan.role}: ${gateResult.reason}`);
        // No silent fallback: write a machine-readable blocked record
        continue;
      }
      if (gateResult.overrideApproved) {
        await appendProgress(config,
          `[CYCLE] Critical override granted for ${plan.role}: incidentId=${gateResult.overrideApproved.incidentId}`
        );
      }
      filteredPlans.push(plan);
    }

    if (filteredPlans.length < plans.length) {
      const blockedCount = plans.length - filteredPlans.length;
      await appendProgress(config,
        `[CYCLE] Governance freeze blocked ${blockedCount} of ${plans.length} plan(s) — proceeding with ${filteredPlans.length} allowed plan(s)`
      );
      // Reassign plans to only allowed set; if none remain, exit cycle
      plans.splice(0, plans.length, ...filteredPlans);
      if (plans.length === 0) {
        await appendProgress(config, "[CYCLE] All plans blocked by governance freeze — cycle complete");
        await safeUpdatePipelineProgress(config, "cycle_complete", "All plans blocked by governance freeze");
        return;
      }
    }
  }

  // Funnel tracking: capture dispatched count after all quality/freeze gates.
  const funnelDispatchedCount: number = plans.length;

  // ── Optimizer budget admission gate ──────────────────────────────────────
  // The intervention optimizer ranks plans by expected value and enforces all
  // three budget constraints (total, per-wave, per-role) simultaneously.
  // Its selected[] output is the authoritative set of plans admitted to dispatch.
  // Fail-open when the optimizer cannot run (invalid budget config, empty input,
  // or any exception) so a missing budget configuration never halts work.
  let optimizerUsage: {
    policyImpactPenaltiesApplied: number;
    benchmarkBoostsApplied: number;
    benchmarkTelemetryCount: number;
    failureClassificationsApplied: number;
    rerouteCostPenaltiesApplied: number;
    overbundlePenaltiesApplied: number;
  } | null = null;

  if (config?.runtime?.disableOptimizerAdmission !== true) {
    try {
      const interventions = buildInterventionsFromPlan(plans, config);
      const budgetInput = buildBudgetFromConfig(prometheusAnalysis?.requestBudget, config);

      // ── Policy impact: load learned policies and map to intervention scores ──
      let policyImpactByInterventionId: Record<string, unknown> | undefined;
      try {
        const learnedPoliciesRaw = await readJson(path.join(stateDir, "learned_policies.json"), []);
        const learnedPolicies = Array.isArray(learnedPoliciesRaw) ? learnedPoliciesRaw : [];
        if (learnedPolicies.length > 0 && Array.isArray(prometheusAnalysis?.plans)) {
          policyImpactByInterventionId = buildPolicyImpactByInterventionId(
            prometheusAnalysis.plans,
            learnedPolicies,
          );
        }
      } catch {
        // Non-fatal: learned policies unavailable, optimizer uses static estimates
      }

      // ── Benchmark telemetry: lane-level performance from previous cycle ─────
      const benchmarkTelemetry: Array<{ interventionId: string; observedSuccessRate: number; sampleCount: number }> = [];
      try {
        const prevAnalytics = await readCycleAnalytics(config);
        const prevLaneTelemetry = prevAnalytics?.lastCycle?.laneTelemetry;
        if (prevLaneTelemetry && typeof prevLaneTelemetry === "object") {
          // Convert lane-level telemetry to per-intervention benchmark signals.
          // Each plan is matched to its lane; the lane's observed completion rate
          // becomes the benchmark for that intervention.
          for (const plan of (Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans : [])) {
            const role = String(plan?.role || "evolution-worker");
            const lane = role.replace(/[-_]worker$/i, "").toLowerCase();
            const laneSignal = prevLaneTelemetry[lane] ?? prevLaneTelemetry["implementation"];
            if (!laneSignal) continue;
            const rate = Number(laneSignal.completionRate);
            if (!Number.isFinite(rate)) continue;
            const interventionId = String(plan?.intervention_id || plan?.id || plan?.task_id || "");
            if (interventionId) {
              benchmarkTelemetry.push({
                interventionId,
                observedSuccessRate: Math.max(0, Math.min(1, rate)),
                sampleCount: Number(laneSignal.dispatched ?? 1),
              });
            }
          }
        }
      } catch {
        // Non-fatal: lane telemetry unavailable, optimizer uses static estimates
      }

      // ── Failure classifications: load from state for optimizer SP adjustment ──
      // Classifications from previous cycle failures are loaded and passed as
      // failureClassifications so the optimizer can adjust successProbability
      // for roles that have recently failed, shifting budget to healthier lanes.
      let failureClassifications: Record<string, unknown> | undefined;
      try {
        const loaded = await loadRecentFailureClassifications(stateDir, 30);
        if (Object.keys(loaded).length > 0) {
          failureClassifications = loaded;
        }
      } catch { /* non-fatal — optimizer falls back to static estimates */ }

      // ── Anti-overbundle step count map: pass per-plan step complexity ──────
      // Maps intervention ID → ordered step count so the optimizer can apply
      // an EV penalty to over-complex plans that would exceed coherence limits
      // if dispatched as a single call.
      const overbundleStepCounts: Record<string, number> = {};
      for (let idx = 0; idx < plans.length; idx++) {
        const plan = plans[idx] as any;
        const interventionId = String(plan?.id ?? plan?.task_id ?? `plan-${idx + 1}`);
        const steps = Array.isArray(plan?.orderedSteps) ? plan.orderedSteps.length
          : Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria.length
          : 1;
        overbundleStepCounts[interventionId] = Math.max(1, steps);
      }

      const optimizerResult = runInterventionOptimizer(interventions, budgetInput, {
        policyImpactByInterventionId,
        failureClassifications,
        benchmarkTelemetry: benchmarkTelemetry.length > 0 ? benchmarkTelemetry : undefined,
        // Pass capability pool specialization utilization so the optimizer log records
        // the active workerPool policy alongside selection decisions for alignment
        // diagnostics between scoreboard, gate, and optimizer telemetry.
        specializationContext: (capabilityPoolResult as any)?.specializationUtilization ?? null,
        overbundleStepCounts,
        rerouteReasons: await (async () => {
          // Read reroute history from previous cycle to penalize underperforming lanes.
          try {
            const { readFile } = await import("node:fs/promises");
            const rerouteHistoryPath = path.join(stateDir, "reroute_history.jsonl");
            const raw = await readFile(rerouteHistoryPath, "utf8");
            const lines = raw.split("\n").filter(l => l.trim().length > 0);
            // Use last 20 reroute records as the penalty window
            return lines.slice(-20).map(line => {
              try { return JSON.parse(line); } catch { return null; }
            }).filter(Boolean);
          } catch {
            return [];
          }
        })(),
      });

      // Capture usage counters for cycle analytics propagation
      const optimizerResultAny = optimizerResult as any;
      optimizerUsage = {
        policyImpactPenaltiesApplied: Number(optimizerResultAny.policyImpactPenaltiesApplied ?? 0),
        benchmarkBoostsApplied: Number(optimizerResultAny.benchmarkBoostsApplied ?? 0),
        benchmarkTelemetryCount: Number(optimizerResultAny.benchmarkTelemetryCount ?? 0),
        failureClassificationsApplied: Number(optimizerResultAny.failureClassificationsApplied ?? 0),
        rerouteCostPenaltiesApplied: Number(optimizerResultAny.rerouteCostPenaltiesApplied ?? 0),
        overbundlePenaltiesApplied: Number(optimizerResultAny.overbundlePenaltiesApplied ?? 0),
      };

      // Persist for observability regardless of outcome
      await persistOptimizerLog(stateDir, optimizerResult).catch(() => {});

      if (
        optimizerResult.status !== OPTIMIZER_STATUS.INVALID_INPUT &&
        optimizerResult.status !== OPTIMIZER_STATUS.EMPTY_INPUT
      ) {
        const admittedIds = new Set(optimizerResult.selected.map((i: any) => i.id));
        const admittedPlans = plans.filter((plan: any, idx: number) => {
          const interventionId = String(plan?.id ?? `plan-${idx + 1}`);
          return admittedIds.has(interventionId);
        });

        if (admittedPlans.length < plans.length) {
          const rejectedCount = plans.length - admittedPlans.length;
          await appendProgress(config,
            `[OPTIMIZER] Budget admission: ${admittedPlans.length}/${plans.length} plan(s) admitted — ${rejectedCount} rejected (status=${optimizerResult.status} reason=${optimizerResult.reasonCode})`
          );
          plans.splice(0, plans.length, ...admittedPlans);
          if (plans.length === 0) {
            await appendProgress(config, "[CYCLE] All plans rejected by optimizer budget gate — cycle complete");
            await safeUpdatePipelineProgress(config, "cycle_complete", "All plans rejected by optimizer budget gate");
            return;
          }
        } else {
          await appendProgress(config,
            `[OPTIMIZER] Budget admission: all ${plans.length} plan(s) admitted (status=${optimizerResult.status}) policyPenalties=${optimizerUsage.policyImpactPenaltiesApplied} benchmarkBoosts=${optimizerUsage.benchmarkBoostsApplied}`
          );
        }
      }
    } catch (err) {
      warn(`[orchestrator] Optimizer admission gate failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  const cycleLineageId = String((prometheusAnalysis as any)?.cycleId || (prometheusAnalysis as any)?.analyzedAt || Date.now());
  const shouldUseTypedHandoffChain = (plan: any) => {
    const risk = String(plan?.riskLevel || plan?.complexity || "").toLowerCase();
    const expectedROI = Number(plan?.requestROI || plan?.predictedROI || 0);
    return ["high", "critical"].includes(risk) && expectedROI >= 1.2;
  };
  const laneToWorkerRole = (lane: string) => {
    switch (String(lane || "").toLowerCase()) {
      case "quality": return "quality-worker";
      case "governance": return "governance-worker";
      case "integration": return "integration-worker";
      case "infrastructure": return "infrastructure-worker";
      case "observation": return "observation-worker";
      default: return "evolution-worker";
    }
  };
  const expandPlansToTypedHandoffChains = async (inputPlans: any[]) => {
    const expanded: any[] = [];
    let batchCursor = 1;
    let chainCount = 0;
    for (const plan of inputPlans) {
      if (!shouldUseTypedHandoffChain(plan)) {
        expanded.push(plan);
        continue;
      }
      const chain = buildWorkerChain(plan, { complexity: plan?.riskLevel || plan?.complexity || "high" });
      if (!chain.isChained || chain.chain.length === 0) {
        expanded.push(plan);
        continue;
      }
      chainCount += 1;
      const chainId = String(plan?.task_id || plan?.id || plan?.intervention_id || `chain-${chainCount}`)
        .replace(/[^a-zA-Z0-9_-]+/g, "-");
      for (let index = 0; index < chain.chain.length; index += 1) {
        const stage = chain.chain[index];
        const artifactId = `${chainId}:${stage.stage}`;
        const previousStage = index > 0 ? chain.chain[index - 1] : null;
        expanded.push({
          ...plan,
          task: stage.task,
          role: laneToWorkerRole(stage.lane),
          wave: Number(plan?.wave || 1) + index,
          _chainMode: true,
          _chainId: chainId,
          _chainStage: stage.stage,
          _chainStageIndex: index + 1,
          _chainStageTotal: chain.chain.length,
          _typedHandoffArtifact: {
            id: artifactId,
            chainId,
            stage: stage.stage,
            fromStage: previousStage ? previousStage.stage : null,
            toStage: index < chain.chain.length - 1 ? chain.chain[index + 1].stage : null,
            artifactKey: `${chainId}:${stage.stage}:artifact`,
          },
          _batchIndex: batchCursor,
          _batchWorkerRole: laneToWorkerRole(stage.lane),
          _batchWave: Number(plan?.wave || 1) + index,
          _chainSourceTask: String(plan?.task || plan?.title || ""),
        });
        batchCursor += 1;
      }
      for (let index = 1; index < chain.chain.length; index += 1) {
        const fromStage = chain.chain[index - 1];
        const toStage = chain.chain[index];
        await recordAgentHandoff(config, {
          from: laneToWorkerRole(fromStage.lane),
          to: laneToWorkerRole(toStage.lane),
          cycleId: cycleLineageId,
          status: "planned",
          summary: `${String(plan?.task || plan?.title || "").slice(0, 160)} :: ${fromStage.stage}->${toStage.stage}`,
          artifact: `${chainId}:${fromStage.stage}->${toStage.stage}`,
        }).catch(() => {});
      }
    }
    return { plans: expanded, chainCount };
  };

  const chainExpansion = await expandPlansToTypedHandoffChains(plans as any[]);
  if (chainExpansion.chainCount > 0) {
    await appendProgress(config, `[CHAIN_MODE] Expanded ${chainExpansion.chainCount} high-complexity plan(s) into typed handoff chains`);
    plans.splice(0, plans.length, ...chainExpansion.plans);
  }

  if (optimizerUsage) {
    (optimizerUsage as any).interventionApplications = plans.length;
    (optimizerUsage as any).typedHandoffStagesPlanned = plans.filter((plan: any) => plan?._chainMode === true).length;
  }

  await appendInterventionApplicationEntries(
    config,
    plans.map((plan: any, index: number) => ({
      interventionId: String(plan?.intervention_id || plan?.id || plan?.task_id || `plan-${index + 1}`),
      lineageId: String(plan?._chainId || plan?.lineageId || plan?.task_id || "") || null,
      policyId: String(plan?.policyId || "") || null,
      cycleId: cycleLineageId,
      role: String(plan?.role || "evolution-worker"),
      selectedAt: new Date().toISOString(),
      status: plan?._chainMode ? `selected:${String(plan?._chainStage || "stage")}` : "selected",
      noSignalOutcome: false,
      decisionReason: plan?._chainMode ? "typed_handoff_chain" : "optimizer_admitted",
    })),
  ).catch(() => {});

  // Normalize analysis-only roles before batch planning so plans that will
  // be redirected to evolution-worker are co-batched together instead of
  // producing one thin batch per logical role (prometheus/athena/orchestrator).
  const normalizedPlansForBatching = plans.map((p: any) => {
    const resolved = resolveWorkerRole(p?.role, p?.taskKind || p?.kind || "implementation");
    return resolved !== (p?.role || "") ? { ...p, role: resolved } : p;
  });
  const redirectedCount = normalizedPlansForBatching.filter((p: any, i: number) => p.role !== (plans as any[])[i]?.role).length;
  if (redirectedCount > 0) {
    await appendProgress(config, `[BATCH_PLANNER] Normalized ${redirectedCount} analysis-only role(s) → evolution-worker for co-batching`);
  }

  // ── Token-first batch path ──────────────────────────────────────────────────
  // Use when:
  //   (a) Athena already ran deterministic rebatch (_batchIndex present), OR
  //   (b) config.planner.tokenFirstPacking === true (explicit opt-in)
  // Falls back to role-split path otherwise (backward-compatible).
  const athenaPreBatched = normalizedPlansForBatching.length > 0 &&
    Number.isFinite(Number((normalizedPlansForBatching[0] as any)?._batchIndex));
  const tokenFirstEnabled = (config as any)?.planner?.tokenFirstPacking !== false; // default ON
  const useTokenFirst = athenaPreBatched || tokenFirstEnabled;

  // If Athena already assigned deterministic batch indexes, keep those batches
  // and worker choices as-is instead of re-packing in orchestrator.
  const _rawWorkerBatches = athenaPreBatched
    ? (() => {
        const grouped = new Map<number, any[]>();
        for (const plan of normalizedPlansForBatching as any[]) {
          const bi = Number(plan?._batchIndex);
          const idx = Number.isFinite(bi) && bi > 0 ? Math.floor(bi) : 1;
          if (!grouped.has(idx)) grouped.set(idx, []);
          grouped.get(idx)!.push(plan);
        }

        const sortedIndexes = [...grouped.keys()].sort((a, b) => a - b);
        const prebuiltBatches = sortedIndexes.map((batchIndex) => {
          const batchPlans = grouped.get(batchIndex) || [];
          const role = String(
            batchPlans[0]?._batchWorkerRole
            || batchPlans[0]?.role
            || "evolution-worker"
          ).trim() || "evolution-worker";
          const wave = Number(batchPlans[0]?._batchWave || batchPlans[0]?.wave || 1);
          return {
            role,
            plans: batchPlans,
            wave,
            _athenaOriginalBatchIndex: batchIndex,
            tokenFirstPacked: true,
            athenaBatchAssigned: true,
          };
        });
        return prebuiltBatches
          .sort((left, right) => (
            Number(left?.wave || 1) - Number(right?.wave || 1)
          ) || (
            Number((left as any)?._athenaOriginalBatchIndex || 1) - Number((right as any)?._athenaOriginalBatchIndex || 1)
          ))
          .map((batch, pos) => ({
            ...batch,
            roleBatchIndex: pos + 1,
            roleBatchTotal: prebuiltBatches.length,
            bundleIndex: pos + 1,
            totalBundles: prebuiltBatches.length,
            githubFinalizer: pos === prebuiltBatches.length - 1,
          }));
      })()
    : (useTokenFirst
      ? await (async () => {
          try {
            const { readCalibrationState } = await import("./token_calibration.js");
            const calState = await readCalibrationState(config);
            return buildTokenFirstBatches(normalizedPlansForBatching, config, { calibrationState: calState });
          } catch {
            return buildTokenFirstBatches(normalizedPlansForBatching, config);
          }
        })()
      : buildRoleExecutionBatches(normalizedPlansForBatching, config, capabilityPoolResult));

  // ── Final dispatch-boundary hard cap ─────────────────────────────────────
  // Unconditional last safeguard: applied after all three batching paths
  // (Athena-prebatched, token-first, standard role-split) so no batch descriptor
  // delivered to a worker ever exceeds MAX_ACTIONABLE_STEPS_PER_PACKET tasks,
  // regardless of config state or which path produced the batches.
  let workerBatches = applyDispatchBoundaryHardCap(_rawWorkerBatches as any[]) as typeof _rawWorkerBatches;
  const packed = tightenRoleWaveBatches(workerBatches as any[], config);
  workerBatches = packed.batches as typeof _rawWorkerBatches;
  if (packed.mergedCount > 0) {
    await appendProgress(config,
      `[BATCH_PLANNER] Tight role-wave packing merged ${packed.mergedCount} adjacent small batch(es); now ${workerBatches.length} batch(es)`
    );
  }

  // ── DAG frontier + parallelism logging ────────────────────────────────────
  // Use computeFrontier to identify which plans are immediately dispatchable
  // (no unresolved dependencies) and log the DAG-derived parallelism bound.
  // This is advisory telemetry — never blocks dispatch.
  try {
    const frontierResult = computeFrontier(
      plans as any[],
      new Set<string>(), // no tasks completed yet at dispatch time
      new Set<string>(), // no tasks failed yet
      new Set<string>(), // no tasks in progress yet
    );
    const dagBound = (_rawWorkerBatches[0] as any)?.dagParallelismBound;
    if (frontierResult.frontier.length > 0 || dagBound !== undefined) {
      await appendProgress(
        config,
        `[DAG_DISPATCH] frontier=${frontierResult.frontier.length} ready task(s) of ${plans.length} total` +
        (dagBound !== undefined ? `; dagParallelismBound=${dagBound}` : "")
      );
    }
  } catch {
    // advisory — never block dispatch on frontier computation error
  }

  // ── Specialist telemetry for Athena-preassigned batches (Task 3) ───────────
  // buildTokenFirstBatches normally stamps specialistReroutes / specialistRerouteReasons /
  // specialistUtilizationTarget on workerBatches[0].  When Athena pre-assigned the
  // batch groupings the token-first path is bypassed, so those fields are missing and
  // the scoreboard / reroute-history never gets populated.
  // Derive equivalent telemetry from the already-computed capabilityPoolResult.
  if (athenaPreBatched && capabilityPoolResult && workerBatches.length > 0) {
    const firstBatch = workerBatches[0] as any;
    const util = capabilityPoolResult.specializationUtilization;

    // Detect reroutes: plans where Athena's _batchWorkerRole differs from the
    // pool-assigned role (the pool may have re-routed a specialist to evo-worker).
    const poolRoleByPlan = new Map<unknown, string>();
    for (const { plan, selection } of (capabilityPoolResult.assignments || [])) {
      poolRoleByPlan.set(plan, String(selection?.role || "evolution-worker"));
    }

    // Group rerouted plans by their Athena-assigned role so each specialist role
    // gets one telemetry record (matching buildTokenFirstBatches convention) with
    // fillRatio computed from the combined token estimate of that role group.
    const reroutedByAthenaRole = new Map<string, { lane: string; plans: any[] }>();
    for (const [plan, poolRole] of poolRoleByPlan.entries()) {
      const athenaRole = String((plan as any)?._batchWorkerRole || (plan as any)?.role || "evolution-worker");
      if (athenaRole !== poolRole) {
        const lane = String((plan as any)?._capabilityLane || "implementation");
        if (!reroutedByAthenaRole.has(athenaRole)) {
          reroutedByAthenaRole.set(athenaRole, { lane, plans: [] });
        }
        reroutedByAthenaRole.get(athenaRole)!.plans.push(plan);
      }
    }

    // Resolve usable context window size for fill-ratio computation, matching
    // the same model resolution used by buildTokenFirstBatches.
    const athenaDefaultModel = (config as any)?.copilot?.defaultModel || "Claude Sonnet 4.6";
    const athenaUsableTokens = getUsableModelContextTokens(config, athenaDefaultModel);
    const athenaBaseThreshold = DEFAULT_SPECIALIST_FILL_THRESHOLD;

    const athenaRerouteReasons: Array<{
      role: string; lane: string; reasonCode: string;
      fillRatio: number; laneScore: number; adaptiveFillThreshold: number;
    }> = [];
    for (const [athenaRole, { lane, plans: rolePlans }] of reroutedByAthenaRole.entries()) {
      const groupTokens = rolePlans.reduce((sum: number, p: any) => sum + estimatePlanTokens(p), 0);
      const computedFillRatio = athenaUsableTokens > 0
        ? Math.round((groupTokens / athenaUsableTokens) * 1000) / 1000
        : 0;
      const computedLaneScore = getLaneScore(lanePerformanceFromCycle, lane);
      const computedAdaptiveThreshold = computeAdaptiveSpecialistFillThreshold(
        athenaBaseThreshold,
        lane,
        lanePerformanceFromCycle,
      );
      athenaRerouteReasons.push({
        role: athenaRole,
        lane,
        reasonCode: "below_fill_threshold",
        fillRatio: computedFillRatio,
        laneScore: computedLaneScore,
        adaptiveFillThreshold: computedAdaptiveThreshold,
      });
    }

    firstBatch.specialistReroutes = athenaRerouteReasons.map(r => r.role);
    firstBatch.specialistRerouteReasons = athenaRerouteReasons;
    if (util) {
      const totalPlans = Math.max(1, Array.isArray(normalizedPlansForBatching) ? normalizedPlansForBatching.length : 0);
      const achievedSpecializedCount = Math.max(0, Math.round(Number(util.specializedShare || 0) * totalPlans));
      const requiredSpecializedCount = Math.max(0, Math.ceil(Number(util.adaptiveMinSpecializedShare || 0) * totalPlans));
      const feasibleSpecializedCount = Math.max(achievedSpecializedCount, Number(util.specializedCount || 0));
      firstBatch.specialistUtilizationTarget = {
        targetMet: achievedSpecializedCount >= requiredSpecializedCount,
        achievedSpecializedCount,
        requiredSpecializedCount,
        feasibleSpecializedCount,
        infeasibleUnderCurrentMix: feasibleSpecializedCount < requiredSpecializedCount,
        minSpecializedShare: util.minSpecializedShare,
        adaptiveMinSpecializedShare: util.adaptiveMinSpecializedShare,
        poolReportedTargetMet: util.specializationTargetsMet === true,
        reservedSpecialistLaneCount: util.reservedSpecialistLaneCount,
        reservedSpecialistLanes: util.reservedSpecialistLanes,
        effectiveSpecialistLaneCount: util.effectiveSpecialistLaneCount,
        effectiveSpecialistLanes: util.effectiveSpecialistLanes,
        fallbackCollapseCount: util.fallbackCollapseCount,
        fallbackCollapseRate: util.fallbackCollapseRate,
        collapsedReservedLanes: util.collapsedReservedLanes,
      };
    }
  }

  if (useTokenFirst) {
    const reroutes = (workerBatches as any[])?.[0]?.specialistReroutes;
    const rerouteReasons = (workerBatches as any[])?.[0]?.specialistRerouteReasons;
    const specializationTarget = (workerBatches as any[])?.[0]?.specialistUtilizationTarget;
    const rerouteMsg = Array.isArray(reroutes) && reroutes.length > 0
      ? ` | specialist→evo reroutes: ${reroutes.join(", ")}`
      : "";
    const rebalanceMsg = specializationTarget?.rebalanceApplied === true
      ? ` | specialist rebalance: +${Number(specializationTarget.rebalancedCount || 0)}`
      : "";
    await appendProgress(config,
      `[BATCH_PLANNER] Token-first packing: ${normalizedPlansForBatching.length} plan(s) → ${workerBatches.length} batch(es)${
        athenaPreBatched ? " (Athena-selected batches applied)" : ""
      }${rerouteMsg}${rebalanceMsg}`
    );
    // Emit structured reroute telemetry for each rerouted specialist so the
    // adaptive threshold cycle can observe the reason codes and lane scores.
    if (Array.isArray(rerouteReasons) && rerouteReasons.length > 0) {
      for (const reason of rerouteReasons) {
        await appendProgress(config,
          `[BATCH_PLANNER] specialist_reroute reason=${reason.reasonCode} role=${reason.role} lane=${reason.lane} fillRatio=${reason.fillRatio} laneScore=${reason.laneScore} adaptiveThreshold=${reason.adaptiveFillThreshold}`
        );
      }
      // Persist reroute reasons to reroute_history.jsonl for next-cycle optimizer EV penalty.
      try {
        const { appendFileSync } = await import("node:fs");
        const rerouteHistoryPath = path.join(stateDir, "reroute_history.jsonl");
        for (const reason of rerouteReasons) {
          appendFileSync(rerouteHistoryPath, JSON.stringify({
            recordedAt: new Date().toISOString(),
            role: reason.role,
            lane: reason.lane,
            reasonCode: reason.reasonCode,
            fillRatio: reason.fillRatio,
            laneScore: reason.laneScore,
          }) + "\n", "utf8");
          emitEvent(EVENTS.POLICY_REROUTE_PENALTY_APPLIED, EVENT_DOMAIN.POLICY, `reroute-${reason.role}-${Date.now()}`, {
            role: reason.role,
            lane: reason.lane,
            reasonCode: reason.reasonCode,
            fillRatio: reason.fillRatio,
            laneScore: reason.laneScore,
          });
        }
      } catch (err) {
        warn(`[orchestrator] reroute history persist failed (non-fatal): ${String(err?.message || err)}`);
      }
    }

    if (
      config?.runtime?.enforceSpecialistUtilizationAdmission === true
      && specializationTarget
    ) {
      const achieved = Number(specializationTarget.achievedSpecializedCount || 0);
      const required = Number(specializationTarget.requiredSpecializedCount || 0);
      const feasible = Number(specializationTarget.feasibleSpecializedCount || achieved);
      if (achieved < required) {
        if (feasible < required) {
          await appendProgress(
            config,
            `[BATCH_PLANNER] Specialist utilization target infeasible under admitted mix: achieved=${achieved} feasibleMax=${feasible} required=${required} — proceeding with deterministic degraded admission`
          );
        } else {
        await appendProgress(
          config,
          `[BATCH_PLANNER] Specialist utilization admission blocked dispatch: achieved=${achieved} required=${required}`
        );
        return;
        }
      }
    }
  }

  // ── Premium request gate ───────────────────────────────────────────────────
  // Warn when batch count is unexpectedly high relative to plan count.
  // minPossibleBatches = ceil(totalEstimatedTokens / usableContextTokens); we use
  // plan count as a practical proxy. If batches > plans + 1, log a warning.
  if (workerBatches.length > normalizedPlansForBatching.length + 1) {
    await appendProgress(config,
      `[BATCH_PLANNER] WARNING: generated ${workerBatches.length} batches for ${normalizedPlansForBatching.length} plan(s) — possible over-split; check estimatedExecutionTokens`
    );
  }

  // ── Ordered-step complexity hard admission (split-or-reject) ─────────────
  // Convert overbundle from advisory telemetry into an explicit dispatch guard.
  // Any batch above OVERBUNDLE_STEPS_THRESHOLD is split deterministically by
  // ordered-step cost. If a single plan exceeds the threshold, dispatch is blocked.
  {
    const complexityAdjusted: any[] = [];
    let splitCount = 0;
    let blockedReason = "";
    for (const batch of workerBatches as any[]) {
      const stepCount = Number(batch?.orderedStepCount ?? 0);
      if (stepCount <= OVERBUNDLE_STEPS_THRESHOLD) {
        complexityAdjusted.push(batch);
        continue;
      }
      const split = splitBatchByOrderedStepComplexity(batch, OVERBUNDLE_STEPS_THRESHOLD);
      if (split.length === 0) {
        const role = String(batch?.role || "unknown");
        blockedReason = `ordered_step_complexity_unsplittable:${role}:${stepCount}>${OVERBUNDLE_STEPS_THRESHOLD}`;
        break;
      }
      if (split.length > 1) splitCount += split.length - 1;
      complexityAdjusted.push(...split);
    }
    if (blockedReason) {
      await appendProgress(config, `[BATCH_PLANNER][OVERBUNDLE] Dispatch blocked — ${blockedReason}`);
      await safeUpdatePipelineProgress(config, "cycle_complete", `Dispatch blocked by ordered-step complexity gate: ${blockedReason}`);
      return;
    }
    if (splitCount > 0) {
      workerBatches = complexityAdjusted as typeof _rawWorkerBatches;
      await appendProgress(
        config,
        `[BATCH_PLANNER][OVERBUNDLE] Complexity split applied: +${splitCount} batch(es), threshold=${OVERBUNDLE_STEPS_THRESHOLD}`
      );
    }
  }

  // ── Stamp deterministic task IDs on all plans at batch time ──────────────
  // Plans that arrive without a task_id (or id) are assigned a stable
  // deterministic ID before the first dispatch event fires.  This ensures
  // workerActivity.taskIds and completedTaskIds are always non-empty when
  // plans carry task text, regardless of which batching path produced them.
  stampBatchPlanTaskIds(workerBatches as any[]);

  await safeUpdatePipelineProgress(config, "workers_dispatching", `Dispatching ${workerBatches.length} worker batch(es)`, {
    workersTotal: workerBatches.length,
    workersDone: 0
  });

  const dispatchCheckpoint = await beginDispatchCheckpoint(config, workerBatches, plans.length, {
    planAnalyzedAt: String(prometheusAnalysis?.analyzedAt || ""),
    plannerPromptLineage: plannerPromptLineage || resolvePlannerPromptLineageFromAnalysis(prometheusAnalysis),
    reviewerPromptLineage: resolveReviewerPromptLineageFromReview(planReview, prometheusAnalysis),
  });
  let workersDone = 0;
  let pendingCycleHealthRecord: Record<string, unknown> | null = null;
  const allWorkerResults: Array<{
    roleName: string;
    status: string;
    verificationEvidence?: unknown;
    dispatchContract?: {
      doneWorkerWithVerificationReportEvidence?: boolean;
      doneWorkerWithCleanTreeStatusEvidence?: boolean;
      dispatchBlockReason?: string | null;
      closureBoundaryViolation?: boolean;
      replayClosure?: {
        contractSatisfied?: boolean;
        canonicalCommands?: string[];
        executedCommands?: string[];
        rawArtifactEvidenceLinks?: string[];
      } | null;
    } | null;
    dispatchBlockReason?: string | null;
    closureBoundaryViolation?: boolean;
    planTasks: string[];
    filesTouched: string[];
    synthesisSources: string[];
  }> = [];
  // Collects (taskText, verificationEvidence) from successful workers for
  // carry-forward auto-close matching at end of cycle.
  const resolvedPlanItems: Array<{ taskText: string; verificationEvidence: unknown }> = [];

  // ── Strict wave boundary tracking ──────────────────────────────────────────
  // Each time the wave number changes, we log an explicit boundary event.
  // Reaching a new wave boundary in the loop guarantees all preceding wave's
  // batches completed successfully (the loop returns early on any failure),
  // giving a hard sequential barrier between waves.
  let currentDispatchWave: number | null = null;
  let waveBoundaryStartMs: number | null = null;  // ms timestamp when last wave completed
  let waveBatchCount = 0;                          // batches dispatched in current wave
  const cycleRetryTelemetry = await loadRetryTelemetryContext(config);
  const dispatchArtifactCycleId = normalizeCycleId((await readPipelineProgress(config).catch(() => null))?.startedAt || cycleStartedAt);
  // Accumulate transient retries across all batches so cycle_analytics can surface
  // real retry pressure rather than the synthetic 0 constant used previously.
  let cycleTransientRetries = 0;

  for (const batch of workerBatches) {
    // ── Cooperative cancellation checkpoint ─────────────────────────────────
    // Check both the in-process token and the on-disk stop file so a stop
    // request is honoured within the current batch cycle rather than only at
    // the top of the next main-loop iteration.
    checkCancellationAtCheckpoint(_token);
    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      _token?.cancel(`stop-requested:${stopReq.reason || "unknown"}`);
      await appendProgress(config, `[CYCLE] Stop requested — halting dispatch`);
      return;
    }

    // ── Wave boundary gate ───────────────────────────────────────────────────
    // Detect wave transitions. Arrival here proves all prior-wave batches done.
    const batchWave = typeof (batch as any).wave === "number" ? (batch as any).wave : null;
    if (batchWave !== null && batchWave !== currentDispatchWave) {
      if (currentDispatchWave !== null) {
        await appendProgress(config,
          `[WAVE_BOUNDARY] Wave ${currentDispatchWave} complete — all batches succeeded. Crossing to wave ${batchWave}.`
        );
        // ── Measure and persist wave boundary idle gap ──────────────────────
        const waveBoundaryEndMs = Date.now();
        if (waveBoundaryStartMs !== null) {
          try {
            const { appendFileSync } = await import("node:fs");
            const idleRecord = measureWaveBoundaryIdleGap(
              currentDispatchWave,
              batchWave,
              waveBoundaryStartMs,
              waveBoundaryEndMs,
              waveBatchCount,
            );
            appendFileSync(
              path.join(stateDir, "wave_boundary_idle.jsonl"),
              JSON.stringify(idleRecord) + "\n",
              "utf8",
            );
            await appendProgress(config,
              `[WAVE_BOUNDARY] Idle gap measured: waveFrom=${idleRecord.waveFrom} waveTo=${idleRecord.waveTo} idleMs=${idleRecord.idleMs} batchCount=${idleRecord.batchCount}`
            );
            // Log packing opportunity if the heuristic detects a safe co-pack
            const fromBatches = (workerBatches as any[]).filter(b => b.wave === currentDispatchWave);
            const toBatches = (workerBatches as any[]).filter(b => b.wave === batchWave);
            if (shouldPackAcrossWaveBoundary(fromBatches, toBatches)) {
              await appendProgress(config,
                `[WAVE_BOUNDARY] Packing opportunity detected: singleton wave ${currentDispatchWave} could be co-packed into wave ${batchWave} (no dependency violation)`
              );
            }
          } catch (wbErr) {
            warn(`[orchestrator] wave boundary idle persist failed (non-fatal): ${String(wbErr?.message || wbErr)}`);
          }
        }
        waveBatchCount = 0;
      }
      currentDispatchWave = batchWave;
      await appendProgress(config,
        `[WAVE_BOUNDARY] Starting wave ${batchWave} — batch ${workersDone + 1}/${workerBatches.length} roleBatch=${Number((batch as any)?.roleBatchIndex || 1)}/${Number((batch as any)?.roleBatchTotal || 1)} role=${String((batch as any)?.role || "worker")}`
      );
    }
    waveBatchCount += 1;

    const dispatchTarget = await resolveDispatchTargetForPlan(config, batch);
    const workerLabel = dispatchTarget.roleName === String(batch.role || "worker")
      ? dispatchTarget.roleName
      : `${String(batch.role || "worker")} -> ${dispatchTarget.roleName}`;

    await safeUpdatePipelineProgress(config, "workers_running", `Running worker batch ${workersDone + 1}/${workerBatches.length}: ${workerLabel}`, {
      workersTotal: workerBatches.length,
      workersDone,
      currentWorker: dispatchTarget.roleName
    });
    const workerPremiumEvent = await spendPremium(
      dispatchTarget.roleName,
      "worker_batch_dispatch",
      { pendingOutcome: true },
    );
    await appendProgress(config, `[AGENT] » WORKER · ${workerLabel} · batch=${workersDone + 1}/${workerBatches.length} · req#${_cycleRequests} this cycle`);
    await persistWorkerDispatchArtifacts(config, {
      cycleId: dispatchArtifactCycleId,
      role: String(batch?.role || ""),
      phase: "start",
      batch,
      resolvedRole: dispatchTarget.roleName,
    });
    // Trace: worker dispatch invocation — proves dispatchWorker was invoked for this batch.
    await recordCapabilityExecution(
      config,
      "worker-dispatch-invocation",
      `role=${String(batch?.role || "unknown")} batch=${workersDone + 1}/${workerBatches.length}`,
    );

    let workerResult;
    let transientRetries = 0;
    for (;;) {
      try {
        workerResult = await dispatchWorker(config, batch);
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 200);
        await appendProgress(config, `[CYCLE] Worker ${batch.role} failed: ${msg}`);
        warn(`[orchestrator] worker dispatch error: ${msg}`);
        workerResult = { roleName: dispatchTarget.roleName, status: "error", summary: msg };
      }

      // Auto-retry on transient API errors with escalating cooldown
      const isTransient = String(workerResult?.status || "") === "transient_error";
      const retryDecision = isTransient
        ? assessRetryExpectedROI({
            attempt: transientRetries + 1,
            maxRetries: MAX_TRANSIENT_RETRIES,
            taskKind: String((batch as any)?.taskKind || "implementation"),
            premiumUsageData: cycleRetryTelemetry.premiumUsageData,
            benchmarkGroundTruth: cycleRetryTelemetry.benchmarkGroundTruth,
            minExpectedGain: Number(config?.runtime?.retryRoiMinExpectedGain ?? 0.18),
          })
        : null;
      if (isTransient && retryDecision?.allowRetry) {
        transientRetries++;
        const cooldownMs = transientRetries * 3 * 60 * 1000;
        await appendProgress(config,
          `[CYCLE] Transient API error — retry ${transientRetries}/${MAX_TRANSIENT_RETRIES}, expected_gain=${retryDecision.expectedGain.toFixed(3)} (threshold=${retryDecision.threshold.toFixed(3)}), cooling down ${Math.round(cooldownMs / 1000)}s`
        );
        await sleep(cooldownMs);
        continue;
      }
      if (isTransient && retryDecision && !retryDecision.allowRetry) {
        await appendProgress(
          config,
          `[CYCLE] Transient API error — retry suppressed (low ROI): expected_gain=${retryDecision.expectedGain.toFixed(3)} threshold=${retryDecision.threshold.toFixed(3)} reason=${retryDecision.reason}`
        );
        emitEvent(EVENTS.POLICY_RETRY_SUPPRESSED, EVENT_DOMAIN.POLICY, `retry-suppress-${Date.now()}`, {
          role: String(batch.role || "unknown"),
          expectedGain: retryDecision.expectedGain,
          threshold: retryDecision.threshold,
          reason: retryDecision.reason,
          attempt: transientRetries + 1,
        });
      }
      break;
    }

    await persistWorkerDispatchArtifacts(config, {
      cycleId: dispatchArtifactCycleId,
      role: String(batch?.role || ""),
      phase: "complete",
      batch,
      workerResult,
      resolvedRole: dispatchTarget.roleName,
    });

    if (!isDispatchOutcomeSuccessful(workerResult)) {
      markPremiumOutcome(workerPremiumEvent.eventId, false);
      // Classify and persist the failure for use in the next cycle's optimizer input.
      try {
        const classifyResult = classifyFailure({
          workerStatus: String(workerResult?.status || "error"),
          errorMessage: String(workerResult?.summary || workerResult?.raw || "").slice(0, 500),
          blockingReasonClass: workerResult?.reasonCode || null,
          taskId: String(batch.role || ""),
        });
        if (classifyResult.ok) {
          const currentStateDir = config.paths?.stateDir || "state";
          await persistFailureClassification(currentStateDir, normalizeRoleKey(String(batch.role || "")), classifyResult.classification);
        }
      } catch { /* non-fatal — classification never blocks dispatch */ }

      if (shouldFailCloseDispatchOutcome(workerResult)) {
        await failCloseDispatchCheckpoint(config, dispatchCheckpoint, {
          reasonCode: workerResult?.reasonCode || null,
          retryClass: workerResult?.retryClass || null,
          workerStatus: workerResult?.status || null,
          batchIndex: workersDone + 1,
          totalBatches: workerBatches.length,
        });
        await appendProgress(config,
          `[CYCLE][FAIL_CLOSE] Worker batch ${workersDone + 1}/${workerBatches.length} ended with status=${workerResult?.status || "unknown"} reason_code=${workerResult?.reasonCode || "unknown"} retry_class=${workerResult?.retryClass || "none"}; checkpoint marked failed_closed (no retry)`
        );
        await safeUpdatePipelineProgress(config, "cycle_complete", `Dispatch fail-closed at batch ${workersDone + 1}/${workerBatches.length}`, {
          workersTotal: workerBatches.length,
          workersDone,
          currentWorker: batch.role,
        });
        return;
      }
      await appendProgress(config,
        `[CYCLE] Worker batch ${workersDone + 1}/${workerBatches.length} ended with status=${workerResult?.status || "unknown"}; checkpoint not advanced so it can be retried`
      );
      // Emit retry ROI signal for non-transient failures to inform next-cycle decisions.
      try {
        const nonTransientROI = assessRetryExpectedROI({
          attempt: transientRetries + 1,
          maxRetries: MAX_TRANSIENT_RETRIES,
          taskKind: String((batch as any)?.taskKind || "implementation"),
          premiumUsageData: cycleRetryTelemetry.premiumUsageData,
          benchmarkGroundTruth: cycleRetryTelemetry.benchmarkGroundTruth,
          minExpectedGain: Number(config?.runtime?.retryRoiMinExpectedGain ?? 0.18),
        });
        await appendProgress(config,
          `[RETRY_ROI] batch=${batch.role} allowRetry=${nonTransientROI.allowRetry} gain=${nonTransientROI.expectedGain.toFixed(3)} threshold=${nonTransientROI.threshold.toFixed(3)} reason=${nonTransientROI.reason}`
        );
      } catch { /* non-fatal — ROI logging must never block orchestration */ }
      return;
    }

    // Accumulate transient retries from this batch into the cycle-level counter.
    cycleTransientRetries += transientRetries;

    await promoteShadowSessionToActiveAfterCleanWave(config, {
      batch,
      workerResult,
      workerBatches,
      completedBatchIndex: workersDone,
    });

    markPremiumOutcome(workerPremiumEvent.eventId, isAnalyticsCompletedWorkerStatus(String(workerResult?.status || "unknown")));

    workersDone += 1;
    allWorkerResults.push(buildCycleWorkerResultRow(batch, workerResult));
    // replayClosureContract is reserved for future replay-gate wiring
    const replayClosureContract: { contractSatisfied?: boolean } | undefined = undefined;
    if (workerResult?.verificationEvidence || replayClosureContract?.contractSatisfied === true) {
      const batchPlansList = Array.isArray((batch as any).plans) ? (batch as any).plans : [];
      for (const plan of batchPlansList) {
        const taskText = String((plan as any)?.task || "").trim();
        if (taskText.length >= 10) {
          resolvedPlanItems.push({
            taskText,
            verificationEvidence: {
              workerContract: workerResult.verificationEvidence,
              replayClosure: replayClosureContract,
              doneWorkerWithVerificationReportEvidence: workerResult?.dispatchContract?.doneWorkerWithVerificationReportEvidence === true,
              doneWorkerWithCleanTreeStatusEvidence: workerResult?.dispatchContract?.doneWorkerWithCleanTreeStatusEvidence === true,
              dispatchBlockReason: workerResult?.dispatchBlockReason || null,
            },
          });
        }
      }

      // ── Mark synthesis topics consumed by completed plans ──────────────────
      // When a plan with synthesis_sources completes, mark those topics as
      // "completed" in topic memory so the scout gate can detect full consumption.
      try {
        const stateDir = config.paths?.stateDir || "state";
        const batchPlans = Array.isArray((batch as any).plans) ? (batch as any).plans : [];
        const completedTopicKeys: string[] = [];
        for (const plan of batchPlans) {
          const sources = Array.isArray((plan as any).synthesis_sources) ? (plan as any).synthesis_sources as string[] : [];
          for (const s of sources) {
            completedTopicKeys.push(prometheusTopicKey(s));
          }
        }
        if (completedTopicKeys.length > 0) {
          const topicMemory = await loadTopicMemory(stateDir);
          const existingKeys = Object.keys(topicMemory.topics);
          const now = new Date().toISOString();
          let changed = false;
          for (const rawKey of completedTopicKeys) {
            const key = findCanonicalTopicKey(rawKey, existingKeys);
            if (topicMemory.topics[key] && topicMemory.topics[key].status !== "completed") {
              topicMemory.topics[key].status = "completed";
              topicMemory.topics[key].lastUpdatedAt = now;
              topicMemory.topics[key].completedSummary =
                topicMemory.topics[key].completedSummary ||
                `Completed via worker plan execution (batch role=${batch.role})`;
              topicMemory.topics[key].knowledgeFragments = [];
              changed = true;
            }
          }
          if (changed) {
            await saveTopicMemory(stateDir, topicMemory);
            await appendProgress(config,
              `[TOPIC_MEMORY] Marked ${completedTopicKeys.length} synthesis topic(s) consumed by ${batch.role} batch`
            );
          }
        }
      } catch {
        // Non-fatal — topic tracking never blocks dispatch
      }
    }

    const completedRole = String(workerResult?.roleName || dispatchTarget.roleName || batch.role || "unknown");
    const logicalRoleText = completedRole === String(batch.role || "") ? "" : `  logicalRole=${String(batch.role || "unknown")}`;
    await appendProgress(config, `[WORKER_BATCH] ✓ BATCH ${workersDone}/${workerBatches.length} DONE  role=${completedRole}${logicalRoleText}  status=${workerResult?.status || "unknown"}  total_req=${_cycleRequests}`);

    // Record the timestamp when this batch completed — used as the idle-gap start
    // when the next wave boundary crossing is detected.
    waveBoundaryStartMs = Date.now();

    // ── Token calibration: record estimated vs proxy-actual tokens ──────────
    // Use worker response length as a proxy for actual token consumption.
    // Real provider-level token counts can replace this when available.
    try {
      const rawLen = String(workerResult?.raw || "").length;
      if (rawLen > 0 && Number.isFinite((batch as any).estimatedTokens) && (batch as any).estimatedTokens > 0) {
        const { recordCalibrationSample } = await import("./token_calibration.js");
        // Proxy: response chars / 4 + estimated input ≈ total session tokens
        const proxyActual = Math.ceil(rawLen / 4) + (batch as any).estimatedTokens;
        await recordCalibrationSample(
          config,
          String(batch.role || "evolution-worker"),
          (batch as any).estimatedTokens,
          proxyActual
        );
      }
    } catch {
      // Calibration is advisory — never block dispatch
    }

    const dispatchCheckpointUpdate = await updateDispatchCheckpointProgress(config, dispatchCheckpoint, workersDone);
    if (dispatchCheckpointUpdate.rolledOver && dispatchCheckpointUpdate.activeSegment && dispatchCheckpointUpdate.previousSegment) {
      await appendProgress(
        config,
        `[RUN_SEGMENT] rollover complete: segment ${String((dispatchCheckpointUpdate.previousSegment as any).segmentIndex)} -> ${String((dispatchCheckpointUpdate.activeSegment as any).segmentIndex)}`
      );
      await safeUpdatePipelineProgress(config, "workers_running", `Run segment rollover to ${String((dispatchCheckpointUpdate.activeSegment as any).segmentIndex)}`, {
        workersTotal: workerBatches.length,
        workersDone,
        currentWorker: batch.role,
        runSegment: dispatchCheckpointUpdate.activeSegment,
        runSegmentRollover: dispatchCheckpointUpdate.previousSegment,
        runSegmentHistorySize: dispatchCheckpointUpdate.historySize,
      });
    }
    await waitForWorkersToFinish(config);

    const cycleCooldown = resolveInterBatchCooldownDecision(config, {
      remainingBatches: workerBatches.length - workersDone,
      workerStatus: String(workerResult?.status || ""),
      transientRetries,
      dispatchBlockReason: String(workerResult?.dispatchBlockReason || workerResult?.dispatchContract?.dispatchBlockReason || ""),
    });
    if (cycleCooldown.cooldownMs > 0) {
      await appendProgress(config, `[CYCLE] Inter-batch cooldown ${Math.round(cycleCooldown.cooldownMs / 1000)}s reason=${cycleCooldown.reason}`);
      await sleep(cycleCooldown.cooldownMs);
    }
  }

  await completeDispatchCheckpoint(config, dispatchCheckpoint);

  await safeUpdatePipelineProgress(config, "workers_finishing", "All workers finishing up", {
    workersTotal: workerBatches.length,
    workersDone: workerBatches.length
  });

  await appendProgress(config, "[CYCLE] ── All workers dispatched — cycle complete ──");
  await appendProgress(config, `[CYCLE DONE] ════════ ${_cycleRequests} premium requests | ${workerBatches.length} batch(es) | elapsed=${Math.round((Date.now() - new Date(cycleStartedAt).getTime()) / 1000)}s ════════`);
  await appendProgress(config, `[RUN] RUN DONE — ${workerBatches.length} batch(es) completed`);
  await safeUpdatePipelineProgress(config, "cycle_complete", `Cycle complete — ${workerBatches.length} worker batch(es) processed`, {
    workersTotal: workerBatches.length,
    workersDone: workerBatches.length
  });

  // ── Janus outcome ledger — per-cycle strategy-to-outcome closure ────────────
  // Records directive hash, plan/execution counts, budget delta, and CI outcome
  // so that Janus can observe strategy effectiveness across cycles.
  try {
    const successfulWorkerCount = allWorkerResults.filter(r => r.status === "done" || r.status === "success").length;
    const janusOutcome = buildJanusDecisionOutcome({
      directiveHash: String((janusDecision as any)?.githubStateHash || ""),
      plansGenerated: prometheusAnalysis?.plans?.length ?? 0,
      plansExecuted: successfulWorkerCount,
      budgetDelta: typeof (optimizerUsage as any)?.totalBudgetUsed === "number"
        ? (optimizerUsage as any).totalBudgetUsed
        : 0,
      ciOutcome: String((janusDecision as any)?.githubCiContext?.latestMainCi?.conclusion || "unknown"),
    });
    await appendJanusOutcomeLedger(stateDir, janusOutcome);
    await appendProgress(config,
      `[JANUS_LEDGER] Outcome recorded: plansGenerated=${janusOutcome.plansGenerated} plansExecuted=${janusOutcome.plansExecuted} ciOutcome=${janusOutcome.ciOutcome}`
    );
  } catch (ledgerErr) {
    warn(`[orchestrator] janus outcome ledger emit failed (non-fatal): ${String(ledgerErr?.message || ledgerErr)}`);
  }

  // ── SLO check: compute and persist cycle-level SLO metrics ─────────────────
  // cycle_id = pipeline_progress.startedAt (the canonical cycle identifier).
  // All latency inputs are read from pipeline_progress.json.stageTimestamps.
  // This runs after cycle_complete so all stage timestamps are present.
  try {
    const progress = await readPipelineProgress(config);
    const cycleRecord = computeCycleSLOs(
      config,
      progress.stageTimestamps || {},
      progress.startedAt || null,
      progress.completedAt || new Date().toISOString()
    );
    await persistSloMetrics(config, cycleRecord);

    if (cycleRecord.sloBreaches.length > 0) {
      const breachSummary = cycleRecord.sloBreaches
        .map(b => `${b.metric}=${b.actual}ms threshold=${b.threshold}ms severity=${b.severity}`)
        .join("; ");
      await appendProgress(config, `[SLO] Cycle SLO breaches detected: ${breachSummary}`);

      for (const breach of cycleRecord.sloBreaches) {
        await appendAlert(config, {
          severity: breach.severity === "critical" ? ALERT_SEVERITY.CRITICAL : ALERT_SEVERITY.HIGH,
          source: "slo_checker",
          title: `SLO breach: ${breach.metric}`,
          message: `actual=${breach.actual}ms threshold=${breach.threshold}ms cycleId=${cycleRecord.cycleId || "unknown"} reason=${breach.reason}`
        });
      }

      // Write degraded health when SLO breaches are detected (AC3/AC14 — must call writeOrchestratorHealth, not just appendAlert)
      if (config?.slo?.degradedOnBreach !== false) {
        await writeOrchestratorHealth(stateDir, ORCHESTRATOR_STATUS.DEGRADED, "slo_breach",
          cycleRecord.sloBreaches.map(b => `${b.metric}: actual=${b.actual}ms threshold=${b.threshold}ms severity=${b.severity}`)
        );
      }
    } else {
      await appendProgress(config, `[SLO] Cycle SLO check passed — all metrics within thresholds (cycleId=${cycleRecord.cycleId || "unknown"})`);
    }
  } catch (err) {
    // SLO check is advisory — never block orchestration
    warn(`[orchestrator] SLO check failed (non-fatal): ${String(err?.message || err)}`);
    await appendProgress(config, `[SLO] SLO check failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Premium efficiency variants: computed once, shared by analytics and band monitor ──
  // Raw variant (backward-compat): fraction of settled premium events that succeeded at the API level.
  // Execution-adjusted (backward-compat): replaces worker-slot success signals with verified-done evidence.
  // rawPremiumEfficiency (new): verifiedDoneWorkers / allCyclePremiumRequests — output-quality focused.
  // executionAdjustedPremiumEfficiency (new): same numerator, denominator excludes mandatory leadership requests.
  // All are computed here (before analytics) so both channels see identical values.
  const _LEADERSHIP_AGENTS = new Set(["janus", "prometheus", "athena", "research-scout"]);
  const _premiumSettled = premiumEvents.filter((row) => row.success !== null);
  const _premiumSuccessful = _premiumSettled.filter((row) => row.success === true).length;
  const _premiumEfficiencyRaw: number | null = _premiumSettled.length > 0
    ? Math.max(0, Math.min(1, _premiumSuccessful / _premiumSettled.length))
    : null;
  const _verifiedDoneWorkers = allWorkerResults.filter((row: any) => {
    const status = String(row?.status || "").toLowerCase();
    if (status !== "done" && status !== "success") return false;
    // Exclude workers that violated the closure boundary (missing expectedOutcome/actualOutcome/deviation)
    if (row?.closureBoundaryViolation === true) return false;
    const contractEvidence = row?.dispatchContract?.doneWorkerWithVerificationReportEvidence;
    if (contractEvidence === true) return true;
    return hasVerificationReportEvidence(String(row?.verificationEvidence || row?.fullOutput || ""));
  }).length;
  const _leadershipSuccesses = _premiumSettled.filter(
    (row) => _LEADERSHIP_AGENTS.has(row.agent) && row.success === true,
  ).length;
  const _premiumEfficiencyAdjusted: number | null = _premiumSettled.length > 0
    ? Math.max(0, Math.min(1, (_leadershipSuccesses + _verifiedDoneWorkers) / _premiumSettled.length))
    : null;
  // New explicit metrics — output-quality-focused, not API-success-focused.
  const _allCyclePremiumRequests = premiumEvents.length;
  const _leadershipRequests = premiumEvents.filter((row) => _LEADERSHIP_AGENTS.has(row.agent)).length;
  const _rawPremiumEfficiency: number | null = _allCyclePremiumRequests > 0
    ? Math.max(0, Math.min(1, _verifiedDoneWorkers / _allCyclePremiumRequests))
    : null;
  const _workerOnlyDenominator = _allCyclePremiumRequests - _leadershipRequests;
  const _executionAdjustedPremiumEfficiency: number | null = _workerOnlyDenominator > 0
    ? Math.max(0, Math.min(1, _verifiedDoneWorkers / _workerOnlyDenominator))
    : null;

  // ── Cycle analytics: compute and persist KPIs, confidence, and causal links ─
  // Advisory — never blocks orchestration. Runs after SLO so sloRecord is available.
  // Risk note (Athena AC19): per-cycle file I/O on hot path, wrapped in try/catch.
  try {
    const progressForAnalytics = await readPipelineProgress(config);
    // Re-read the SLO record that was just persisted to get the computed values.
    // Import here to avoid a circular reference — slo_checker has no dep on cycle_analytics.
    const { readSloMetrics } = await import("./slo_checker.js");
    const sloState = await readSloMetrics(config);
    const sloRecord = sloState?.lastCycle ?? null;

    // ── Tier counts: classify dispatched plans by riskLevel ──────────────────
    // T1 = routine (riskLevel absent or "low"), T2 = medium, T3 = architectural ("high"|"critical").
    // Computed from the plans array after all gates so counts reflect actual dispatch distribution.
    const tierCountsForAnalytics = Array.isArray(plans) && plans.length > 0
      ? (() => {
          let T1 = 0; let T2 = 0; let T3 = 0;
          for (const p of plans as any[]) {
            const risk = String(p?.riskLevel || "").toLowerCase();
            if (risk === "high" || risk === "critical") T3 += 1;
            else if (risk === "medium") T2 += 1;
            else T1 += 1;
          }
          return { T1, T2, T3 };
        })()
      : null;

    // ── Fast-path counts: Athena auto-approve vs full AI review ──────────────
    // planReview.autoApproved=true means all plans cleared the deterministic gate.
    // Counts are plan-level: all funnelApprovedCount plans are either all auto-approved or all full-reviewed.
    // autoApproveReasonCode and gateBlockRiskAtApproval are propagated so cycle_analytics
    // can reflect real dispatch feasibility (gateBlockRiskAtApproval was previously always null).
    const fastPathCountsForAnalytics = typeof funnelApprovedCount === "number" && funnelApprovedCount >= 0
      ? (planReview?.autoApproved === true
          ? {
              athenaAutoApproved: funnelApprovedCount,
              athenaFullReview: 0,
              autoApproveReasonCode: (planReview?.autoApproveReason as any)?.code ?? null,
              gateBlockRiskAtApproval: (planReview as any)?.gateBlockRiskAtApproval ?? null,
            }
          : {
              athenaAutoApproved: 0,
              athenaFullReview: funnelApprovedCount,
              autoApproveReasonCode: null,
              gateBlockRiskAtApproval: (planReview as any)?.gateBlockRiskAtApproval ?? null,
            })
      : null;

    // ── Violation / reroute feedback for planning priors ────────────────────
    // Aggregate contract-violation and reroute signals from this cycle's worker
    // results so Prometheus can read them from cycle_analytics.json next cycle.
    const cycleContractViolationCounters = {
      closureBoundaryViolations: allWorkerResults.filter(r => r.closureBoundaryViolation === true).length,
      hookTelemetryViolations:   allWorkerResults.filter(r =>
        typeof r.dispatchBlockReason === "string" &&
        r.dispatchBlockReason.startsWith("hook_telemetry_inconsistent")
      ).length,
      dispatchBlockedWorkers: allWorkerResults.filter(r => r.dispatchBlockReason != null).length,
    };
    const cycleRerouteReasons = Array.isArray(workerBatches) && workerBatches.length > 0
      ? ((workerBatches[0] as any)?.specialistRerouteReasons ?? [])
      : [];
    const cycleRerouteMetrics = {
      specialistRerouteCount: Array.isArray(cycleRerouteReasons) ? cycleRerouteReasons.length : 0,
      reroutedRoles: Array.isArray(cycleRerouteReasons)
        ? cycleRerouteReasons.map((r: any) => String(r?.role || ""))
        : [],
      fallbackCollapseCount: Number((workerBatches?.[0] as any)?.specialistUtilizationTarget?.fallbackCollapseCount || 0),
      fallbackCollapseRate: Number((workerBatches?.[0] as any)?.specialistUtilizationTarget?.fallbackCollapseRate || 0),
      collapsedReservedLanes: Array.isArray((workerBatches?.[0] as any)?.specialistUtilizationTarget?.collapsedReservedLanes)
        ? (workerBatches[0] as any).specialistUtilizationTarget.collapsedReservedLanes.map((value: unknown) => String(value || ""))
        : [],
    };
    const workerTopology = capabilityPoolResult?.specializationUtilization
      ? {
          ...capabilityPoolResult.specializationUtilization,
          effectiveLaneCount: Number(capabilityPoolResult.specializationUtilization.effectiveActiveLaneCount || capabilityPoolResult.activeLaneCount || 0),
          nominalLaneCount: Number(capabilityPoolResult.specializationUtilization.nominalActiveLaneCount || capabilityPoolResult.nominalActiveLaneCount || 0),
        }
      : ((workerBatches?.[0] as any)?.specialistUtilizationTarget
          ? { ...(workerBatches[0] as any).specialistUtilizationTarget }
          : null);

    const analyticsRecord = computeCycleAnalytics(config, {
      sloRecord,
      pipelineProgress: progressForAnalytics,
      workerResults: allWorkerResults.length > 0 ? allWorkerResults : null,
      planCount: Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : null,
      phase: CYCLE_PHASE.COMPLETED,
      prometheusAnalysis,
      athenaPlanReview: planReview,
      parserBaselineRecovery: baselineRecoveryRecord ?? null,
      optimizerUsage,
      tierCounts: tierCountsForAnalytics,
      fastPathCounts: fastPathCountsForAnalytics,
      funnelCounts: {
        generated:  Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : null,
        approved:   funnelApprovedCount,
        dispatched: funnelDispatchedCount,
        completed:  allWorkerResults.filter(r => isAnalyticsCompletedWorkerStatus(r.status)).length,
      },
      premiumUsageLog: await readJson(path.join(stateDir, "premium_usage_log.json"), []),
      routeRoiLedger: await loadRouteROILedger(config),
      lineageLog: ((await readJson(path.join(stateDir, "lineage_graph.json"), { entries: [] }))?.entries) ?? [],
      premiumEfficiencyRaw: _premiumEfficiencyRaw,
      premiumEfficiencyAdjusted: _premiumEfficiencyAdjusted,
      rawPremiumEfficiency: _rawPremiumEfficiency,
      executionAdjustedPremiumEfficiency: _executionAdjustedPremiumEfficiency,
      memoryHitLog: await readJson(path.join(stateDir, "memory_hit_log.json"), []),
      promptCacheTelemetry: await readPromptCacheTelemetry(config),
      retryCount:                 cycleTransientRetries,
      contractViolationCounters:  cycleContractViolationCounters,
      rerouteMetrics:             cycleRerouteMetrics,
      assignedLaneDistribution: capabilityPoolResult?.laneCounts ?? null,
      workerTopology,
      assignedRoleDistribution: capabilityPoolResult?.assignments
        ? capabilityPoolResult.assignments.reduce((acc: Record<string, number>, row: any) => {
            const role = String(row?.selection?.role || "unknown");
            acc[role] = (acc[role] || 0) + 1;
            return acc;
          }, {})
        : null,
    });
    await persistCycleAnalytics(config, analyticsRecord);

    // ── Health channel: degrade signals only, separate from KPI semantics ──
    // cycle_health.json changes only when the system genuinely degrades,
    // not when metric definitions change (dual-channel contract).
    const coupledAlerts = detectCoupledAlerts(sloRecord, analyticsRecord.funnel?.completionRate ?? null);
    const healthRecord = computeCycleHealth(analyticsRecord, [], coupledAlerts);
    pendingCycleHealthRecord = healthRecord;

    await appendProgress(config, `[ANALYTICS] Cycle analytics written — confidence=${analyticsRecord.confidence.level} sloStatus=${analyticsRecord.kpis.sloStatus} phase=${analyticsRecord.phase} health=${healthRecord.healthScore}`);
  } catch (err) {
    // Analytics are advisory — never block orchestration
    warn(`[orchestrator] Cycle analytics failed (non-fatal): ${String(err?.message || err)}`);
    await appendProgress(config, `[ANALYTICS] Cycle analytics failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Intervention judge: evaluate cycle outcomes and decide promote/hold/rework/rollback ──
  // Mandatory per cycle — produces state/intervention_judge_report.json.
  // Deterministic decision layer runs first; AI (intervention-reviewer) is consulted
  // only for ambiguous cases. Hard guardrail breaches override AI recommendations.
  // Advisory — never blocks orchestration.
  try {
    if (config.runtime?.interventionJudgeEnabled === false) {
      await appendProgress(config, "[INTERVENTION_JUDGE] Skipped — interventionJudgeEnabled=false");
    } else {
      const analyticsForJudge = pendingCycleHealthRecord
        ? await readJson(path.join(stateDir, "cycle_analytics.json"), null)
        : null;
      const latestAnalytics = analyticsForJudge?.lastCycle ?? analyticsForJudge ?? null;
      const interventionJudgeReport = await evaluateInterventionsForCycle(config, {
        cycleId: String((await readPipelineProgress(config))?.startedAt || cycleStartedAt),
        plans: Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans : [],
        analyticsRecord: latestAnalytics,
        healthRecord: pendingCycleHealthRecord,
        workerResults: allWorkerResults.map(r => ({ roleName: r.roleName, status: r.status })),
        requestBudget: prometheusAnalysis?.requestBudget ?? null,
      });

      const decisions = Array.isArray(interventionJudgeReport?.decisions) ? interventionJudgeReport.decisions : [];
      const decisionSummary = decisions.map((d: any) => `${d.interventionId}=${d.decision}`).join(", ");
      await appendProgress(config, `[INTERVENTION_JUDGE] Cycle evaluation complete — ${decisions.length} decision(s): ${decisionSummary || "none"}`);

      const plansForLineage = Array.isArray(plans) ? plans : [];
      const planByInterventionId = new Map<string, any>();
      for (let i = 0; i < plansForLineage.length; i++) {
        const plan = plansForLineage[i];
        const interventionId = String(plan?.intervention_id || plan?.id || plan?.task_id || `plan-${i + 1}`);
        if (!planByInterventionId.has(interventionId)) {
          planByInterventionId.set(interventionId, plan);
        }
      }

      let policyImpactByInterventionId: Record<string, { policyId: string; decayedEffectiveness: number; inactiveCycles: number }> = {};
      try {
        const learnedPoliciesRaw = await readJson(path.join(stateDir, "learned_policies.json"), []);
        const learnedPolicies = Array.isArray(learnedPoliciesRaw) ? learnedPoliciesRaw : [];
        if (learnedPolicies.length > 0 && plansForLineage.length > 0) {
          policyImpactByInterventionId = buildPolicyImpactByInterventionId(plansForLineage, learnedPolicies);
        }
      } catch {
        policyImpactByInterventionId = {};
      }

      // Action executor: convert judge decisions into deterministic runtime actions.
      // Promote/Hold/Rework are ledgered; Rollback optionally triggers rollback engine.
      const policyLedgerPath = path.join(stateDir, "intervention_policy_ledger.json");
      const policyLedger = await readJson(policyLedgerPath, {
        schemaVersion: 1,
        entries: [],
        updatedAt: null,
      });
      const existingEntries = Array.isArray(policyLedger?.entries) ? policyLedger.entries : [];
      const actionCounters = { promote: 0, hold: 0, rework: 0, rollback: 0, rollbackExecuted: 0 };
      const closureLedgerEntries: any[] = [];
      const retirementEvidenceEntries: any[] = [];
      const policyClosureEntries: any[] = [];
      const cycleClosureTimestamp = new Date().toISOString();

      for (const d of decisions as any[]) {
        const finalDecision = String(d?.decision || "hold").toLowerCase();
        const interventionId = String(d?.interventionId || "unknown");
        const linkedPlan = planByInterventionId.get(interventionId) || null;
        const policyImpact = policyImpactByInterventionId[interventionId];
        const policyId = String(linkedPlan?.policyId || policyImpact?.policyId || "") || null;
        const noSignalOutcome = isExplicitNoSignalJudgeDecision(d);
        const outcomeScore = mapJudgeDecisionToOutcomeScore(finalDecision, noSignalOutcome);
        const closureMode = noSignalOutcome
          ? "no_signal"
          : finalDecision === "promote"
            ? "policy_closed"
            : "observed";
        if (finalDecision === "promote") actionCounters.promote += 1;
        else if (finalDecision === "rework") actionCounters.rework += 1;
        else if (finalDecision === "rollback") actionCounters.rollback += 1;
        else actionCounters.hold += 1;

        existingEntries.push({
          recordedAt: cycleClosureTimestamp,
          cycleId: String(interventionJudgeReport?.cycleId || cycleStartedAt),
          interventionId,
          decision: finalDecision,
          reason: String(d?.reason || "unknown"),
          decisionMode: String(d?.decisionMode || "unknown"),
          aiUsed: d?.aiReviewStatus === "ok",
          aiConfidence: typeof d?.aiConfidence === "number" ? d.aiConfidence : null,
          noSignalOutcome,
          policyId,
        });

        closureLedgerEntries.push({
          interventionId,
          lineageId: String(linkedPlan?._chainId || linkedPlan?.lineageId || linkedPlan?.task_id || "") || null,
          policyId,
          cycleId: String(interventionJudgeReport?.cycleId || cycleStartedAt),
          role: String(linkedPlan?.role || d?.role || "evolution-worker"),
          selectedAt: cycleClosureTimestamp,
          status: `closed:${finalDecision}`,
          noSignalOutcome,
          decisionReason: String(d?.reason || "unknown"),
          recordedAt: cycleClosureTimestamp,
        });

        retirementEvidenceEntries.push({
          recordedAt: cycleClosureTimestamp,
          cycleId: String(interventionJudgeReport?.cycleId || cycleStartedAt),
          interventionId,
          lineageId: String(linkedPlan?._chainId || linkedPlan?.lineageId || linkedPlan?.task_id || "") || null,
          policyId,
          role: String(linkedPlan?.role || d?.role || "evolution-worker"),
          decision: finalDecision,
          decisionMode: String(d?.decisionMode || "unknown"),
          closureMode,
          noSignalOutcome,
          reason: String(d?.reason || "unknown"),
          outcomeScore,
          aiConfidence: typeof d?.aiConfidence === "number" ? d.aiConfidence : null,
          resolvedPolicy: finalDecision === "promote" && Boolean(policyId),
        });

        if (finalDecision === "promote" && policyId) {
          policyClosureEntries.push({
            policyId,
            resolvedAt: cycleClosureTimestamp,
            resolvedBy: `intervention_judge:${interventionId}`,
            evidence: `intervention_promoted:${String(d?.reason || "unknown")}`,
            cycleId: String(interventionJudgeReport?.cycleId || cycleStartedAt),
          });
        }

        if (finalDecision === "rollback" && config.runtime?.interventionJudgeExecuteRollback === true) {
          const rollbackResult = await executeRollback({
            level: ROLLBACK_LEVEL.CONFIG_ONLY,
            trigger: ROLLBACK_TRIGGER.CANARY_ROLLBACK,
            evidence: {
              controlValue: (d?.rollbackControlValue && typeof d.rollbackControlValue === "object") ? d.rollbackControlValue : {},
              reasonCode: "INTERVENTION_JUDGE_ROLLBACK",
              interventionId: String(d?.interventionId || "unknown"),
            },
            config,
            stateDir,
          });
          if (rollbackResult?.ok) {
            actionCounters.rollbackExecuted += 1;
          }
          await appendProgress(config, `[INTERVENTION_JUDGE] Rollback decision executed for ${String(d?.interventionId || "unknown")} ok=${String(Boolean(rollbackResult?.ok))} reason=${String(rollbackResult?.reason || "none")}`);
        }
      }

      if (existingEntries.length > 400) {
        existingEntries.splice(0, existingEntries.length - 400);
      }
      await writeJson(policyLedgerPath, {
        schemaVersion: 1,
        entries: existingEntries,
        updatedAt: new Date().toISOString(),
      });

      if (closureLedgerEntries.length > 0) {
        await appendInterventionApplicationEntries(config, closureLedgerEntries).catch(() => {});
      }
      if (retirementEvidenceEntries.length > 0) {
        await appendInterventionRetirementEvidence(config, retirementEvidenceEntries).catch(() => {});
      }
      if (policyClosureEntries.length > 0) {
        for (const entry of policyClosureEntries) {
          await appendPolicyClosureEvidence(config, entry).catch(() => {});
        }
      }

      await appendProgress(
        config,
        `[INTERVENTION_EXECUTOR] promote=${actionCounters.promote} hold=${actionCounters.hold} rework=${actionCounters.rework} rollback=${actionCounters.rollback} rollbackExecuted=${actionCounters.rollbackExecuted}`
      );
      await appendProgress(
        config,
        `[INTERVENTION_LINEAGE] closures=${closureLedgerEntries.length} retirementEvidence=${retirementEvidenceEntries.length} noSignal=${retirementEvidenceEntries.filter((entry) => entry.noSignalOutcome).length} policyClosures=${policyClosureEntries.length}`
      );
    }
  } catch (err) {
    // Advisory — never blocks orchestration
    warn(`[orchestrator] Intervention judge failed (non-fatal): ${String(err?.message || err)}`);
    await appendProgress(config, `[INTERVENTION_JUDGE] Evaluation failed (non-fatal): ${String(err?.message || err)}`);
  }

  try {
    const retentionSummary = await enforceStateRetention(config);
    if (retentionSummary.totalTrimmed > 0) {
      await appendProgress(
        config,
        `[RETENTION] Trimmed ${retentionSummary.totalTrimmed} stale record(s) across ${retentionSummary.touchedFiles.join(", ")}`
      );
    }
  } catch (retentionErr) {
    warn(`[orchestrator] State retention enforcement failed (non-fatal): ${String((retentionErr as Error)?.message || retentionErr)}`);
  }

  // ── Autonomy band evaluation: composite score + state machine ──
  // Advisory — never blocks orchestration. Shadow-mode by default.
  try {
    if (config.runtime?.autonomyBand?.enabled !== false) {
      const { readCycleAnalytics, computeResearchCapacityGain } = await import("./cycle_analytics.js");
      const { getRecentCapacity, computeTrend } = await import("./capacity_scoreboard.js");
      const analytics = await readCycleAnalytics(config);
      const recentCap = await getRecentCapacity(config, 10);
      const capTrend = computeTrend(recentCap, "parserConfidence");
      const catastropheState = await readJson(path.join(stateDir, "catastrophe_state.json"), null);
      const benchmarkGroundTruth = await readJson(path.join(stateDir, "benchmark_ground_truth.json"), null);

      const totalWorkers = allWorkerResults?.length ?? 0;
      const completedWorkers = allWorkerResults?.filter((w: any) => isDispatchOutcomeSuccessful(w)).length ?? 0;
      const completionRate = totalWorkers > 0 ? completedWorkers / totalWorkers : null;
      const crashCount = allWorkerResults?.filter((w: any) => w.status === "crashed" || w.status === "error").length ?? 0;
      const crashRate = totalWorkers > 0 ? crashCount / totalWorkers : null;

      let benchmarkEntries = Array.isArray(benchmarkGroundTruth?.entries) ? benchmarkGroundTruth.entries : [];
      if (benchmarkEntries.length === 0) {
        const synthesisSnapshot = await readJson(path.join(stateDir, "research_synthesis.json"), null);
        const synthesisTopics = Array.isArray(synthesisSnapshot?.topics) ? synthesisSnapshot.topics : [];
        if (synthesisTopics.length > 0) {
          await persistBenchmarkEntry(config, String(cycleStartedAt || new Date().toISOString()), synthesisTopics);
          const refreshedBenchmarkGroundTruth = await readJson(path.join(stateDir, "benchmark_ground_truth.json"), null);
          benchmarkEntries = Array.isArray(refreshedBenchmarkGroundTruth?.entries) ? refreshedBenchmarkGroundTruth.entries : [];
          await appendProgress(config, `[AUTONOMY_BAND] benchmark entries seeded from synthesis - entries=${benchmarkEntries.length}`);
        }
      }
      const cycleOutcomeStatus = (() => {
        if (totalWorkers === 0) return CYCLE_OUTCOME_STATUS.NO_PLANS;
        const baseStatus = completedWorkers >= totalWorkers && crashCount === 0
          ? CYCLE_OUTCOME_STATUS.SUCCESS
          : (completedWorkers > 0 ? CYCLE_OUTCOME_STATUS.PARTIAL : CYCLE_OUTCOME_STATUS.FAILED);
        // CI debt gate: if CI fastlane was required and no ci-fix worker completed,
        // override to CI_DEBT_UNRESOLVED to prevent the cycle from closing as healthy.
        if ((janusDecision as any)?.ciFastlaneRequired === true) {
          const ciEvidence = computeCiRemediationStatus(allWorkerResults ?? [], []);
          if (!ciEvidence.satisfied) {
            void appendProgress(config,
              `[ORCHESTRATOR] CI_DEBT_UNRESOLVED — ciFastlaneRequired but completedCiFixWorkers=${ciEvidence.completedCiFixWorkers}; cycle cannot close as healthy`
            );
            return CYCLE_OUTCOME_STATUS.CI_DEBT_UNRESOLVED;
          }
        }
        return baseStatus;
      })();
      const autoResolution = autoResolveBenchmarkRecommendations(benchmarkEntries, {
        verifiedDoneWorkers: _verifiedDoneWorkers,
        workerBatches,
        workerResults: allWorkerResults ?? [],
        atIso: new Date().toISOString(),
      });
      benchmarkEntries = autoResolution.entries;
      if (autoResolution.resolvedCount > 0) {
        await appendProgress(
          config,
          `[AUTONOMY_BAND] benchmark recommendations auto-resolved=${autoResolution.resolvedCount} mode=${autoResolution.usedFallback ? "fallback_verified_done" : "linked_topic_match"}`,
        );
      }

      const scoredRecommendations = evaluateBenchmarkGroundTruth(benchmarkEntries, {
        status: cycleOutcomeStatus,
        tasksCompleted: completedWorkers,
        tasksDispatched: totalWorkers,
      });

      if (benchmarkEntries.length > 0 && scoredRecommendations.length > 0) {
        benchmarkEntries[0] = {
          ...benchmarkEntries[0],
          recommendations: scoredRecommendations,
          evaluatedAt: new Date().toISOString(),
        };
        await writeJson(path.join(stateDir, "benchmark_ground_truth.json"), {
          schemaVersion: benchmarkGroundTruth?.schemaVersion || 1,
          updatedAt: new Date().toISOString(),
          entries: benchmarkEntries,
        });
      } else {
        await appendProgress(
          config,
          `[AUTONOMY_BAND] benchmark scoring skipped - entries=${benchmarkEntries.length} recommendations_scored=${scoredRecommendations.length}`,
        );
      }

      const benchmarkGainResult = computeResearchCapacityGain(benchmarkEntries, 5);

      const athenaRejectRate = planReview?.approved === true
        ? 0
        : (planReview?.approved === false
          ? 1
          : (typeof analytics?.athenaRejectRate === "number" ? analytics.athenaRejectRate : null));
      const parserFallbackRate = typeof prometheusAnalysis?.parserContextPenalty === "number"
        ? Math.max(0, Math.min(1, prometheusAnalysis.parserContextPenalty))
        : null;
      const contractFailRate = typeof prometheusAnalysis?._planContractPassRate === "number"
        ? Math.max(0, Math.min(1, 1 - prometheusAnalysis._planContractPassRate))
        : null;

      // Reuse pre-computed premium efficiency variants (computed before analytics call).
      const premiumEfficiency = _premiumEfficiencyRaw;
      const premiumEfficiencyAdjusted = _premiumEfficiencyAdjusted;
      const verifiedDoneWorkers = _verifiedDoneWorkers;

      await appendProgress(
        config,
        `[AUTONOMY_BAND] premium_efficiency_inputs settled=${_premiumSettled.length} success=${_premiumSuccessful} verifiedWorkerDone=${verifiedDoneWorkers} raw=${premiumEfficiency?.toFixed(3) ?? "N/A"} adjusted=${premiumEfficiencyAdjusted?.toFixed(3) ?? "N/A"} rawNew=${_rawPremiumEfficiency?.toFixed(3) ?? "N/A"} execAdj=${_executionAdjustedPremiumEfficiency?.toFixed(3) ?? "N/A"}`,
      );

      const hardGuardrailBreach = Array.isArray(catastropheState?.lastDetections)
        && catastropheState.lastDetections.length > 0;

      const sample: CycleSample = {
        cycleId: `cycle-${Date.now()}`,
        recordedAt: new Date().toISOString(),
        phase: String(analytics?.phase || CYCLE_PHASE.COMPLETED),
        completionRate,
        premiumEfficiency,
        premiumEfficiencyAdjusted,
        rawPremiumEfficiency: _rawPremiumEfficiency,
        executionAdjustedPremiumEfficiency: _executionAdjustedPremiumEfficiency,
        athenaRejectRate,
        parserFallbackRate,
        contractFailRate,
        benchmarkGain: benchmarkGainResult.capacityGain,
        crashCount,
        crashRate,
        hardGuardrailBreach,
        capacityTrend: capTrend,
      };

      const bandResult = await evaluateAutonomyBand(config, sample);
      await appendProgress(
        config,
        `[AUTONOMY_BAND] state=${bandResult.state} phase=${bandResult.executionPhase} composite=${bandResult.compositeScore?.toFixed(3) ?? "N/A"} shadow=${config.runtime?.autonomyBand?.shadowMode !== false}`,
      );
    }
  } catch (err: any) {
    warn(`[orchestrator] Autonomy band evaluation failed (non-fatal): ${String(err?.message || err)}`);
    await appendProgress(config, `[AUTONOMY_BAND] Evaluation failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Catastrophe detection: scan for systemic failure patterns each cycle ──
  // Advisory — never blocks orchestration. Failure sets explicit status=degraded.
  // Risk level: HIGH — reads orchestration state directly.
  try {
    // Build cycle data from available in-cycle metrics
    const now = Date.now();
    const janusDirectivePath    = path.join(stateDir, "janus_directive.json");
    const prometheusAnalysisPath = path.join(stateDir, "prometheus_analysis.json");

    const janusDirectiveRaw     = await readJson(janusDirectivePath, null);
    const prometheusAnalysisRaw = await readJson(prometheusAnalysisPath, null);

    const janusDirectiveAgeMs = janusDirectiveRaw?.decidedAt
      ? now - new Date(janusDirectiveRaw.decidedAt).getTime()
      : 0;
    const prometheusAnalysisAgeMs = prometheusAnalysisRaw?.analyzedAt
      ? now - new Date(prometheusAnalysisRaw.analyzedAt).getTime()
      : 0;

    // Read SLO state to determine if this cycle had a breach
    const { readSloMetrics } = await import("./slo_checker.js");
    const sloState = await readSloMetrics(config);
    const hadSloBreachThisCycle = Array.isArray(sloState?.lastCycle?.sloBreaches)
      && sloState.lastCycle.sloBreaches.length > 0;

    const cycleData = {
      retryCount:              cycleTransientRetries,            // real accumulated transient-retry count this cycle
      totalTasks:              Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : 0,
      blockedTasks:            0,                          // blocking is tracked per-worker, not aggregated here
      janusDirectiveAgeMs:     Math.max(0, janusDirectiveAgeMs),
      prometheusAnalysisAgeMs: Math.max(0, prometheusAnalysisAgeMs),
      parseFailureCount:       0,                          // accumulated in persistent state across calls
      hadBudgetBreach:         false,                      // budget controller doesn't surface per-cycle breach yet
      hadSloBreach:            hadSloBreachThisCycle,
    };

    const catastropheOpts = config?.catastropheDetector || {};
    const catastropheResult = await runCatastropheDetection(config, cycleData, catastropheOpts);
    if (catastropheResult.detections.length > 0) {
      await appendProgress(config,
        `[CATASTROPHE] ${catastropheResult.detections.length} scenario(s) detected: ${catastropheResult.detections.map(d => d.scenarioId).join(", ")}`
      );
    } else {
      await appendProgress(config, "[CATASTROPHE] No catastrophe patterns detected this cycle");
    }
    if (!catastropheResult.ok) {
      warn(`[orchestrator] Catastrophe detection degraded: ${catastropheResult.reason || "unknown"}`);
    }

    // Execute guardrail actions for all active detections.
    // Gated by systemGuardian.enabled — set false to retain detection without enforcement (rollback path).
    if (catastropheResult.ok && catastropheResult.detections.length > 0
        && config.systemGuardian?.enabled !== false) {
      const guardResult = await executeGuardrailsForDetections(config, catastropheResult.detections);
      await appendProgress(config,
        `[GUARDRAIL] ${guardResult.results.length} action(s) applied — status=${guardResult.status} withinSla=${guardResult.withinSla} latencyMs=${guardResult.latencyMs}`
      );
      if (!guardResult.ok) {
        warn(`[orchestrator] Guardrail execution returned partial/failed status: ${guardResult.reason || "see results"}`);
      }
    }

    // Auto-revert FORCE_CHECKPOINT_VALIDATION if the SLO_CASCADING_BREACH that
    // triggered it is no longer active this cycle.  Runs unconditionally after
    // detection so a resolved breach is always cleared without operator action.
    if (config.systemGuardian?.enabled !== false) {
      const isSloBreachingNow = catastropheResult.detections.some(
        d => d.scenarioId === "SLO_CASCADING_BREACH"
      );
      const revertResult = await autoRevertSloGuardrailIfResolved(config, isSloBreachingNow);
      if (revertResult.reverted) {
        await appendProgress(config, "[GUARDRAIL] FORCE_CHECKPOINT_VALIDATION auto-reverted: SLO_CASCADING_BREACH condition resolved");
      } else if (revertResult.reason) {
        warn(`[orchestrator] SLO guardrail auto-revert failed (non-fatal): ${revertResult.reason}`);
      }
    }
  } catch (err) {
    // Advisory — never blocks orchestration
    warn(`[orchestrator] Catastrophe detection error (non-fatal): ${String(err?.message || err)}`);
    await appendProgress(config, `[CATASTROPHE] Detection error (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Recurrence detection: scan postmortems for repeated defect patterns ───
  try {
    const postmortemsRaw = await readJson(path.join(stateDir, "athena_postmortems.json"), null);
    const pmEntries = Array.isArray(postmortemsRaw?.entries) ? postmortemsRaw.entries : [];
    if (pmEntries.length > 0) {
      const recurrences = detectRecurrences(pmEntries);
      if (recurrences.length > 0) {
        const escalations = buildRecurrenceEscalations(recurrences);
        await appendProgress(config, `[RECURRENCE] ${recurrences.length} recurring pattern(s) detected: ${recurrences.map(r => r.pattern).join("; ")}`);
        for (const esc of escalations) {
          await appendAlert(config, {
            severity: esc.severity === "critical" ? ALERT_SEVERITY.CRITICAL : ALERT_SEVERITY.HIGH,
            source: "recurrence_detector",
            title: esc.title,
            message: esc.reason
          });
        }
      }
    }
  } catch (err) {
    warn(`[orchestrator] Recurrence detection failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Learning-to-policy compilation: convert lessons into enforced checks ──
  try {
    const postmortemsRaw2 = await readJson(path.join(stateDir, "athena_postmortems.json"), null);
    const pmEntries2 = Array.isArray(postmortemsRaw2?.entries) ? postmortemsRaw2.entries : [];
    if (pmEntries2.length > 0) {
      const learnedPolicyPath = path.join(stateDir, "learned_policies.json");
      const existingPolicies = await readJson(learnedPolicyPath, []);
      const existingPolicyIds = Array.isArray(existingPolicies)
        ? existingPolicies.map((policy: any) => String(policy?.id || "")).filter(Boolean)
        : [];
      const policies = compileLessonsToPolicies(pmEntries2, { existingPolicies: existingPolicyIds });
      if (policies.length > 0) {
        const mergedPolicies = [
          ...(Array.isArray(existingPolicies) ? existingPolicies : []),
          ...policies.map((policy) => ({
            ...policy,
            optimizationLoop: {
              interventionKind: policy?.interventionKind || "policy-delta",
              impactAttribution: "pending",
              retirementMode: "measured_uplift",
            },
          })),
        ];
        await writeJson(learnedPolicyPath, mergedPolicies);
        await appendProgress(config, `[POLICY_COMPILER] ${policies.length} policy optimization delta(s) compiled: ${policies.map(p => p.id).join(", ")}`);
      }
    }
  } catch (err) {
    warn(`[orchestrator] Learning policy compilation failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Carry-forward debt accumulation: register postmortem follow-ups as debt ──
  // Scans the latest postmortems for follow-up tasks and upserts them into the
  // carry-forward ledger.  Also advances the cycle counter so that SLA deadlines
  // stay anchored to a monotonic sequence across cycles.
  try {
    const postmortemsRaw3 = await readJson(path.join(stateDir, "athena_postmortems.json"), null);
    const pmEntries3 = Array.isArray(postmortemsRaw3?.entries) ? postmortemsRaw3.entries : [];
    const followUpItems = pmEntries3
      .filter(e => e.followUpNeeded && e.followUpTask)
      .map(e => ({
        followUpTask: String(e.followUpTask),
        workerName: e.workerName || undefined,
        severity: e.severity || "warning",
      }));

    const { entries: debtLedger, cycleCounter } = await loadLedgerMeta(config);
    const slaOpts = config?.carryForward?.slaMaxCycles
      ? { slaMaxCycles: config.carryForward.slaMaxCycles }
      : undefined;
    const updatedLedger = followUpItems.length > 0
      ? addDebtEntries(debtLedger, followUpItems, cycleCounter, slaOpts)
      : debtLedger;

    // Persist replay closure evidence links for this cycle.
    const _replayEvidenceStartMs = Date.now();
    const replayEvidenceFile = path.join(stateDir, "carry_forward_replay_evidence.jsonl");
    const replayRecords = resolvedPlanItems
      .map((item) => {
        const envelope = item.verificationEvidence && typeof item.verificationEvidence === "object"
          ? item.verificationEvidence as Record<string, unknown>
          : null;
        const replay = envelope?.replayClosure && typeof envelope.replayClosure === "object"
          ? envelope.replayClosure as Record<string, unknown>
          : null;
        if (!replay) return null;
        return JSON.stringify({
          schemaVersion: 1,
          recordedAt: new Date().toISOString(),
          taskText: item.taskText,
          contractSatisfied: replay.contractSatisfied === true,
          canonicalCommands: Array.isArray(replay.canonicalCommands) && replay.canonicalCommands.length > 0
            ? replay.canonicalCommands
            : [...CANONICAL_MAIN_BRANCH_REPLAY_COMMANDS],
          executedCommands: Array.isArray(replay.executedCommands) ? replay.executedCommands : [],
          rawArtifactEvidenceLinks: Array.isArray(replay.rawArtifactEvidenceLinks) ? replay.rawArtifactEvidenceLinks : [],
        });
      })
      .filter(Boolean) as string[];
    if (replayRecords.length > 0) {
      await fs.appendFile(replayEvidenceFile, `${replayRecords.join("\n")}\n`, "utf8");
    }
    // Measure replay evidence write duration and patch into SLO metrics record (advisory, non-blocking).
    const _replayEvidenceMs = Date.now() - _replayEvidenceStartMs;
    patchSloMetricsReplayEvidence(config, _replayEvidenceMs).catch(() => { /* advisory */ });

    // Auto-close debt items verified by replay evidence contract this cycle.
    // Only items with a fingerprint match AND full replay closure evidence are closed.
    // Unresolved items remain open and continue to gate future dispatch via
    // shouldBlockOnDebt in evaluatePreDispatchGovernanceGate.
    const closedByEvidence = autoCloseVerifiedDebt(updatedLedger, resolvedPlanItems);
    if (closedByEvidence > 0) {
      await appendProgress(config,
        `[CARRY_FORWARD] ${closedByEvidence} debt item(s) auto-closed by replay closure evidence contract`
      );
    }

    const carryForwardBacklogPath = path.join(stateDir, "carry_forward_backlog.json");
    const carryForwardBacklog = await readJson(carryForwardBacklogPath, { schemaVersion: 1, items: [] });
    const reconciledBacklog = reconcileReplayClosureBacklog(carryForwardBacklog, updatedLedger);
    await writeJson(carryForwardBacklogPath, reconciledBacklog);

    const replayMandatoryItems = Array.isArray(reconciledBacklog.items)
      ? reconciledBacklog.items.filter((item: any) => MANDATORY_REPLAY_LINEAGE_IDS.includes(String(item?.id || "")))
      : [];
    const mandatoryClosedCount = replayMandatoryItems.filter((item: any) => item?.status === "closed_via_replay_contract").length;
    const mandatoryOpenCount = replayMandatoryItems.length - mandatoryClosedCount;
    const cycleId = String((await readPipelineProgress(config))?.startedAt || `cycle-${Date.now()}`);

    const seamProbe = computeRuntimeContractProbe({
      prometheusAnalysis,
      athenaPlanReview: planReview,
      workerResults: allWorkerResults,
    });
    const doneWorkerEvidenceCount = allWorkerResults.filter((row) => {
      const status = String(row?.status || "").toLowerCase();
      if (status !== "done" && status !== "success") return false;
      if (row?.dispatchContract?.doneWorkerWithVerificationReportEvidence === true) return true;
      return hasVerificationReportEvidence(String(row?.verificationEvidence || ""));
    }).length;
    const blockedDispatchRows = allWorkerResults
      .filter((row) => String(row?.status || "").toLowerCase() === "blocked");
    const blockedWithReasonCount = blockedDispatchRows
      .filter((row) => String(row?.dispatchBlockReason || row?.dispatchContract?.dispatchBlockReason || "").trim().length > 0)
      .length;
    const blockedDispatchReasons = [...new Set(
      blockedDispatchRows
        .map((row) => String(row?.dispatchBlockReason || row?.dispatchContract?.dispatchBlockReason || "").trim())
        .filter(Boolean)
    )];
    const doneWorkerCleanTreeCount = allWorkerResults.filter((row) => {
      const status = String(row?.status || "").toLowerCase();
      if (status !== "done" && status !== "success") return false;
      if (row?.dispatchContract?.doneWorkerWithCleanTreeStatusEvidence === true) return true;
      return hasCleanTreeStatusEvidence(String(row?.verificationEvidence || ""));
    }).length;
    const seamChecks = {
      prometheus: {
        pass: seamProbe.criteria.prometheusGeneratedAtAndKeyFindings.pass === true,
        failReasons: seamProbe.criteria.prometheusGeneratedAtAndKeyFindings.pass === true
          ? []
          : ["prometheus_analysis missing generatedAt/keyFindings runtime-contract fields"],
      },
      athena: {
        pass: seamProbe.criteria.athenaPlanReviewOverallScoreFinite.pass === true,
        failReasons: seamProbe.criteria.athenaPlanReviewOverallScoreFinite.pass === true
          ? []
          : ["athena_plan_review.overallScore is missing or non-finite"],
      },
      worker: {
        pass: seamProbe.criteria.doneWorkerWithVerificationReportEvidence.pass === true,
        failReasons: seamProbe.criteria.doneWorkerWithVerificationReportEvidence.pass === true
          ? []
          : [`no done/success worker produced VERIFICATION_REPORT evidence (count=${doneWorkerEvidenceCount})`],
      },
      cleanTree: {
        pass: doneWorkerCleanTreeCount > 0,
        failReasons: doneWorkerCleanTreeCount > 0
          ? []
          : ["no done/success worker produced accepted clean-tree evidence (global clean or task-scoped clean)"],
      },
      dispatchBlockReason: {
        pass: seamProbe.criteria.dispatchBlockReasonOutcomes.pass === true,
        failReasons: seamProbe.criteria.dispatchBlockReasonOutcomes.pass === true
          ? []
          : [`blocked worker outcomes missing dispatchBlockReason evidence (withReason=${blockedWithReasonCount}/${blockedDispatchRows.length})`],
      },
    };
    const seamContractSatisfied = seamChecks.prometheus.pass
      && seamChecks.athena.pass
      && seamChecks.worker.pass
      && seamChecks.cleanTree.pass
      && seamChecks.dispatchBlockReason.pass;
    const seamFailReasons = [
      ...seamChecks.prometheus.failReasons,
      ...seamChecks.athena.failReasons,
      ...seamChecks.worker.failReasons,
      ...seamChecks.cleanTree.failReasons,
      ...seamChecks.dispatchBlockReason.failReasons,
    ];
    await writeJson(path.join(stateDir, "cycle_proof_evidence.json"), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      cycleId,
      cycleCounter,
      replayClosure: {
        mandatoryLineageIds: [...MANDATORY_REPLAY_LINEAGE_IDS],
        mandatoryClosedCount,
        mandatoryOpenCount,
        contractSatisfied: mandatoryOpenCount === 0,
      },
      seams: {
        contractSatisfied: seamContractSatisfied,
        failReasons: seamFailReasons,
        checks: seamChecks,
      },
      dispatchOutcomes: {
        blockedCount: blockedDispatchRows.length,
        blockedWithReasonCount,
        blockReasons: blockedDispatchReasons,
      },
      backlogSnapshot: replayMandatoryItems.map((item: any) => ({
        id: item?.id || null,
        status: item?.status || null,
        debtId: item?.debtId || null,
        resolutionEvidence: item?.resolutionEvidence || null,
      })),
    });

    const newCycleCounter = cycleCounter + 1;
    await saveLedgerFull(config, updatedLedger, newCycleCounter);

    if (followUpItems.length > 0) {
      const added = updatedLedger.length - debtLedger.length;
      await appendProgress(config,
        `[CARRY_FORWARD] ${added} new debt item(s) registered — cycle=${cycleCounter} total_open=${updatedLedger.filter(e => !e.closedAt).length}`
      );
    }
  } catch (err) {
    warn(`[orchestrator] Carry-forward debt accumulation failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Capacity scoreboard: persist KPIs for trend analysis ──────────────────
  try {
    const firstBatchSpecialization = Array.isArray(workerBatches) && workerBatches.length > 0
      ? (workerBatches[0] as any)?.specialistUtilizationTarget
      : null;
    const firstBatchRerouteReasons = Array.isArray(workerBatches) && workerBatches.length > 0
      ? ((workerBatches[0] as any)?.specialistRerouteReasons ?? [])
      : [];
    // Read lane telemetry from the cycle analytics record computed this cycle
    // (if available) to persist lane distribution trends in the scoreboard.
    let cycleAnalyticsRecord: any = null;
    try {
      cycleAnalyticsRecord = await readCycleAnalytics(config);
    } catch { /* non-fatal */ }
    const cycleLaneTelemetry = cycleAnalyticsRecord?.lastCycle?.laneTelemetry ?? null;

    // Ensure specialization targets are persisted consistently across dispatch paths.
    // buildTokenFirstBatches stamps specialistUtilizationTarget on the first batch;
    // buildRoleExecutionBatches does not.  Fall back to capabilityPoolResult when the
    // batch-level data is absent so the Athena-prebatched and role-execution paths
    // emit the same scoreboard fields as the token-first path.
    const capPoolUtil = (capabilityPoolResult as any)?.specializationUtilization;
    const effectiveSpecTarget: {
      targetMet: boolean;
      adaptiveMinSpecializedShare: number;
      minSpecializedShare: number;
    } | null = firstBatchSpecialization ?? (capPoolUtil
      ? {
          targetMet: capPoolUtil.specializationTargetsMet === true,
          adaptiveMinSpecializedShare: Number(capPoolUtil.adaptiveMinSpecializedShare ?? capPoolUtil.minSpecializedShare ?? 0),
          minSpecializedShare: Number(capPoolUtil.minSpecializedShare ?? 0),
        }
      : null);

    await appendCapacityEntry(config, {
      parserConfidence: prometheusAnalysis?.parserConfidence ?? null,
      parserCoreConfidence: prometheusAnalysis?.parserCoreConfidence ?? null,
      parserContextPenalty: prometheusAnalysis?.parserContextPenalty ?? null,
      planCount: Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : 0,
      projectHealth: prometheusAnalysis?.projectHealth ?? "unknown",
      optimizerStatus: "ok",
      budgetUsed: prometheusAnalysis?.requestBudget?.estimatedPremiumRequestsTotal ?? 0,
      budgetLimit: prometheusAnalysis?.requestBudget?.hardCapTotal ?? 0,
      workersDone: workersDone,
      assignedSpecialistShare: Number(capPoolUtil?.specializedShare ?? 0),
      assignedSpecializedCount: Number(capPoolUtil?.specializedCount ?? 0),
      realizedSpecializedShare: Number(
        cycleLaneTelemetry && typeof cycleLaneTelemetry === "object"
          ? (() => {
              const entries = Object.values(cycleLaneTelemetry as Record<string, any>);
              const totalDispatched = entries.reduce((sum, row) => sum + Math.max(0, Number(row?.dispatched || 0)), 0);
              const realizedSpecialized = entries.reduce((sum, row) => {
                const specialistLane = row?.specialistLane === true || String(row?.lane || "").toLowerCase() !== "implementation";
                return specialistLane ? sum + Math.max(0, Number(row?.dispatched || 0)) : sum;
              }, 0);
              return totalDispatched > 0 ? realizedSpecialized / totalDispatched : 0;
            })()
          : 0
      ),
      specializedShareTarget: Number(effectiveSpecTarget?.adaptiveMinSpecializedShare ?? effectiveSpecTarget?.minSpecializedShare ?? 0),
      specializedShareTargetMet: effectiveSpecTarget?.targetMet === true,
      specialistRerouteCount: Array.isArray(firstBatchRerouteReasons) ? firstBatchRerouteReasons.length : 0,
      configuredMinSpecializedShare: Number(effectiveSpecTarget?.minSpecializedShare ?? 0),
      ...(Array.isArray(firstBatchRerouteReasons) && firstBatchRerouteReasons.length > 0
        ? { specialistRerouteReasons: firstBatchRerouteReasons }
        : {}),
      ...(cycleLaneTelemetry ? { laneTelemetry: cycleLaneTelemetry } : {}),
      ...(capabilityPoolResult?.laneCounts ? { assignedLaneDistribution: capabilityPoolResult.laneCounts } : {}),
      ...(cycleAnalyticsRecord?.lastCycle?.assignedRoleDistribution ? { assignedRoleDistribution: cycleAnalyticsRecord.lastCycle.assignedRoleDistribution } : {}),
      ...(optimizerUsage ? { optimizerUsage } : {}),
    });
  } catch (err) {
    warn(`[orchestrator] Capacity scoreboard update failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Health divergence: publish deterministic cycle health resolution ──────
  // Compares operational health (orchestrator_health.json) with planner health
  // (prometheusAnalysis.projectHealth) and resolves any disagreement into an
  // explicit warning state written to state/cycle_health.json.
  // Advisory — never blocks orchestration.
  try {
    const plannerHealth = prometheusAnalysis?.projectHealth ?? "unknown";
    const plannerTruthStatusRaw = String(prometheusAnalysis?.planningTruthStatus || "").toLowerCase().trim();
    const plannerTruthStatus = plannerTruthStatusRaw === "live" || plannerTruthStatusRaw === "historical"
      ? plannerTruthStatusRaw
      : "unknown";
    const healthFile = await readJson(path.join(stateDir, "orchestrator_health.json"), null);
    const operationalStatus = healthFile?.orchestratorStatus ?? ORCHESTRATOR_STATUS.OPERATIONAL;
    const divergence = computeHealthDivergence(operationalStatus, plannerHealth, plannerTruthStatus);
    await persistCycleHealthComposite(config, {
      healthRecord: pendingCycleHealthRecord,
      divergenceSnapshot: {
        ...divergence,
        recordedAt: new Date().toISOString(),
      },
    });
    if (divergence.isWarning) {
      await appendProgress(config,
        `[HEALTH] Divergence detected — divergenceState=${divergence.divergenceState} pipelineStatus=${divergence.pipelineStatus} operationalStatus=${operationalStatus} plannerHealth=${plannerHealth} plannerTruthStatus=${plannerTruthStatus}`
      );
      await appendAlert(config, {
        severity: divergence.pipelineStatus === PIPELINE_HEALTH_STATUS.CRITICAL ? ALERT_SEVERITY.CRITICAL : ALERT_SEVERITY.HIGH,
        source: "orchestrator",
        title: `Health divergence: ${divergence.divergenceState}`,
        message: `pipelineStatus=${divergence.pipelineStatus} operationalStatus=${operationalStatus} plannerHealth=${plannerHealth} plannerTruthStatus=${plannerTruthStatus}`,
      });
    } else {
      await appendProgress(config,
        `[HEALTH] Cycle health consistent — pipelineStatus=${divergence.pipelineStatus} divergenceState=${divergence.divergenceState}`
      );
    }
  } catch (err) {
    warn(`[orchestrator] Health divergence check failed (non-fatal): ${String(err?.message || err)}`);
    if (pendingCycleHealthRecord) {
      await persistCycleHealthComposite(config, { healthRecord: pendingCycleHealthRecord }).catch(() => {});
    }
  }

  // ── Delta analytics + strategy retune (Wave 6) ───────────────────────────
  try {
    const delta = await computeCapabilityDelta(config);
    if (delta.summary.hasEnoughData) {
      await appendProgress(config, `[DELTA] Capability score=${delta.overallScore}/100 improving=[${delta.summary.improving.join(",")}] degrading=[${delta.summary.degrading.join(",")}]`);

      const retune = evaluateRetune(config, delta);
      if (retune.shouldRetune) {
        await appendProgress(config, `[RETUNE] ${retune.actions.length} retune action(s) recommended: ${retune.actions.map(a => a.parameter).join(", ")}`);
        // Write retune recommendations to state for Janus to consider
        await writeJson(path.join(stateDir, "retune_recommendations.json"), {
          generatedAt: new Date().toISOString(),
          actions: retune.actions,
          deltaReport: delta,
        });
      }
    }
  } catch (err) {
    warn(`[orchestrator] Delta analytics/retune failed (non-fatal): ${String(err?.message || err)}`);
  }
}

// ── Main loop: Janus → Prometheus → Athena → Worker → Athena → repeat ──────

async function mainLoop(config) {
  const stateDir = config.paths?.stateDir || "state";
  const RE_EVAL_SLEEP_MS = 2 * 60 * 1000;

  // Phase 1: wait for any active workers from previous session
  await waitForWorkersToFinish(config);

  // Mark system idle before entering the main loop.
  await safeUpdatePipelineProgress(config, "idle", "System idle — awaiting next cycle");

  // Phase 2: main cycle loop
  while (true) {
    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      await appendProgress(config, `[ATLAS] Stop request detected, shutting down (reason=${stopReq.reason || "unknown"})`);
      await safeUpdatePipelineProgress(config, "idle", "System stopped");
      await clearStopRequest(config);
      await clearDaemonPid(config);
      break;
    }

    // Create a per-cycle cancellation token so deep dispatch loops can honour
    // an in-flight stop request without waiting for the next iteration boundary.
    const cycleToken = createCancellationToken();
    // Hot-reload config
    try {
      const reloadReq = await readReloadRequest(config);
      if (reloadReq?.requestedAt) {
        await clearReloadRequest(config);
        const freshConfig = await loadConfig();
        for (const key of Object.keys(freshConfig)) {
          config[key] = freshConfig[key];
        }
        await appendProgress(config, `[ATLAS] Hot-reload applied — config refreshed (reason=${reloadReq.reason || "cli-reload"})`);
      }
    } catch (err) {
      warn(`[orchestrator] reload error: ${String(err?.message || err)}`);
    }

    const targetLifecycle = await prepareTargetSessionForCycle(config);
    if (targetLifecycle.action !== "continue") {
      await appendProgress(config, `[LOOP][TARGET] ${targetLifecycle.message || "target session not ready"}`);
      await safeUpdatePipelineProgress(config, "idle", targetLifecycle.message || "Target session not ready");
      await sleep(RE_EVAL_SLEEP_MS);
      continue;
    }

    // Check escalation (workers can still escalate to Janus)
    try {
      const escalation = await readJson(path.join(stateDir, "janus_escalation.json"), null);
      if (escalation?.requestedAt) {
        await appendProgress(config, `[LOOP] Escalation to Janus: ${escalation.reason || "(no reason)"}`);
        await writeJson(path.join(stateDir, "janus_escalation.json"), {});
        // Escalation triggers a fresh full cycle
        await runSingleCycle(config, cycleToken);
        continue;
      }
    } catch { /* escalation file may not exist */ }

    // Check if there's remaining work from a previous Prometheus plan
    const prometheusAnalysis = await readJson(path.join(stateDir, "prometheus_analysis.json"), null);
    const totalPlans = isPrometheusAnalysisAlignedToRuntime(prometheusAnalysis, config.platformModeState, config.activeTargetSession)
      ? (Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : 0)
      : 0;

    // Read and prioritise escalation queue before starting any new planning cycle.
    // Alerts leadership when blocked tasks require attention; does not gate planning.
    try {
      await processEscalationQueueClosureWorkflow(config);
      const escalationEntries = await loadEscalationQueue(config);
      const prioritisedEscalations = sortEscalationQueue(escalationEntries);
      if (prioritisedEscalations.length > 0) {
        const top = prioritisedEscalations[0];
        await appendProgress(config,
          `[LOOP] Escalation queue: ${prioritisedEscalations.length} unresolved — top: role=${top.role} class=${top.blockingReasonClass} attempts=${top.attempts}`
        );
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: `Escalation queue: ${prioritisedEscalations.length} unresolved task(s)`,
          message: prioritisedEscalations.slice(0, 3)
            .map(e => `[${e.blockingReasonClass}] ${e.role}: ${e.taskSnippet}`)
            .join(" | ")
        });
      }
    } catch (err) {
      warn(`[orchestrator] escalation queue read error (non-fatal): ${String(err?.message || err)}`);
    }

    // Stale automated-PR guard: audit BOX-owned PRs and record triage decisions.
    try {
      await runStaleAutomatedPrGuard(config);
    } catch (err) {
      warn(`[orchestrator] stale PR guard error (non-fatal): ${String(err?.message || err)}`);
    }

    if (totalPlans > 0) {
      const { completed, pending } = await countCompletedPlans(config, prometheusAnalysis.plans);

      if (pending.length > 0) {
        // Resume-first: if an interrupted dispatch checkpoint exists, attempt to
        // resume from it before starting a fresh full cycle. This avoids duplicating
        // work when the daemon was restarted mid-dispatch.
        try {
          const resumeState = await evaluateDispatchResumeReadiness(config);
          if (resumeState.interrupted) {
            const dispatchCheckpoint = resumeState.checkpoint;
            if (!resumeState.ready) {
              await appendProgress(
                config,
                `[LOOP][RESUME_BLOCKED] Interrupted dispatch checkpoint present but auto-resume is not ready — reason=${resumeState.reason} source=${resumeState.planSource}`,
              );
              await appendAlert(config, {
                severity: ALERT_SEVERITY.HIGH,
                source: "orchestrator",
                title: "Interrupted dispatch checkpoint blocked fresh replanning",
                message: `reason=${resumeState.reason} source=${resumeState.planSource} checkpointStatus=${String(dispatchCheckpoint?.status || "missing")}`,
              });
              await safeUpdatePipelineProgress(
                config,
                "idle",
                `Interrupted dispatch checkpoint preserved — auto-resume blocked (${resumeState.reason})`,
              );
              await sleep(RE_EVAL_SLEEP_MS);
              continue;
            }

            await appendProgress(
              config,
              `[LOOP] Interrupted dispatch checkpoint detected (${dispatchCheckpoint.completedPlans}/${dispatchCheckpoint.totalPlans} complete) — attempting resume source=${resumeState.planSource}`,
            );
            const resumed = await tryResumeDispatchFromCheckpoint(config);
            if (resumed) {
              await sleep(RE_EVAL_SLEEP_MS);
              continue;
            }
            await appendProgress(
              config,
              `[LOOP][RESUME_ANOMALY] Eligible interrupted checkpoint was not resumed — preserving checkpoint and blocking fresh cycle`,
            );
            await appendAlert(config, {
              severity: ALERT_SEVERITY.HIGH,
              source: "orchestrator",
              title: "Interrupted dispatch checkpoint was eligible but resume returned false",
              message: `source=${resumeState.planSource} checkpointStatus=${String(dispatchCheckpoint?.status || "missing")}`,
            });
            await safeUpdatePipelineProgress(
              config,
              "idle",
              "Eligible interrupted dispatch checkpoint was not resumed; fresh replanning blocked",
            );
            await sleep(RE_EVAL_SLEEP_MS);
            continue;
          }

          const dispatchCheckpoint = resumeState.checkpoint;
          if (dispatchCheckpoint) {
            await appendProgress(config, `[LOOP] Dispatch checkpoint present but not resumable — status=${String(dispatchCheckpoint.status || "unknown")} completed=${String(dispatchCheckpoint.completedPlans || 0)}/${String(dispatchCheckpoint.totalPlans || 0)}`);
          }
        } catch (resumeErr) {
          warn(`[orchestrator] dispatch checkpoint resume check failed (non-fatal): ${String((resumeErr as Error)?.message || resumeErr)}`);
        }
        // There's remaining work — run a new full cycle
        // Janus will see the current state and decide appropriately
        await appendProgress(
          config,
          `[LOOP] Fresh cycle trigger: latest approved plan set pending=${pending.length} completed=${completed.length}/${totalPlans} (checkpoint counters may differ)`
        );
        await runSingleCycle(config, cycleToken);
        await sleep(RE_EVAL_SLEEP_MS);
        continue;
      }

      // All plans done — cleanup, project completion, self-improvement
      await appendProgress(config, `[LOOP] All ${totalPlans} plans complete — running post-completion`);
      await postCompletionCleanup(config);

      const alreadyCompleted = await isProjectAlreadyCompleted(config);
      if (!alreadyCompleted) {
        try {
          await runProjectCompletion(config);
          if (
            config.platformModeState?.currentMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY
            && config.activeTargetSession
          ) {
            const completionStage = Array.isArray(config.activeTargetSession.handoff?.requiredHumanInputs)
              && config.activeTargetSession.handoff.requiredHumanInputs.length > 0
              ? TARGET_SESSION_STAGE.COMPLETED_WITH_HANDOFF
              : TARGET_SESSION_STAGE.COMPLETED;
            const archivedSession = await archiveTargetSession(config, {
              completionStage,
              completionReason: `target_delivery_completed:${config.activeTargetSession.sessionId}`,
              completionSummary: config.activeTargetSession.handoff?.carriedContextSummary || config.activeTargetSession.objective?.summary || null,
              unresolvedItems: completionStage === TARGET_SESSION_STAGE.COMPLETED_WITH_HANDOFF
                ? config.activeTargetSession.handoff?.requiredHumanInputs || []
                : [],
            });
            const refreshedModeState = await loadPlatformModeState(config);
            bindRuntimeTargetContext(config, refreshedModeState, null);
            await appendProgress(config, `[TARGET_SESSION] archived completed session ${archivedSession.sessionId} stage=${archivedSession.currentStage}`);
          }
        } catch (err) {
          warn(`[orchestrator] project completion error: ${String(err?.message || err)}`);
        }
      }

      // ── Governance canary: process running policy-rule canary experiments ──
      // Advisory — never blocks orchestration. Processes each running governance
      // canary experiment: assign cycle to cohort, record metrics, evaluate advancement.
      // On breach: status=rolled_back, breachAction=halt_new_assignments (AC4).
      try {
        const { processGovernanceCycle } = await import("./governance_canary.js");
        const cycleId = `governance-${Date.now()}`;
        const govResults = await processGovernanceCycle(config, cycleId, {});
        if (govResults.length > 0) {
          const summary = govResults.map(r => `${r.canaryId}:cohort=${r.cohort}:action=${r.action}`).join(", ");
          await appendProgress(config, `[GOVERNANCE_CANARY] Processed ${govResults.length} experiment(s): ${summary}`);
          const breaches = govResults.filter(r => r.action === "rollback");
          if (breaches.length > 0) {
            await appendProgress(config,
              `[GOVERNANCE_CANARY] BREACH detected — ${breaches.length} experiment(s) rolled back: ${breaches.map(b => `${b.canaryId}:${b.reason}`).join(", ")}`
            );
          }
        }
      } catch (err) {
        // Advisory — never blocks orchestration
        warn(`[orchestrator] governance canary processing error (non-fatal): ${String(err?.message || err)}`);
      }

      // Start a new Prometheus cycle to find new work
      await appendProgress(config, "[LOOP] Post-completion done — running Prometheus for next iteration");
      await runSingleCycle(config, cycleToken);
    } else {
      // No plans at all — first run or fresh start
      await runSingleCycle(config, cycleToken);
    }

    await safeUpdatePipelineProgress(config, "idle", "Cycle complete — waiting before next iteration");
    await sleep(RE_EVAL_SLEEP_MS);
  }
}

// ── appendCiFixContext ────────────────────────────────────────────────────────
// Appends a structured ## CI_FAILURE_CONTEXT section to baseContext for ci-fix
// tasks.  Tries GitHub Actions logs as primary source; falls back to reading
// state/evo_run_latest.log.  Returns baseContext unchanged when evidence is
// insufficient (no failed test identifiers found).
// ─────────────────────────────────────────────────────────────────────────────

const _CI_FIX_FIELD_MAX = 200;

function _truncateCiField(s: string): string {
  if (s.length <= _CI_FIX_FIELD_MAX) return s;
  return s.slice(0, _CI_FIX_FIELD_MAX) + "...";
}

function _parseGhActionsLog(logText: string): {
  failedTestIds: string[];
  errors: string[];
  stacks: string[];
} {
  const failedTestIds: string[] = [];
  const errors: string[] = [];
  const stacks: string[] = [];
  for (const line of logText.split("\n")) {
    const notOk = line.match(/not ok \d+ - (tests\/\S+)/);
    if (notOk) { failedTestIds.push(notOk[1]); continue; }
    const err = line.match(/^(\w*Error:.*)/);
    if (err) { errors.push(err[1]); continue; }
    const stack = line.match(/^\s*(at \S.*)/);
    if (stack) stacks.push(stack[1].trim());
  }
  return { failedTestIds, errors, stacks };
}

function _parseStateArtifactLog(logText: string): {
  headSha: string;
  failedTestIds: string[];
  errors: string[];
  stacks: string[];
} {
  let headSha = "";
  const failedTestIds: string[] = [];
  const errors: string[] = [];
  const stacks: string[] = [];
  for (const line of logText.split("\n")) {
    const cm = line.match(/^commit=(\S+)/);
    if (cm) { headSha = cm[1]; continue; }
    const fm = line.match(/^FAIL (tests\/\S+)/);
    if (fm) { failedTestIds.push(fm[1]); continue; }
    const em = line.match(/^(\w*Error:.*)/);
    if (em) { errors.push(em[1]); continue; }
    const sm = line.match(/^\s*(at \S.*)/);
    if (sm) stacks.push(sm[1].trim());
  }
  return { headSha, failedTestIds, errors, stacks };
}

function _buildCiContextBlock(data: {
  source: string;
  headSha: string;
  failedTestIds: string[];
  errors: string[];
  stacks: string[];
}): string {
  return [
    "## CI_FAILURE_CONTEXT",
    `commit_sha: ${data.headSha}`,
    `failed_test_identifiers: ${data.failedTestIds.map(_truncateCiField).join(", ")}`,
    `error_messages: ${data.errors.map(_truncateCiField).join("; ")}`,
    `stack_traces: ${data.stacks.map(_truncateCiField).join("; ")}`,
    `source: ${data.source}`,
  ].join("\n");
}

function _readCiEvidenceFromPlan(plan: any): {
  source: string;
  headSha: string;
  failedTestIds: string[];
  errors: string[];
  stacks: string[];
} | null {
  const evidence = plan?.ciFailureEvidence;
  if (!evidence || typeof evidence !== "object") return null;
  const failedTestIds = Array.isArray(evidence.failedTestIdentifiers)
    ? evidence.failedTestIdentifiers.map((v: unknown) => String(v || "").trim()).filter(Boolean)
    : [];
  const errors = Array.isArray(evidence.errorMessages)
    ? evidence.errorMessages.map((v: unknown) => String(v || "").trim()).filter(Boolean)
    : [];
  const stacks = Array.isArray(evidence.stackTraces)
    ? evidence.stackTraces.map((v: unknown) => String(v || "").trim()).filter(Boolean)
    : [];
  if (failedTestIds.length === 0 && errors.length === 0 && stacks.length === 0) return null;
  const headSha = String(evidence.headSha || plan?.githubCiContext?.failedCiRuns?.[0]?.headSha || "");
  return {
    source: String(evidence.source || "mandatory_ci_findings"),
    headSha,
    failedTestIds,
    errors,
    stacks,
  };
}

/**
 * Injects deterministic CI failure evidence into a worker context string for
 * ci-fix tasks.  Fetches GitHub Actions job logs for the failed run identified
 * in plan.githubCiContext.failedCiRuns[0], then falls back to reading
 * state/evo_run_latest.log when the API is unavailable.
 *
 * Returns baseContext unchanged when no actionable evidence can be extracted.
 */
export async function appendCiFixContext(
  config: any,
  plan: any,
  baseContext: string,
): Promise<string> {
  const packetEvidence = _readCiEvidenceFromPlan(plan);
  if (packetEvidence) {
    const block = _buildCiContextBlock(packetEvidence);
    return baseContext ? `${baseContext}\n\n${block}` : block;
  }

  const failedCiRuns = plan?.githubCiContext?.failedCiRuns;
  if (!Array.isArray(failedCiRuns) || failedCiRuns.length === 0) return baseContext;

  const targetRepo = String(config?.env?.targetRepo ?? "");
  const githubToken = String(config?.env?.githubToken ?? "");
  const stateDir = String(config?.paths?.stateDir ?? "");

  for (const run of failedCiRuns) {
    const runId = run?.runId;
    const headSha = String(run?.headSha ?? "");

    // ── Step 1: GitHub Actions failed-job logs ───────────────────────────────
    try {
      const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
      if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

      const jobsResp = await fetch(
        `https://api.github.com/repos/${targetRepo}/actions/runs/${runId}/jobs`,
        { headers },
      );
      if (jobsResp.ok) {
        const jobsData = await jobsResp.json() as any;
        const failedJobs = Array.isArray(jobsData.jobs)
          ? jobsData.jobs.filter((j: any) => j.conclusion === "failure")
          : [];
        const logTexts: string[] = [];
        for (const job of failedJobs) {
          const logResp = await fetch(
            `https://api.github.com/repos/${targetRepo}/actions/jobs/${job.id}/logs`,
            { headers },
          );
          if (logResp.ok) logTexts.push(await logResp.text());
        }
        if (logTexts.length > 0) {
          const parsed = _parseGhActionsLog(logTexts.join("\n"));
          if (parsed.failedTestIds.length > 0) {
            const block = _buildCiContextBlock({ source: "github_actions_logs", headSha, ...parsed });
            return baseContext ? `${baseContext}\n\n${block}` : block;
          }
        }
      }
    } catch (err) {
      warn(`[orchestrator] CI evidence fetch failed for run ${String(runId)}: ${String(err?.message || err)}`);
    }

    if (stateDir) {
      // ── Step 2: Local npm_test artifacts (npm_test_full.log, npm_test_relevant.log) ─
      for (const artifactName of ["npm_test_full.log", "npm_test_relevant.log"]) {
        try {
          const logContent = await fs.readFile(path.join(stateDir, artifactName), "utf8");
          const parsed = _parseStateArtifactLog(logContent);
          if (parsed.failedTestIds.length > 0) {
            const block = _buildCiContextBlock({
              source: `local_npm_test_artifact:${artifactName}`,
              headSha: parsed.headSha || headSha,
              ...parsed,
            });
            return baseContext ? `${baseContext}\n\n${block}` : block;
          }
        } catch {
          // File missing or unreadable — continue to next artifact
        }
      }

      // ── Step 3: Latest run logs (test_run.log, build_run.log) ───────────────
      for (const runLogName of ["test_run.log", "build_run.log"]) {
        try {
          const logContent = await fs.readFile(path.join(stateDir, runLogName), "utf8");
          const parsed = _parseStateArtifactLog(logContent);
          if (parsed.failedTestIds.length > 0) {
            const block = _buildCiContextBlock({
              source: `local_run_log:${runLogName}`,
              headSha: parsed.headSha || headSha,
              ...parsed,
            });
            return baseContext ? `${baseContext}\n\n${block}` : block;
          }
        } catch {
          // File missing or unreadable — continue
        }
      }

      // ── Step 4: Fallback: evo_run_latest.log (original fallback) ────────────
      try {
        const logContent = await fs.readFile(path.join(stateDir, "evo_run_latest.log"), "utf8");
        const parsed = _parseStateArtifactLog(logContent);
        if (parsed.failedTestIds.length > 0) {
          const block = _buildCiContextBlock({
            source: "state_fallback_artifacts",
            headSha: parsed.headSha || headSha,
            ...parsed,
          });
          return baseContext ? `${baseContext}\n\n${block}` : block;
        }
      } catch (err) {
        warn(`[orchestrator] CI evidence fallback read failed: ${String(err?.message || err)}`);
      }
    }
  }

  // ── Step 5: Explicit no-data marker — ci-fix worker must know evidence is absent ─
  const noDataBlock = `## CI_FAILURE_CONTEXT\nsource: no_evidence_available\ncommit_sha: unknown\nnote: No CI failure logs could be retrieved from GitHub or local artifacts. Worker must not speculate about failure cause.`;
  return baseContext ? `${baseContext}\n\n${noDataBlock}` : noDataBlock;
}

/**
 * Dispatch-context hydrator used by both primary and resume dispatch paths.
 * Ensures CI-fix packets always carry deterministic failure evidence when present.
 */
export async function hydrateDispatchContextWithCiEvidence(
  config: any,
  plan: any,
  baseContext: string,
): Promise<string> {
  try {
    const taskKind = String(plan?.taskKind || plan?.kind || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
    const ciFixHint = `${String(plan?.task || "")} ${String(plan?.title || "")}`.toLowerCase();
    const isCiFixTask = taskKind === "ci-fix" || /\bci[-_\s]?fix\b/.test(ciFixHint);
    if (!isCiFixTask) return baseContext;
    const hydrated = await appendCiFixContext(config, plan, baseContext);
    await recordCapabilityExecution(
      config,
      "ci-failure-log-injection",
      `task=${String(plan?.task_id || plan?.task || "unknown").slice(0, 120)}`,
    );
    return hydrated;
  } catch (err) {
    warn(`[orchestrator] CI context hydration failed (non-fatal): ${String(err?.message || err)}`);
    return baseContext;
  }
}

// ── Stale automated-PR guard ─────────────────────────────────────────────────

/** Branch prefixes that identify BOX-owned automated PRs subject to triage. */
const STALE_PR_GUARD_BRANCH_PREFIXES = ["recovery/", "evolution/", "box/", "wave", "pr-", "qa/", "scan/"];

/** Minimum age in milliseconds before a PR is considered stale for guard purposes (3 days). */
const STALE_PR_GUARD_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** Title patterns that mark a PR as automated. */
const STALE_PR_GUARD_TITLE_PATTERNS = [
  /api[:\s-]*blocked/i,
  /automated\s+commit/i,
  /auto[-\s]?recovery/i,
  /\[auto\]/i,
];

function _isAutomatedPrBranch(branch: string, title: string): boolean {
  return (
    STALE_PR_GUARD_BRANCH_PREFIXES.some((p) => branch.startsWith(p)) ||
    STALE_PR_GUARD_TITLE_PATTERNS.some((re) => re.test(title))
  );
}

function _classifyAutomationClass(branch: string, title: string): string {
  const t = title.toLowerCase();
  if (branch.startsWith("recovery/")) return "api-blocked-recovery";
  if (branch.startsWith("evolution/")) return "evolution-worker";
  if (/api[:\s-]*blocked/.test(t)) return "api-blocked-recovery";
  if (branch.startsWith("box/")) return "box-automation";
  if (branch.startsWith("qa/")) return "qa-automation";
  return "unknown-automation";
}

/** Branch drift threshold: PRs more than this many commits behind base are closed. */
const STALE_PR_GUARD_DRIFT_THRESHOLD = 10;

/** Deterministic MERGE/CLOSE decision based on CI + diff + merge-state evidence. */
function _makeStaleGuardDecision(
  ci: { allChecksPassed: boolean; failingChecks: number; pendingChecks: number; totalChecks: number; passingChecks: number },
  diff: { hasSubstantiveChanges: boolean },
  ageMs: number,
  mergeState?: { mergeable?: boolean | null; behindBy?: number },
): { decision: "MERGE" | "CLOSE"; rationale: string } {
  // Hard CLOSE: merge conflicts detected — content cannot be merged without manual resolution.
  if (mergeState?.mergeable === false) {
    return { decision: "CLOSE", rationale: "PR has merge conflicts. Branch must be rebased or conflicts resolved before merging. Marking close-no-merge with salvage guidance." };
  }
  // Hard CLOSE: excessive branch drift — too far behind base to be reliable.
  const behindBy = Number(mergeState?.behindBy ?? 0);
  if (behindBy > STALE_PR_GUARD_DRIFT_THRESHOLD) {
    return { decision: "CLOSE", rationale: `Branch is ${behindBy} commits behind base (threshold: ${STALE_PR_GUARD_DRIFT_THRESHOLD}). Salvage: cherry-pick relevant commits onto a fresh branch from main.` };
  }
  if (ci.failingChecks > 0) {
    return { decision: "CLOSE", rationale: `CI has ${ci.failingChecks} failing check(s). Cannot merge failing code.` };
  }
  if (ci.totalChecks === 0 || (ci.pendingChecks > 0 && ageMs > STALE_PR_GUARD_AGE_MS)) {
    const days = Math.round(ageMs / (24 * 60 * 60 * 1000));
    return { decision: "CLOSE", rationale: `No CI checks found (or all pending) and PR is ${days} day(s) old. Stale with no evidence of correctness.` };
  }
  if (ci.allChecksPassed && diff.hasSubstantiveChanges) {
    return { decision: "MERGE", rationale: `CI checks all pass (${ci.passingChecks}/${ci.totalChecks}). Diff contains substantive production changes. Safe to merge automatically.` };
  }
  return { decision: "CLOSE", rationale: `CI passes but diff has no substantive changes (no-op automated commit). Closing to keep PR list clean.` };
}

/**
 * Stale automated-PR guard — audits open BOX-owned PRs and executes a
 * deterministic MERGE or CLOSE decision with CI + diff evidence.
 *
 * State machine per PR:
 *   pending  → applied  (decision executed successfully)
 *   pending  → failed   (execution error — will retry on next loop)
 *   applied              (terminal — idempotency gate skips re-processing)
 *
 * Each triaged PR persists its record to state/pr_triage_<number>.json with
 * an `applyState` field tracking the transition.
 *
 * Integration: called once per daemon loop iteration as a hygiene step.
 */
export async function runStaleAutomatedPrGuard(config: any): Promise<void> {
  const repo = config?.env?.targetRepo;
  const token = config?.env?.githubToken;
  if (!repo || !token) return;

  const stateDir = config?.paths?.stateDir || "state";
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "BOX/1.0",
  };
  const base = `https://api.github.com/repos/${repo}`;

  let openPrs: any[];
  try {
    const res = await fetch(`${base}/pulls?state=open&per_page=100`, { headers });
    if (!res.ok) return;
    const body = await res.json();
    openPrs = Array.isArray(body) ? body : [];
  } catch (err) {
    warn(`[stale_pr_guard] Failed to list open PRs (non-fatal): ${String((err as any)?.message || err)}`);
    return;
  }

  const automatedPrs = openPrs.filter((pr: any) => {
    const branch = String(pr?.head?.ref || "");
    const title = String(pr?.title || "");
    return _isAutomatedPrBranch(branch, title);
  });

  if (automatedPrs.length === 0) return;

  for (const pr of automatedPrs) {
    const prNumber = Number(pr.number);
    const branch = String(pr?.head?.ref || "");
    const title = String(pr?.title || "");
    const createdAt = String(pr?.created_at || "");
    const ageMs = createdAt ? Date.now() - new Date(createdAt).getTime() : 0;

    // Idempotency gate: skip PRs already in a terminal state.
    // "applied"    — action was successfully executed; do not repeat.
    // "superseded" — GitHub returned HTTP 404 (PR gone/already closed); artifact is permanently resolved.
    const recordPath = path.join(stateDir, `pr_triage_${prNumber}.json`);
    const existingRecord = await readJson(recordPath, null);
    if (existingRecord?.applyState === "applied" || existingRecord?.applyState === "superseded") {
      await appendProgress(config, `[STALE_PR_GUARD] PR #${prNumber} already in terminal state (${existingRecord.applyState}) — skipping`);
      continue;
    }

    // Fetch CI check-runs
    let ci = { allChecksPassed: false, totalChecks: 0, failingChecks: 0, passingChecks: 0, pendingChecks: 0, checkNames: [] as string[] };
    try {
      const sha = String(pr?.head?.sha || "");
      if (sha) {
        const runsRes = await fetch(`${base}/commits/${sha}/check-runs?per_page=50`, { headers });
        if (runsRes.ok) {
          const runsBody = await runsRes.json() as Record<string, unknown>;
          const runs: any[] = Array.isArray((runsBody as any)?.check_runs) ? (runsBody as any).check_runs : [];
          const total = runs.length;
          const failing = runs.filter((r) => String(r?.conclusion || "").toLowerCase() === "failure").length;
          const passing = runs.filter((r) => ["success", "neutral"].includes(String(r?.conclusion || "").toLowerCase())).length;
          const pending = runs.filter((r) => r?.status === "in_progress" || r?.status === "queued").length;
          ci = {
            allChecksPassed: total > 0 && failing === 0 && pending === 0,
            totalChecks: total,
            failingChecks: failing,
            passingChecks: passing,
            pendingChecks: pending,
            checkNames: runs.map((r) => String(r?.name || "")).filter(Boolean),
          };
        }
      }
    } catch (err) {
      warn(`[stale_pr_guard] CI fetch failed for PR #${prNumber} (non-fatal): ${String((err as any)?.message || err)}`);
    }

    // Fetch diff file list
    let diff = { filesChanged: [] as string[], hasSubstantiveChanges: false, summary: "diff unavailable" };
    try {
      const filesRes = await fetch(`${base}/pulls/${prNumber}/files?per_page=100`, { headers });
      if (filesRes.ok) {
        const filesBody = await filesRes.json();
        const files: string[] = Array.isArray(filesBody)
          ? filesBody.map((f: any) => String(f?.filename || "")).filter(Boolean)
          : [];
        const hasSubstantiveChanges = files.some((f) => /\.(ts|js|mjs|cjs|json|yml|yaml)$/.test(f));
        diff = {
          filesChanged: files,
          hasSubstantiveChanges,
          summary: files.length > 0
            ? `${files.length} file(s): ${files.slice(0, 5).join(", ")}${files.length > 5 ? " …" : ""}`
            : "no files changed",
        };
      }
    } catch (err) {
      warn(`[stale_pr_guard] Diff fetch failed for PR #${prNumber} (non-fatal): ${String((err as any)?.message || err)}`);
    }

    // Fetch merge-state: mergeable flag and branch distance from base.
    // mergeable=false → CONFLICTING; behindBy > threshold → branch drift CLOSE.
    const mergeState: { mergeable: boolean | null; behindBy: number } = { mergeable: null, behindBy: 0 };
    try {
      const prDetailRes = await fetch(`${base}/pulls/${prNumber}`, { headers });
      if (prDetailRes.ok) {
        const prDetail = await prDetailRes.json() as Record<string, unknown>;
        const mergeable = prDetail?.mergeable;
        mergeState.mergeable = mergeable === null ? null : mergeable === true;
        // Compare head against base to detect branch drift.
        const headSha = String(pr?.head?.sha || "");
        const baseBranch = String((prDetail as any)?.base?.ref || "main");
        if (headSha) {
          try {
            const compareRes = await fetch(`${base}/compare/${baseBranch}...${headSha}`, { headers });
            if (compareRes.ok) {
              const compareBody = await compareRes.json() as Record<string, unknown>;
              mergeState.behindBy = Number((compareBody as any)?.behind_by ?? 0);
            }
          } catch { /* compare is best-effort */ }
        }
      }
    } catch (err) {
      warn(`[stale_pr_guard] Merge-state fetch failed for PR #${prNumber} (non-fatal): ${String((err as any)?.message || err)}`);
    }

    const { decision, rationale } = _makeStaleGuardDecision(ci, diff, ageMs, mergeState);
    const now = new Date().toISOString();

    // Write initial record with applyState=pending before attempting apply.
    const record: Record<string, unknown> = {
      schemaVersion: 1,
      triageTimestamp: now,
      pr: {
        number: prNumber,
        title,
        state: "OPEN",
        branch,
        createdAt,
        mergedAt: null,
        isAutomatedPr: true,
        automationClass: _classifyAutomationClass(branch, title),
      },
      ci,
      diff,
      mergeState,
      decision,
      rationale,
      decidedBy: "runStaleAutomatedPrGuard",
      decidedAt: now,
      applyState: "pending",
    };

    try {
      await writeJson(recordPath, record);
      await appendProgress(config, `[STALE_PR_GUARD] PR #${prNumber} (${branch}) → ${decision}: ${rationale}`);
    } catch (err) {
      warn(`[stale_pr_guard] Failed to write triage record for PR #${prNumber}: ${String((err as any)?.message || err)}`);
    }

    // Apply the decision: merge or close the PR, then persist the apply result.
    // Terminal states:
    //   "applied"    — action executed successfully.
    //   "superseded" — GitHub returned HTTP 404; PR no longer exists (already closed/merged elsewhere).
    //                  Treated as terminal to prevent repeated recovery-planning on a resolved artifact.
    let applyState: "applied" | "failed" | "superseded" = "failed";
    let appliedAt: string | undefined;
    let applyError: string | undefined;

    try {
      if (decision === "MERGE") {
        const mergeRes = await fetch(`${base}/pulls/${prNumber}/merge`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ merge_method: "squash" }),
        });
        if (mergeRes.ok || mergeRes.status === 405) {
          // 405 = Method Not Allowed means PR is already merged — treat as applied.
          applyState = "applied";
          appliedAt = new Date().toISOString();
          await appendProgress(config, `[STALE_PR_GUARD] PR #${prNumber} merged (HTTP ${mergeRes.status})`);
        } else if (mergeRes.status === 404) {
          // PR no longer exists on GitHub — mark as superseded (terminal).
          const errText = await mergeRes.text().catch(() => "");
          applyError = `HTTP ${mergeRes.status}: ${errText.slice(0, 200)}`;
          applyState = "superseded";
          warn(`[stale_pr_guard] PR #${prNumber} not found on merge (HTTP 404) — marking superseded`);
          await appendProgress(config, `[STALE_PR_GUARD] PR #${prNumber} superseded (HTTP 404 on merge — PR already resolved)`);
        } else {
          const errText = await mergeRes.text().catch(() => "");
          applyError = `HTTP ${mergeRes.status}: ${errText.slice(0, 200)}`;
          warn(`[stale_pr_guard] Merge failed for PR #${prNumber}: ${applyError}`);
        }
      } else if (decision === "CLOSE") {
        const closeRes = await fetch(`${base}/pulls/${prNumber}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ state: "closed" }),
        });
        if (closeRes.ok) {
          applyState = "applied";
          appliedAt = new Date().toISOString();
          await appendProgress(config, `[STALE_PR_GUARD] PR #${prNumber} closed`);
        } else if (closeRes.status === 404) {
          // PR no longer exists on GitHub — mark as superseded (terminal).
          const errText = await closeRes.text().catch(() => "");
          applyError = `HTTP ${closeRes.status}: ${errText.slice(0, 200)}`;
          applyState = "superseded";
          warn(`[stale_pr_guard] PR #${prNumber} not found on close (HTTP 404) — marking superseded`);
          await appendProgress(config, `[STALE_PR_GUARD] PR #${prNumber} superseded (HTTP 404 on close — PR already resolved)`);
        } else {
          const errText = await closeRes.text().catch(() => "");
          applyError = `HTTP ${closeRes.status}: ${errText.slice(0, 200)}`;
          warn(`[stale_pr_guard] Close failed for PR #${prNumber}: ${applyError}`);
        }
      }
    } catch (err) {
      applyError = String((err as any)?.message || err);
      warn(`[stale_pr_guard] Apply exception for PR #${prNumber}: ${applyError}`);
    }

    // Persist apply result back to the record.
    try {
      const updatedRecord: Record<string, unknown> = { ...record, applyState };
      if (appliedAt) updatedRecord.appliedAt = appliedAt;
      if (applyError) updatedRecord.applyError = applyError;
      await writeJson(recordPath, updatedRecord);
    } catch (err) {
      warn(`[stale_pr_guard] Failed to update apply state for PR #${prNumber}: ${String((err as any)?.message || err)}`);
    }
  }
}

// ── Stale-artifact closure fastpath ──────────────────────────────────────────

/**
 * Fetches CI check-run status for the main branch HEAD commit.
 *
 * Returns a summary object that is safe to use in deterministic gates.
 * Falls back to { green: false, ... } on any network or parse error so callers
 * can treat absence-of-CI as non-green without throwing.
 */
export async function fetchMainBranchCiStatus(config: any): Promise<{
  green: boolean;
  totalChecks: number;
  passingChecks: number;
  failingChecks: number;
  pendingChecks: number;
  sha: string;
}> {
  const defaultResult = { green: false, totalChecks: 0, passingChecks: 0, failingChecks: 0, pendingChecks: 0, sha: "" };
  const repo = config?.env?.targetRepo;
  const token = config?.env?.githubToken;
  if (!repo || !token) return defaultResult;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "BOX/1.0",
  };
  const base = `https://api.github.com/repos/${repo}`;

  try {
    const branchRes = await fetch(`${base}/branches/main`, { headers });
    if (!branchRes.ok) return defaultResult;
    const branchData = await branchRes.json() as any;
    const sha = String(branchData?.commit?.sha || "");
    if (!sha) return defaultResult;

    const runsRes = await fetch(`${base}/commits/${sha}/check-runs?per_page=50`, { headers });
    if (!runsRes.ok) return { ...defaultResult, sha };
    const runsBody = await runsRes.json() as any;
    const runs: any[] = Array.isArray(runsBody?.check_runs) ? runsBody.check_runs : [];
    const total = runs.length;
    const failing = runs.filter((r) => String(r?.conclusion || "").toLowerCase() === "failure").length;
    const passing = runs.filter((r) => ["success", "neutral"].includes(String(r?.conclusion || "").toLowerCase())).length;
    const pending = runs.filter((r) => r?.status === "in_progress" || r?.status === "queued").length;

    return {
      green: total > 0 && failing === 0 && pending === 0,
      totalChecks: total,
      passingChecks: passing,
      failingChecks: failing,
      pendingChecks: pending,
      sha,
    };
  } catch (err) {
    warn(`[orchestrator] main branch CI fetch failed (non-fatal): ${String((err as any)?.message || err)}`);
    return defaultResult;
  }
}

/**
 * Reads all stale automated-PR triage records from the state directory.
 *
 * Files are named `pr_triage_<number>.json` and contain an `applyState` field.
 * Returns an empty array when the state dir is missing or no triage files exist.
 * Individual file read errors are silently skipped (best-effort).
 */
export async function loadStaleTriageRecords(config: any): Promise<Array<Record<string, unknown>>> {
  const stateDir = config?.paths?.stateDir || "state";
  try {
    const entries = await fs.readdir(stateDir);
    const triageFiles = entries.filter((e) => /^pr_triage_\d+\.json$/.test(e));
    const records: Array<Record<string, unknown>> = [];
    for (const file of triageFiles) {
      try {
        const data = await readJson(path.join(stateDir, file), null);
        if (data && typeof data === "object") {
          records.push(data as any);
        }
      } catch {
        // best-effort — skip unreadable files
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Orchestrates the stale-artifact closure fastpath decision.
 *
 * Loads stale PR triage records and fetches main branch CI status, then
 * delegates to the deterministic `evaluateStaleArtifactClosureFastpath`
 * in athena_reviewer for the eligibility decision.
 *
 * Returns:
 *   eligible=true  → caller should skip worker dispatch and close the cycle.
 *   eligible=false → caller should proceed with normal dispatch.
 */
export async function runStaleArtifactClosureFastpath(
  config: any,
  currentPlans: Array<Record<string, unknown>> = [],
): Promise<{
  eligible: boolean;
  reason: string;
  stalePrCount: number;
  mainCiGreen: boolean;
}> {
  const triageRecords = await loadStaleTriageRecords(config);
  const ciStatus = await fetchMainBranchCiStatus(config);
  const recencyWindowMs = Number.isFinite(Number(config?.runtime?.staleArtifactClosureRecencyMs))
    ? Math.max(0, Number(config.runtime.staleArtifactClosureRecencyMs))
    : 60 * 60 * 1000;
  const result = evaluateStaleArtifactClosureFastpath({
    staleTriageRecords: triageRecords,
    mainCiGreen: ciStatus.green,
    currentPlans,
    nowMs: Date.now(),
    recencyWindowMs,
  });
  return {
    eligible: result.eligible,
    reason: result.reason,
    stalePrCount: triageRecords.length,
    mainCiGreen: ciStatus.green,
  };
}

