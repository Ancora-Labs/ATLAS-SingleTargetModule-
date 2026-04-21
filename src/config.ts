import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import type { Config } from "./types/index.js";

dotenv.config({ override: true });

function must(value: string | undefined, _key: string): string | null {
  if (!value || !value.trim()) {
    return null;
  }
  return value.trim();
}

export async function loadConfig(): Promise<Config> {
  const rootDir = process.cwd();
  const atlasConfigPath = path.join(rootDir, "atlas.config.json");
  const legacyConfigPath = path.join(rootDir, "box.config.json");
  const configPath = await fs.access(atlasConfigPath)
    .then(() => atlasConfigPath)
    .catch(() => legacyConfigPath);
  const raw = await fs.readFile(configPath, "utf8");
  const fileConfig = JSON.parse(raw);

  const env = {
    githubToken: must(
      process.env.canerdogduGITHUB_TOKEN
      || process.env.GITHUB_TOKEN
      || process.env.GITHUB_TOKENPERSONAL,
      "GITHUB_TOKEN"
    ),
    // Copilot CLI needs a fine-grained PAT (github_pat_) with Copilot permissions.
    // Classic PATs (ghp_) are NOT supported by Copilot CLI.
    // Support legacy/local variable names used in older .env files.
    copilotGithubToken: must(
      process.env.canerdoqdu_FINEGRADED
      || process.env.COPILOT_GITHUB_TOKEN
      || process.env.CanerdoqduFINEGRADED
      || process.env.CanerdoqduFINEGRADEDGENERALANDTRUMP
      || process.env.GITHUB_FINEGRADED
      || process.env.GITHUBFINEGRADEDPERSONALINTEL,
      "COPILOT_GITHUB_TOKEN"
    ),
    targetRepo: must(process.env.TARGET_REPO, "TARGET_REPO"),
    targetBaseBranch: process.env.TARGET_BASE_BRANCH?.trim() || "main",
    copilotCliCommand: process.env.COPILOT_CLI_COMMAND?.trim() || "copilot",
    budgetUsd: Number(process.env.BOX_BUDGET_USD || "15"),
    mode: process.env.BOX_MODE?.trim() || "local",
    copilotStrategy: process.env.COPILOT_STRATEGY?.trim() || null,
    copilotAllowOpus: process.env.COPILOT_ALLOW_OPUS?.trim() || null,
    copilotAllowedModels: process.env.COPILOT_ALLOWED_MODELS?.trim() || null,
    copilotMaxMultiplier: process.env.COPILOT_MAX_MULTIPLIER?.trim() || null,
    copilotOpusMinBudgetUsd: process.env.COPILOT_OPUS_MIN_BUDGET_USD?.trim() || null,
    copilotOpusMonthlyMaxCalls: process.env.COPILOT_OPUS_MONTHLY_MAX_CALLS?.trim() || null,
    autoCreatePr: process.env.BOX_AUTO_CREATE_PR?.trim() || null,
    autoMergeOnGreen: process.env.BOX_AUTO_MERGE_ON_GREEN?.trim() || null,
    autoMergeWaitSeconds: process.env.BOX_AUTO_MERGE_WAIT_SECONDS?.trim() || null,
    autoMergePollSeconds: process.env.BOX_AUTO_MERGE_POLL_SECONDS?.trim() || null,
    autoMergeMethod: process.env.BOX_AUTO_MERGE_METHOD?.trim() || null,
    requiredCheckRuns: process.env.BOX_REQUIRED_CHECK_RUNS?.trim() || null,
    requiredStatusContexts: process.env.BOX_REQUIRED_STATUS_CONTEXTS?.trim() || null,
    copilotAutoCompact: process.env.BOX_COPILOT_AUTO_COMPACT?.trim() || null,
    copilotRehydrateOnFail: process.env.BOX_COPILOT_REHYDRATE_ON_FAIL?.trim() || null,
    copilotMaxRetries: process.env.BOX_COPILOT_MAX_RETRIES?.trim() || null,
    stopOnError: process.env.BOX_STOP_ON_ERROR?.trim() || null,
    reviewerProvider: process.env.BOX_REVIEWER_PROVIDER?.trim() || null,
    autonomousMaxAttemptsPerTask: process.env.BOX_AUTONOMOUS_MAX_ATTEMPTS_PER_TASK?.trim() || null,
    autonomousTaskSplitOnFailure: process.env.BOX_AUTONOMOUS_TASK_SPLIT_ON_FAILURE?.trim() || null,
    maxQueuedTasks: process.env.BOX_MAX_QUEUED_TASKS?.trim() || null,
    requireSecurityScan: process.env.BOX_REQUIRE_SECURITY_SCAN?.trim() || null,
    issueHandoffEnabled: process.env.BOX_ISSUE_HANDOFF_ENABLED?.trim() || null,
    issueAutoCloseOnRecovery: process.env.BOX_ISSUE_AUTO_CLOSE_ON_RECOVERY?.trim() || null,
    autonomySupervisorEnabled: process.env.BOX_AUTONOMY_SUPERVISOR_ENABLED?.trim() || null,
    deepProjectAnalysisEnabled: process.env.BOX_DEEP_PROJECT_ANALYSIS_ENABLED?.trim() || null,
    runningTaskTimeoutMinutes: process.env.BOX_RUNNING_TASK_TIMEOUT_MINUTES?.trim() || null,
    blockedTaskRequeueMinutes: process.env.BOX_BLOCKED_TASK_REQUEUE_MINUTES?.trim() || null,
    semanticFailureWindowMinutes: process.env.BOX_SEMANTIC_FAILURE_WINDOW_MINUTES?.trim() || null,
    semanticFailureMaxCount: process.env.BOX_SEMANTIC_FAILURE_MAX_COUNT?.trim() || null,
    strategicLoopMinutes: process.env.BOX_STRATEGIC_LOOP_MINUTES?.trim() || null,
    maxTacticalCyclesBeforeForceStrategic: process.env.BOX_MAX_TACTICAL_CYCLES_BEFORE_FORCE_STRATEGIC?.trim() || null,
    blockedTasksForceStrategicThreshold: process.env.BOX_BLOCKED_TASKS_FORCE_STRATEGIC_THRESHOLD?.trim() || null,
    unresolvedTasksForceStrategicThreshold: process.env.BOX_UNRESOLVED_TASKS_FORCE_STRATEGIC_THRESHOLD?.trim() || null,
    leadershipBlockedTasksDegradeThreshold: process.env.BOX_LEADERSHIP_BLOCKED_TASKS_DEGRADE_THRESHOLD?.trim() || null,
    sprintFreezeRatio: process.env.BOX_SPRINT_FREEZE_RATIO?.trim() || null,
    requireTaskContract: process.env.BOX_REQUIRE_TASK_CONTRACT?.trim() || null,
    systemGuardianEnabled: process.env.BOX_SYSTEM_GUARDIAN_ENABLED?.trim() || null,
    systemGuardianCooldownMinutes: process.env.BOX_SYSTEM_GUARDIAN_COOLDOWN_MINUTES?.trim() || null,
    systemGuardianTrashTaskRatioThreshold: process.env.BOX_SYSTEM_GUARDIAN_TRASH_RATIO_THRESHOLD?.trim() || null,
    systemGuardianRepeatedFailureThreshold: process.env.BOX_SYSTEM_GUARDIAN_REPEATED_FAILURE_THRESHOLD?.trim() || null,
    systemGuardianOrphanedCheckpointThreshold: process.env.BOX_SYSTEM_GUARDIAN_ORPHANED_CHECKPOINT_THRESHOLD?.trim() || null,
    systemGuardianStaleWorkerMinutes: process.env.BOX_SYSTEM_GUARDIAN_STALE_WORKER_MINUTES?.trim() || null,
    securityFamilyFailureMaxCount: process.env.BOX_SECURITY_FAMILY_FAILURE_MAX_COUNT?.trim() || null,
    securityFamilyFailureWindowMinutes: process.env.BOX_SECURITY_FAMILY_FAILURE_WINDOW_MINUTES?.trim() || null,
    securityFamilyCooldownMinutes: process.env.BOX_SECURITY_FAMILY_COOLDOWN_MINUTES?.trim() || null,
    environmentBlockerCooldownMinutes: process.env.BOX_ENVIRONMENT_BLOCKER_COOLDOWN_MINUTES?.trim() || null,
    janusTimeoutMs: process.env.BOX_JANUS_TIMEOUT_MS?.trim() || null,
    janusDecisionLatencyWarningMs: process.env.BOX_JANUS_DECISION_LATENCY_WARNING_MS?.trim() || null,
    janusLatencyTier1Ms: process.env.BOX_JANUS_LATENCY_TIER1_MS?.trim() || null,
    janusLatencyTier2Ms: process.env.BOX_JANUS_LATENCY_TIER2_MS?.trim() || null,
    janusFallbackModel: process.env.BOX_JANUS_FALLBACK_MODEL?.trim() || null,
    janusMaxRetries: process.env.BOX_JANUS_MAX_RETRIES?.trim() || null,
    workerTimeoutMinutes: process.env.BOX_WORKER_TIMEOUT_MINUTES?.trim() || null,
    verificationCommandTimeoutMs: process.env.BOX_VERIFICATION_COMMAND_TIMEOUT_MS?.trim() || null,
    dashboardEnabled: process.env.BOX_DASHBOARD_ENABLED?.trim() || null,
    interBatchDelayMs: process.env.BOX_INTER_BATCH_DELAY_MS?.trim() || null,
    maxCapacityMode: process.env.BOX_MAX_CAPACITY_MODE?.trim() || null,
    maxPlansPerDependencyBatch: process.env.BOX_MAX_PLANS_PER_DEPENDENCY_BATCH?.trim() || null,
    // Dashboard bearer token — required for POST mutation endpoints on the live dashboard.
    // Must be a long random string. If unset, mutation endpoints return 403.
    dashboardToken: process.env.BOX_DASHBOARD_TOKEN?.trim() || null,
    cloudAssignmentEnabled: process.env.BOX_CLOUD_ASSIGNMENT_ENABLED?.trim() || null,
    cloudAssignmentIssue: process.env.BOX_CLOUD_ASSIGNMENT_ISSUE?.trim() || null,
    cloudAssignmentPr: process.env.BOX_CLOUD_ASSIGNMENT_PR?.trim() || null,
    cloudAssignmentPollIntervalMs: process.env.BOX_CLOUD_ASSIGNMENT_POLL_INTERVAL_MS?.trim() || null,
    cloudAssignmentMaxWaitMs: process.env.BOX_CLOUD_ASSIGNMENT_MAX_WAIT_MS?.trim() || null
  };

  const parsedAllowedModels = env.copilotAllowedModels
    ? env.copilotAllowedModels.split(",").map((item) => item.trim()).filter(Boolean)
    : null;

  const copilot = {
    ...(fileConfig.copilot ?? {}),
    strategy: env.copilotStrategy || fileConfig?.copilot?.strategy || "task-best",
    allowOpusEscalation: env.copilotAllowOpus
      ? ["1", "true", "yes", "on"].includes(env.copilotAllowOpus.toLowerCase())
      : Boolean(fileConfig?.copilot?.allowOpusEscalation),
    allowedModels: parsedAllowedModels ?? fileConfig?.copilot?.allowedModels ?? [],
    maxMultiplier: env.copilotMaxMultiplier ? Number(env.copilotMaxMultiplier) : Number(fileConfig?.copilot?.maxMultiplier ?? 1),
    opusMinBudgetUsd: env.copilotOpusMinBudgetUsd ? Number(env.copilotOpusMinBudgetUsd) : Number(fileConfig?.copilot?.opusMinBudgetUsd ?? 2),
    opusMonthlyMaxCalls: env.copilotOpusMonthlyMaxCalls ? Number(env.copilotOpusMonthlyMaxCalls) : Number(fileConfig?.copilot?.opusMonthlyMaxCalls ?? 8)
  };

  const git = {
    ...(fileConfig.git ?? {}),
    autoCreatePr: env.autoCreatePr
      ? ["1", "true", "yes", "on"].includes(env.autoCreatePr.toLowerCase())
      : Boolean(fileConfig?.git?.autoCreatePr ?? true),
    autoMergeOnGreen: env.autoMergeOnGreen
      ? ["1", "true", "yes", "on"].includes(env.autoMergeOnGreen.toLowerCase())
      : Boolean(fileConfig?.git?.autoMergeOnGreen ?? false),
    autoMergeWaitSeconds: env.autoMergeWaitSeconds
      ? Number(env.autoMergeWaitSeconds)
      : Number(fileConfig?.git?.autoMergeWaitSeconds ?? 300),
    autoMergePollSeconds: env.autoMergePollSeconds
      ? Number(env.autoMergePollSeconds)
      : Number(fileConfig?.git?.autoMergePollSeconds ?? 15),
    autoMergeMethod: env.autoMergeMethod || fileConfig?.git?.autoMergeMethod || "squash",
    requiredCheckRuns: env.requiredCheckRuns
      ? env.requiredCheckRuns.split(",").map((item) => item.trim()).filter(Boolean)
      : (fileConfig?.git?.requiredCheckRuns ?? []),
    requiredStatusContexts: env.requiredStatusContexts
      ? env.requiredStatusContexts.split(",").map((item) => item.trim()).filter(Boolean)
      : (fileConfig?.git?.requiredStatusContexts ?? [])
  };

  const runtime = {
    ...(fileConfig.runtime ?? {}),
    copilotAutoCompact: env.copilotAutoCompact
      ? ["1", "true", "yes", "on"].includes(env.copilotAutoCompact.toLowerCase())
      : Boolean(fileConfig?.runtime?.copilotAutoCompact ?? true),
    copilotRehydrateOnFail: env.copilotRehydrateOnFail
      ? ["1", "true", "yes", "on"].includes(env.copilotRehydrateOnFail.toLowerCase())
      : Boolean(fileConfig?.runtime?.copilotRehydrateOnFail ?? true),
    copilotMaxRetries: env.copilotMaxRetries
      ? Number(env.copilotMaxRetries)
      : Number(fileConfig?.runtime?.copilotMaxRetries ?? 2),
    stopOnError: env.stopOnError
      ? ["1", "true", "yes", "on"].includes(env.stopOnError.toLowerCase())
      : Boolean(fileConfig?.runtime?.stopOnError ?? true),
    reviewerProvider: String(env.reviewerProvider || fileConfig?.runtime?.reviewerProvider || "copilot").trim().toLowerCase(),
    autonomousMaxAttemptsPerTask: env.autonomousMaxAttemptsPerTask
      ? Number(env.autonomousMaxAttemptsPerTask)
      : Number(fileConfig?.runtime?.autonomousMaxAttemptsPerTask ?? 3),
    autonomousTaskSplitOnFailure: env.autonomousTaskSplitOnFailure
      ? ["1", "true", "yes", "on"].includes(env.autonomousTaskSplitOnFailure.toLowerCase())
      : Boolean(fileConfig?.runtime?.autonomousTaskSplitOnFailure ?? true),
    maxQueuedTasks: env.maxQueuedTasks
      ? Number(env.maxQueuedTasks)
      : Number(fileConfig?.runtime?.maxQueuedTasks ?? 30),
    issueHandoffEnabled: env.issueHandoffEnabled
      ? ["1", "true", "yes", "on"].includes(env.issueHandoffEnabled.toLowerCase())
      : Boolean(fileConfig?.runtime?.issueHandoffEnabled ?? true),
    issueAutoCloseOnRecovery: env.issueAutoCloseOnRecovery
      ? ["1", "true", "yes", "on"].includes(env.issueAutoCloseOnRecovery.toLowerCase())
      : Boolean(fileConfig?.runtime?.issueAutoCloseOnRecovery ?? true),
    autonomySupervisorEnabled: env.autonomySupervisorEnabled
      ? ["1", "true", "yes", "on"].includes(env.autonomySupervisorEnabled.toLowerCase())
      : Boolean(fileConfig?.runtime?.autonomySupervisorEnabled ?? true),
    deepProjectAnalysisEnabled: env.deepProjectAnalysisEnabled
      ? ["1", "true", "yes", "on"].includes(env.deepProjectAnalysisEnabled.toLowerCase())
      : Boolean(fileConfig?.runtime?.deepProjectAnalysisEnabled ?? true),
    runningTaskTimeoutMinutes: env.runningTaskTimeoutMinutes
      ? Number(env.runningTaskTimeoutMinutes)
      : Number(fileConfig?.runtime?.runningTaskTimeoutMinutes ?? 30),
    blockedTaskRequeueMinutes: env.blockedTaskRequeueMinutes
      ? Number(env.blockedTaskRequeueMinutes)
      : Number(fileConfig?.runtime?.blockedTaskRequeueMinutes ?? 120),
    semanticFailureWindowMinutes: env.semanticFailureWindowMinutes
      ? Number(env.semanticFailureWindowMinutes)
      : Number(fileConfig?.runtime?.semanticFailureWindowMinutes ?? 180),
    semanticFailureMaxCount: env.semanticFailureMaxCount
      ? Number(env.semanticFailureMaxCount)
      : Number(fileConfig?.runtime?.semanticFailureMaxCount ?? 3),
    strategicLoopMinutes: env.strategicLoopMinutes
      ? Number(env.strategicLoopMinutes)
      : Number(fileConfig?.runtime?.strategicLoopMinutes ?? 45),
    maxTacticalCyclesBeforeForceStrategic: env.maxTacticalCyclesBeforeForceStrategic
      ? Number(env.maxTacticalCyclesBeforeForceStrategic)
      : Number(fileConfig?.runtime?.maxTacticalCyclesBeforeForceStrategic ?? 3),
    blockedTasksForceStrategicThreshold: env.blockedTasksForceStrategicThreshold
      ? Number(env.blockedTasksForceStrategicThreshold)
      : Number(fileConfig?.runtime?.blockedTasksForceStrategicThreshold ?? 8),
    unresolvedTasksForceStrategicThreshold: env.unresolvedTasksForceStrategicThreshold
      ? Number(env.unresolvedTasksForceStrategicThreshold)
      : Number(fileConfig?.runtime?.unresolvedTasksForceStrategicThreshold ?? 12),
    leadershipBlockedTasksDegradeThreshold: env.leadershipBlockedTasksDegradeThreshold
      ? Number(env.leadershipBlockedTasksDegradeThreshold)
      : Number(fileConfig?.runtime?.leadershipBlockedTasksDegradeThreshold ?? 8),
    sprintFreezeRatio: env.sprintFreezeRatio
      ? Number(env.sprintFreezeRatio)
      : Number(fileConfig?.runtime?.sprintFreezeRatio ?? 0.8),
    requireTaskContract: env.requireTaskContract
      ? ["1", "true", "yes", "on"].includes(env.requireTaskContract.toLowerCase())
      : Boolean(fileConfig?.runtime?.requireTaskContract ?? true),
    securityFamilyFailureMaxCount: env.securityFamilyFailureMaxCount
      ? Number(env.securityFamilyFailureMaxCount)
      : Number(fileConfig?.runtime?.securityFamilyFailureMaxCount ?? 3),
    securityFamilyFailureWindowMinutes: env.securityFamilyFailureWindowMinutes
      ? Number(env.securityFamilyFailureWindowMinutes)
      : Number(fileConfig?.runtime?.securityFamilyFailureWindowMinutes ?? 240),
    securityFamilyCooldownMinutes: env.securityFamilyCooldownMinutes
      ? Number(env.securityFamilyCooldownMinutes)
      : Number(fileConfig?.runtime?.securityFamilyCooldownMinutes ?? 240),
    environmentBlockerCooldownMinutes: env.environmentBlockerCooldownMinutes
      ? Number(env.environmentBlockerCooldownMinutes)
      : Number(fileConfig?.runtime?.environmentBlockerCooldownMinutes ?? 180),
    janusTimeoutMs: env.janusTimeoutMs
      ? Number(env.janusTimeoutMs)
      : Number(fileConfig?.runtime?.janusTimeoutMs ?? 1800000),
    janusDecisionLatencyWarningMs: env.janusDecisionLatencyWarningMs
      ? Number(env.janusDecisionLatencyWarningMs)
      : Number(fileConfig?.runtime?.janusDecisionLatencyWarningMs ?? fileConfig?.slo?.thresholds?.decisionLatencyMs ?? 900000),
    janusLatencyTier1Ms: env.janusLatencyTier1Ms
      ? Number(env.janusLatencyTier1Ms)
      : Number(fileConfig?.runtime?.janusLatencyTier1Ms ?? 60000),
    janusLatencyTier2Ms: env.janusLatencyTier2Ms
      ? Number(env.janusLatencyTier2Ms)
      : Number(fileConfig?.runtime?.janusLatencyTier2Ms ?? 600000),
    janusFallbackModel: env.janusFallbackModel
      ? String(env.janusFallbackModel)
      : String(fileConfig?.runtime?.janusFallbackModel ?? ""),
    janusMaxRetries: env.janusMaxRetries
      ? Number(env.janusMaxRetries)
      : Number(fileConfig?.runtime?.janusMaxRetries ?? 1),
    workerMaxFilesChanged: Number(fileConfig?.runtime?.workerMaxFilesChanged ?? 20),
    workerTimeoutMinutes: env.workerTimeoutMinutes
      ? Number(env.workerTimeoutMinutes)
      : Number(fileConfig?.runtime?.workerTimeoutMinutes ?? 15),
    verificationCommandTimeoutMs: env.verificationCommandTimeoutMs
      ? Number(env.verificationCommandTimeoutMs)
      : Number(fileConfig?.runtime?.verificationCommandTimeoutMs ?? 1800000),
    dashboardEnabled: env.dashboardEnabled
      ? ["1", "true", "yes", "on"].includes(env.dashboardEnabled.toLowerCase())
      : Boolean(fileConfig?.runtime?.dashboardEnabled ?? true),
    interBatchDelayMs: env.interBatchDelayMs
      ? Number(env.interBatchDelayMs)
      : Number(fileConfig?.runtime?.interBatchDelayMs ?? 90000),
    maxCapacityMode: env.maxCapacityMode
      ? ["1", "true", "yes", "on"].includes(env.maxCapacityMode.toLowerCase())
      : Boolean(fileConfig?.runtime?.maxCapacityMode ?? false),
    maxPlansPerDependencyBatch: env.maxPlansPerDependencyBatch
      ? Number(env.maxPlansPerDependencyBatch)
      : Number(fileConfig?.runtime?.maxPlansPerDependencyBatch ?? 6),
    interventionJudgeEnabled: Boolean(fileConfig?.runtime?.interventionJudgeEnabled ?? true),
    interventionJudgeMinSamples: Number(fileConfig?.runtime?.interventionJudgeMinSamples ?? 3),
    interventionJudgeWindowSize: Number(fileConfig?.runtime?.interventionJudgeWindowSize ?? 5),
    interventionJudgeAutoApplyLowRisk: Boolean(fileConfig?.runtime?.interventionJudgeAutoApplyLowRisk ?? false),
    interventionJudgeAiEnabled: Boolean(fileConfig?.runtime?.interventionJudgeAiEnabled ?? true),
    interventionJudgeAiTimeoutMs: Number(fileConfig?.runtime?.interventionJudgeAiTimeoutMs ?? 120000),
    interventionJudgeExecuteRollback: Boolean(fileConfig?.runtime?.interventionJudgeExecuteRollback ?? false),
    interventionJudgeAiModel: String(fileConfig?.runtime?.interventionJudgeAiModel || "").trim() || null,
    workerForbiddenPathPrefixes: Array.isArray(fileConfig?.runtime?.workerForbiddenPathPrefixes)
      ? fileConfig.runtime.workerForbiddenPathPrefixes.map((item) => String(item))
      : []
  };

  const gates = {
    ...(fileConfig.gates ?? {}),
    requireSecurityScan: env.requireSecurityScan
      ? ["1", "true", "yes", "on"].includes(env.requireSecurityScan.toLowerCase())
      : Boolean(fileConfig?.gates?.requireSecurityScan ?? true)
  };

  const derivedRoleModelMap = (() => {
    const map: Record<string, any> = {};
    const workers = fileConfig?.roleRegistry?.workers || {};
    for (const worker of Object.values(workers) as any[]) {
      const roleName = String(worker?.name || "").trim();
      const model = String(worker?.model || "").trim();
      if (roleName && model) {
        map[roleName] = model;
      }
    }

    const leadName = String(fileConfig?.roleRegistry?.leadWorker?.name || "").trim();
    const leadModel = String(fileConfig?.roleRegistry?.leadWorker?.model || "").trim();
    if (leadName && leadModel) {
      map[leadName] = leadModel;
    }

    return map;
  })();

  const copilotWithRolePolicy = {
    ...copilot,
    preferredModelsByRole: {
      ...derivedRoleModelMap,
      ...(copilot.preferredModelsByRole || {})
    }
  };

  const planner = {
    ...(fileConfig.planner ?? {}),
    useReviewerForPlanning: runtime.reviewerProvider === "copilot"
      ? Boolean(fileConfig?.planner?.useReviewerForPlanning ?? true)
      : Boolean(fileConfig?.planner?.useReviewerForPlanning ?? true),
    maxTasks: Number(fileConfig?.planner?.maxTasks ?? 0),
    enforceTrumpExecutionStrategy: Boolean(fileConfig?.planner?.enforceTrumpExecutionStrategy ?? true),
    defaultMaxWorkersPerWave: Number(fileConfig?.planner?.defaultMaxWorkersPerWave ?? 3),
    preferFewestWorkers: Boolean(fileConfig?.planner?.preferFewestWorkers ?? true),
    allowSameCycleFollowUps: Boolean(fileConfig?.planner?.allowSameCycleFollowUps ?? false),
    requireDependencyAwareWaves: Boolean(fileConfig?.planner?.requireDependencyAwareWaves ?? true),
    splitConflictingPlansAcrossBatches: Boolean(fileConfig?.planner?.splitConflictingPlansAcrossBatches ?? false)
  };

  const selfImprovement = {
    ...(fileConfig.selfImprovement ?? {}),
    enabled: Boolean(fileConfig?.selfImprovement?.enabled ?? true),
    maxReports: Number(fileConfig?.selfImprovement?.maxReports ?? 200),
    maxImprovementTasksPerCycle: Number(fileConfig?.selfImprovement?.maxImprovementTasksPerCycle ?? 3),
    enforceCoreModuleGuard: Boolean(fileConfig?.selfImprovement?.enforceCoreModuleGuard ?? true),
    coreProtectedModules: Array.isArray(fileConfig?.selfImprovement?.coreProtectedModules)
      ? fileConfig.selfImprovement.coreProtectedModules.map((item) => String(item))
      : [
          "src/core/orchestrator.js",
          "src/core/task_queue.js",
          "src/core/policy_engine.js"
        ],
    knowledgeMemoryEnabled: Boolean(fileConfig?.selfImprovement?.knowledgeMemoryEnabled ?? true),
    experimentEngineEnabled: Boolean(fileConfig?.selfImprovement?.experimentEngineEnabled ?? true)
  };

  const selfDev = {
    ...(fileConfig.selfDev ?? {}),
    enabled: Boolean(fileConfig?.selfDev?.enabled ?? false),
    recoveryTag: String(fileConfig?.selfDev?.recoveryTag || "box/recovery-v0.1.0-pre-selfdev"),
    maxFilesPerPr: Number(fileConfig?.selfDev?.maxFilesPerPr || 8),
    mandatoryGates: Array.isArray(fileConfig?.selfDev?.mandatoryGates)
      ? fileConfig.selfDev.mandatoryGates.map((item) => String(item)).filter(Boolean)
      : ["lint", "test"],
    forbiddenBranchTargets: Array.isArray(fileConfig?.selfDev?.forbiddenBranchTargets)
      ? fileConfig.selfDev.forbiddenBranchTargets.map((item) => String(item)).filter(Boolean)
      : ["main", "master"],
    branchPrefix: String(fileConfig?.selfDev?.branchPrefix || "box/selfdev-"),
    criticalFiles: Array.isArray(fileConfig?.selfDev?.criticalFiles)
      ? fileConfig.selfDev.criticalFiles.map((item) => String(item)).filter(Boolean)
      : [
          "src/core/orchestrator.ts",
          "src/core/daemon_control.ts",
          "src/core/policy_engine.ts",
          "src/cli.ts",
          ".env",
          ".env.sandbox",
          "policy.json"
        ],
    cautionFiles: Array.isArray(fileConfig?.selfDev?.cautionFiles)
      ? fileConfig.selfDev.cautionFiles.map((item) => String(item)).filter(Boolean)
      : [
          "src/core/athena_reviewer.ts",
          "src/core/janus_supervisor.ts",
          "src/core/prometheus.ts",
          "box.config.json",
          "package.json"
        ],
    protectedPrefixes: Array.isArray(fileConfig?.selfDev?.protectedPrefixes)
      ? fileConfig.selfDev.protectedPrefixes.map((item) => String(item)).filter(Boolean)
      : ["state/", ".git/", "node_modules/", ".next/"],
    futureModeFlags: {
      singleTargetDelivery: Boolean(fileConfig?.selfDev?.futureModeFlags?.singleTargetDelivery ?? true),
      targetSessionState: Boolean(fileConfig?.selfDev?.futureModeFlags?.targetSessionState ?? true),
      targetPromptOverlay: Boolean(fileConfig?.selfDev?.futureModeFlags?.targetPromptOverlay ?? true),
      targetWorkspaceLifecycle: Boolean(fileConfig?.selfDev?.futureModeFlags?.targetWorkspaceLifecycle ?? true),
    },
  };

  const systemGuardian = {
    ...(fileConfig.systemGuardian ?? {}),
    enabled: env.systemGuardianEnabled
      ? ["1", "true", "yes", "on"].includes(env.systemGuardianEnabled.toLowerCase())
      : Boolean(fileConfig?.systemGuardian?.enabled ?? true),
    cooldownMinutes: env.systemGuardianCooldownMinutes
      ? Number(env.systemGuardianCooldownMinutes)
      : Number(fileConfig?.systemGuardian?.cooldownMinutes ?? 30),
    trashTaskRatioThreshold: env.systemGuardianTrashTaskRatioThreshold
      ? Number(env.systemGuardianTrashTaskRatioThreshold)
      : Number(fileConfig?.systemGuardian?.trashTaskRatioThreshold ?? 0.35),
    repeatedFailureThreshold: env.systemGuardianRepeatedFailureThreshold
      ? Number(env.systemGuardianRepeatedFailureThreshold)
      : Number(fileConfig?.systemGuardian?.repeatedFailureThreshold ?? 4),
    orphanedCheckpointThreshold: env.systemGuardianOrphanedCheckpointThreshold
      ? Number(env.systemGuardianOrphanedCheckpointThreshold)
      : Number(fileConfig?.systemGuardian?.orphanedCheckpointThreshold ?? 4),
    staleWorkerMinutes: env.systemGuardianStaleWorkerMinutes
      ? Number(env.systemGuardianStaleWorkerMinutes)
      : Number(fileConfig?.systemGuardian?.staleWorkerMinutes ?? 20)
  };

  const cloudAssignment = {
    ...(fileConfig.cloudAssignment ?? {}),
    /** When true, BOX uses issue/PR-based dispatch (cloud agent assignment mode). */
    enabled: env.cloudAssignmentEnabled
      ? ["1", "true", "yes", "on"].includes(env.cloudAssignmentEnabled.toLowerCase())
      : Boolean(fileConfig?.cloudAssignment?.enabled ?? false),
    /** GitHub issue number to assign the worker task to (cloud mode). */
    issueNumber: env.cloudAssignmentIssue
      ? Number(env.cloudAssignmentIssue)
      : (fileConfig?.cloudAssignment?.issueNumber != null ? Number(fileConfig.cloudAssignment.issueNumber) : null),
    /** GitHub PR number to assign the worker task to (cloud mode). */
    prNumber: env.cloudAssignmentPr
      ? Number(env.cloudAssignmentPr)
      : (fileConfig?.cloudAssignment?.prNumber != null ? Number(fileConfig.cloudAssignment.prNumber) : null),
    /** How often (ms) to poll for completion when waiting for a cloud assignment. */
    pollIntervalMs: env.cloudAssignmentPollIntervalMs
      ? Number(env.cloudAssignmentPollIntervalMs)
      : Number(fileConfig?.cloudAssignment?.pollIntervalMs ?? 15000),
    /** Maximum wait time (ms) before declaring a cloud assignment timed out. */
    maxWaitMs: env.cloudAssignmentMaxWaitMs
      ? Number(env.cloudAssignmentMaxWaitMs)
      : Number(fileConfig?.cloudAssignment?.maxWaitMs ?? 3600000),
  };

  // Propagate resolved tokens into process.env so child Copilot/GitHub processes
  // always inherit the active account selected by the .env file.
  if (env.githubToken) {
    process.env.GITHUB_TOKEN = env.githubToken;
    process.env.GH_TOKEN = env.githubToken;
  }

  if (env.copilotGithubToken) {
    process.env.COPILOT_GITHUB_TOKEN = env.copilotGithubToken;
    process.env.GITHUB_FINEGRADED = env.copilotGithubToken;
  }

  return {
    rootDir,
    ...fileConfig,
    copilot: copilotWithRolePolicy,
    planner,
    selfImprovement,
    selfDev,
    systemGuardian,
    gates,
    git,
    runtime,
    env,
    cloudAssignment,
    paths: {
      progressFile: path.join(rootDir, fileConfig.progressFile || "state/progress.txt"),
      policyFile: path.join(rootDir, fileConfig.policyFile || "policy.json"),
      copilotSetupWorkflowFile: path.join(
        rootDir,
        fileConfig.paths?.copilotSetupWorkflowFile || ".github/workflows/copilot-setup-steps.yml"
      ),
      workspaceDir: path.join(rootDir, fileConfig.workspaceDir || ".box-work"),
      stateDir: path.join(rootDir, "state"),
      roadmapFile: path.join(rootDir, "state", "roadmap.json"),
      budgetFile: path.join(rootDir, fileConfig.paths?.budgetFile || "state/budget.json"),
      testsStateFile: path.join(rootDir, "state", "tests_state.json"),
      repoStateFile: path.join(rootDir, "state", "repo_state.json")
    }
  };
}

