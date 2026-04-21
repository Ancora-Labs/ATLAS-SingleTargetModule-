/**
 * Worker Runner — Single-Prompt Worker Sessions
 *
 * Each worker (King David, Esther, Aaron, etc.) has a conversation thread.
 * The orchestrator dispatches tasks via runWorkerConversation().
 *
 * The conversation history is passed as context on every call,
 * making it feel like a persistent session even though Copilot CLI is stateless.
 *
 * Workers use single-prompt mode (--agent only, no autopilot/allow-all):
 *   - 1 worker call = 1 premium request, tool calls within session are FREE
 *   - Worker uses tools to read/edit files, run commands, create PRs
 *   - Session management and status tracking are handled by the runner
 */

import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnAsync, writeJson } from "./fs_utils.js";
import { addSchemaVersion, STATE_FILE_TYPE } from "./schema_registry.js";
import { getRoleRegistry, assertRoleCapabilityForTask, isAthenaReviewOrPostmortemTask, normalizeTaskKindLabel } from "./role_registry.js";
import {
  appendProgress,
  appendLineageEntry,
  appendFailureClassification,
  resolveInterventionLineageJoinKey,
  resolveStableInterventionLineage,
  summarizePromptCacheTelemetryForScope,
  summarizeFailureFinishEvidenceForScope,
  type PromptCacheRoutingSignal,
  type FailureFinishEvidenceSignal,
  type InterventionLineageContract,
} from "./state_tracker.js";
import { buildAgentArgs, nameToSlug, readAgentPersona, resolveAgentExecutionProfile, resolveAgentSessionInputPolicy } from "./agent_loader.js";
import { buildVerificationChecklist, CANONICAL_VERIFICATION_REPORT_TEMPLATE } from "./verification_profiles.js";
import { getVerificationCommands, classifyNodeTestGlobWindowsArtifact } from "./verification_command_registry.js";
import { parseVerificationReport, parseResponsiveMatrix, validateWorkerContract, decideRework, checkPostMergeArtifact, collectArtifactGaps, isArtifactGateRequired, isDiscoverySafeTask, extractMergedSha, buildArtifactAuditEntry, buildReplayClosureEvidence, hasVerificationReportEvidence, hasCleanTreeStatusEvidence, parseToolExecutionTelemetry, checkCancellationAtVerification, auditRuntimeHookEnforcement } from "./verification_gate.js";
import {
  writeBoundaryCheckpoint,
  resetAttemptBoundary,
  CHECKPOINT_NS,
  WORKER_EXECUTION_PHASE,
  WORKER_EXECUTION_PHASE_ORDER,
  buildPhaseAwareAttemptCheckpoint,
  type WorkerExecutionPhase,
} from "./checkpoint_engine.js";
import {
  enforceModelPolicy,
  routeModelWithRealizedROI,
  appendRouteROIEntry,
  realizeRouteROIEntry,
  classifyComplexityTier,
  COMPLEXITY_TIER,
  decideDeliberationPolicy,
  assessRetryExpectedROI,
  QUALITY_FLOOR_DEFAULT,
  resolveModelCallSettingsOverlay,
  type DeliberationPolicy,
  type ScheduledHypothesisCandidate,
  type ModelCallSettingsOverlay,
} from "./model_policy.js";
import { deriveRoutingAdjustments, buildPromptHardConstraints } from "./learning_policy_compiler.js";
import { loadPolicy, getProtectedPathMatches, getRolePathViolations, enforcePreExecuteHookDecisions, auditAuthoritativeHookCoverage } from "./policy_engine.js";
import { compileRankedContextSection } from "./prompt_compiler.js";
import {
  scanProject,
  buildSemanticFileCandidatesFromScan,
  rankSemanticFileCandidates,
} from "./project_scanner.js";
import { buildPromptAssemblyPrompt } from "./prompt_overlay.js";
import {
  buildTargetExecutionWorkerContext,
  evaluateTargetExecutionBoundary,
  resolveWorkerExecutionCwd,
  resolveTargetExecutionContext,
} from "./target_execution_guard.js";
import { TARGET_SESSION_STAGE } from "./target_session_state.js";
import { appendEscalation, BLOCKING_REASON_CLASS, NEXT_ACTION, resolveEscalationsForTask } from "./escalation_queue.js";
import { buildTaskFingerprint, buildLineageId, LINEAGE_ENTRY_STATUS } from "./lineage_graph.js";
import { buildSpanEvent, EVENTS, EVENT_DOMAIN, SPAN_CONTRACT } from "./event_schema.js";
import { classifyFailure, classifyExitCode, buildFailureEnvelope, TERMINATION_CAUSE, FAILURE_CLASS } from "./failure_classifier.js";
import type { AttemptMeta } from "./failure_classifier.js";
import { resolveRetryAction, persistRetryMetric, RETRY_ACTION, RETRY_STRATEGY_SCHEMA_VERSION, DEFAULT_RETRY_POLICIES, buildAttemptArtifact, applyRetryROIGate, applyRetrySignalTuning } from "./retry_strategy.js";
import { filterMemoryEntriesByTrust, isPrivilegedMemoryRequester, buildMemoryHitRecord } from "./trust_boundary.js";
import type { MemoryHitRecord } from "./trust_boundary.js";
import { emitEvent } from "./logger.js";
import { parseDispatchBlockReasonContract } from "./cycle_analytics.js";
import { CancelledError } from "./daemon_control.js";
import type { CancellationToken } from "./daemon_control.js";

type WorkerRunnerConfig = {
  env?: Record<string, string | undefined>;
  paths?: {
    stateDir?: string;
  };
  [key: string]: unknown;
};

type PremiumUsageMeta = {
  outcome?: string;
  taskId?: string | number | null;
  /** Shared lineage key linking this premium request to lineage_graph and routing events. */
  lineageId?: string | null;
  /** Normalized lineage contract spanning dispatch, checkpoints, evidence, and analytics. */
  lineage?: InterventionLineageContract | null;
  /** Stable join key derived from the lineage contract. */
  lineageJoinKey?: string | null;
};

type WorkerRegistryEntry = {
  name?: string;
  model?: string;
  kind?: string;
  [key: string]: unknown;
};

function evaluateSelfDevProtectionBoundary(_input?: unknown, _config?: unknown) {
  return {
    active: false,
    allowed: true,
    warnings: [],
    blocked: [],
  };
}

function getSelfDevWorkerContext(_config?: unknown) {
  return "";
}

type TaskHints = {
  estimatedLines?: number;
  estimatedDurationMinutes?: number;
  complexity?: string;
};

type WorkerInstruction = {
  task?: string;
  context?: string;
  verification?: string;
  taskKind?: string;
  targetFiles?: string[];
  [key: string]: unknown;
};

type BenchmarkRecommendation = {
  implementationStatus?: string;
  benchmarkScore?: number | null;
  capacityGain?: number | null;
};

type RoutingAdjustment = {
  policyId: string;
  modelOverride: string;
  reason: string;
  severity: string;
};

type PromptHardConstraint = {
  policyId: string;
  constraint: string;
  blocking: boolean;
  severity: string;
};

type PromptControls = {
  tier?: string;
  hardConstraints?: PromptHardConstraint[];
  deliberationMode?: "single-pass" | "multi-attempt";
  searchBudget?: number;
  uncertaintyLevel?: DeliberationPolicy["uncertaintyLevel"];
  candidateFirstMoves?: ScheduledHypothesisCandidate[];
  recommendedFirstMove?: ScheduledHypothesisCandidate | null;
};

type WorkerActivityEntry = {
  at?: string;
  status?: string;
  task?: string;
  files?: string[];
  pr?: string;
  /** Wave number this activity entry belongs to, for wave-keyed completion tracking. */
  wave?: number | null;
};

type WorkerSessionState = {
  currentBranch?: string | null;
  createdPRs?: string[];
  filesTouched?: string[];
  activityLog?: WorkerActivityEntry[];
  [key: string]: unknown;
};

const POST_FINAL_OUTPUT_ABORT_REASON = "[ATLAS] Post-final-output grace expired";
const DEFAULT_FINAL_OUTPUT_EXIT_GRACE_MS = 30 * 1000;

const REFLECTION_MEMORY_FILE = "reflection_memory.json";
const MAX_REFLECTION_ENTRIES = 200;
const REFLECTION_MEMORY_SCHEMA_VERSION = 2;

function buildRetryEvidence(code, detail, source = "worker_output") {
  return {
    code: String(code || "unspecified"),
    detail: truncate(detail, 240),
    source: String(source || "worker_output"),
  };
}

function resolveVerificationFieldStatus(report: unknown, key: "build" | "tests") {
  const raw = String((report as any)?.[key] || "").toLowerCase().trim();
  return raw === "pass" || raw === "fail" || raw === "n/a" ? raw : null;
}

const UNSUPPORTED_UPSTREAM_CI_DEFERRAL_REASON = "unsupported_upstream_ci_deferral";

function detectUnsupportedUpstreamCiDeferral(
  output: string,
  details: {
    status: string;
    prUrl: string | null;
    mergedSha: string | null;
    hasBlockedAccess: boolean;
  },
): boolean {
  const normalizedStatus = String(details.status || "").toLowerCase().trim();
  if (!details.prUrl || details.mergedSha || details.hasBlockedAccess) return false;
  if (normalizedStatus !== "partial" && normalizedStatus !== "blocked") return false;

  const text = String(output || "");
  const hasCiFailureContext = /ci failed|failed check|checks failed|workflow log|github ci|required .*check|merge is blocked/i.test(text);
  const hasUpstreamDeferralClaim = /blocked upstream|unrelated to (?:this|the) change|same assertion(?:s)?|same failure(?:s)?|latest .*main.*fail(?:s|ed).*same|main ci run .*same/i.test(text);
  const hasExplicitExternalBlocker = /access_blocked|permission denied|\b(?:401|403|429|500|502|503|504)\b|rate limit|service unavailable|network error|dns|timed out|timeout|outage/i.test(text);

  return hasCiFailureContext && hasUpstreamDeferralClaim && !hasExplicitExternalBlocker;
}

function inferLegacyFailurePhase(entry): WorkerExecutionPhase {
  const text = `${String(entry?.reason || "")}\n${String(entry?.task || "")}\n${String(entry?.status || "")}`.toLowerCase();
  if (/git push|gh pr create|pull request|branch|clean tree|merged sha/.test(text)) return WORKER_EXECUTION_PHASE.PUSH;
  if (/build=|tests=|verification|npm test|npm run build|test failure|artifact gate/.test(text)) return WORKER_EXECUTION_PHASE.TEST;
  if (/apply_patch|edited|files touched|write code|fix code|src\\|tests\\/.test(text)) return WORKER_EXECUTION_PHASE.EDIT;
  return WORKER_EXECUTION_PHASE.PLAN;
}

function buildShadowExecutionDiscipline(instruction: WorkerInstruction, config: WorkerRunnerConfig): string {
  const executionContext = resolveTargetExecutionContext(config);
  if (!executionContext.active || executionContext.executionMode !== TARGET_SESSION_STAGE.SHADOW) {
    return "";
  }

  const scopedTargetFiles = Array.isArray(instruction?.targetFiles)
    ? instruction.targetFiles.map((file) => String(file || "").trim()).filter(Boolean)
    : [];

  const parts = [
    "## SHADOW MODE DELIVERY DISCIPLINE",
    "Shadow mode is exact-scope delivery. Stay inside the planner-declared file boundary.",
    "Do not add helpful extras, scaffolding, dependency manifests, lockfiles, tests, configs, folders, assets, or docs unless they are explicitly listed in targetFiles.",
    "If the requested outcome genuinely requires an extra file outside the allowlist, stop and report BOX_STATUS=partial with the exact missing file and why it is required.",
  ];

  if (scopedTargetFiles.length > 0) {
    parts.push(`Allowed target files only: ${scopedTargetFiles.join(", ")}`);
    parts.push("Any file outside this allowlist counts as a scope breach in shadow mode.");
  } else {
    parts.push("No explicit targetFiles allowlist was provided. Stay minimal and do not expand scope on your own.");
  }

  return parts.join("\n");
}

function buildPhaseStateMap() {
  return Object.fromEntries(
    WORKER_EXECUTION_PHASE_ORDER.map((phase) => [phase, { status: "pending", evidence: [] }]),
  ) as Record<string, { status: string; evidence: Array<{ code: string; detail: string; source: string }> }>;
}

function normalizeStoredRetryState(retryState, fallbackPhase: WorkerExecutionPhase = WORKER_EXECUTION_PHASE.PLAN) {
  if (!retryState || typeof retryState !== "object") return null;
  const phaseStates = buildPhaseStateMap();
  const rawPhaseStates = retryState.phaseStates && typeof retryState.phaseStates === "object"
    ? retryState.phaseStates
    : {};
  for (const phase of WORKER_EXECUTION_PHASE_ORDER) {
    const state = rawPhaseStates[phase] && typeof rawPhaseStates[phase] === "object"
      ? rawPhaseStates[phase]
      : {};
    phaseStates[phase] = {
      status: String((state as any).status || "pending"),
      evidence: Array.isArray((state as any).evidence)
        ? (state as any).evidence
          .filter((entry) => entry && typeof entry === "object")
          .slice(0, 6)
          .map((entry) => buildRetryEvidence((entry as any).code, (entry as any).detail, (entry as any).source))
        : [],
    };
  }
  const failedPhaseRaw = String(retryState.failedPhase || "").toLowerCase().trim();
  const currentPhaseRaw = String(retryState.currentPhase || "").toLowerCase().trim();
  const resumeFromPhaseRaw = String(retryState.resumeFromPhase || "").toLowerCase().trim();
  const lastCompletedPhaseRaw = String(retryState.lastCompletedPhase || "").toLowerCase().trim();
  const failedPhase = WORKER_EXECUTION_PHASE_ORDER.includes(failedPhaseRaw as any)
    ? failedPhaseRaw as WorkerExecutionPhase
    : fallbackPhase;
  const currentPhase = WORKER_EXECUTION_PHASE_ORDER.includes(currentPhaseRaw as any)
    ? currentPhaseRaw as WorkerExecutionPhase
    : failedPhase;
  const resumeFromPhase = WORKER_EXECUTION_PHASE_ORDER.includes(resumeFromPhaseRaw as any)
    ? resumeFromPhaseRaw as WorkerExecutionPhase
    : failedPhase;
  const lastCompletedPhase = WORKER_EXECUTION_PHASE_ORDER.includes(lastCompletedPhaseRaw as any)
    ? lastCompletedPhaseRaw as WorkerExecutionPhase
    : null;
  return {
    schemaVersion: Number(retryState.schemaVersion || 1),
    phaseOrder: [...WORKER_EXECUTION_PHASE_ORDER],
    currentPhase,
    failedPhase,
    resumeFromPhase,
    lastCompletedPhase,
    phaseStates,
    evidence: Array.isArray(retryState.evidence)
      ? retryState.evidence
        .filter((entry) => entry && typeof entry === "object")
        .slice(0, 8)
        .map((entry) => buildRetryEvidence((entry as any).code, (entry as any).detail, (entry as any).source))
      : [],
    mutation: retryState.mutation && typeof retryState.mutation === "object"
      ? {
          strategy: String((retryState.mutation as any).strategy || "resume_from_failed_phase"),
          instructions: Array.isArray((retryState.mutation as any).instructions)
            ? (retryState.mutation as any).instructions.slice(0, 4).map((item) => truncate(item, 200))
            : [],
        }
      : {
          strategy: "resume_from_failed_phase",
          instructions: [],
        },
  };
}

function normalizeReflectionMemoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const taskKind = String(entry.taskKind || "general");
  const taskSnippet = truncate(entry.taskSnippet || entry.task || "", 240);
  const taskFingerprint = String(entry.taskFingerprint || buildTaskFingerprint(taskKind, taskSnippet));
  const outcome = entry.outcome && typeof entry.outcome === "object"
    ? entry.outcome
    : {
        status: entry.status,
        retryAction: entry.retryAction,
        failureClass: entry.failureClass,
        recordedAt: entry.recordedAt,
      };
  const fallbackPhase = inferLegacyFailurePhase(entry);
  const retryState = normalizeStoredRetryState(entry.retryState, fallbackPhase) || {
    schemaVersion: 1,
    phaseOrder: [...WORKER_EXECUTION_PHASE_ORDER],
    currentPhase: fallbackPhase,
    failedPhase: fallbackPhase,
    resumeFromPhase: fallbackPhase,
    lastCompletedPhase: WORKER_EXECUTION_PHASE_ORDER.indexOf(fallbackPhase) > 0
      ? WORKER_EXECUTION_PHASE_ORDER[WORKER_EXECUTION_PHASE_ORDER.indexOf(fallbackPhase) - 1]
      : null,
    phaseStates: (() => {
      const phaseStates = buildPhaseStateMap();
      const failedIndex = WORKER_EXECUTION_PHASE_ORDER.indexOf(fallbackPhase);
      for (const [index, phase] of WORKER_EXECUTION_PHASE_ORDER.entries()) {
        if (index < failedIndex) phaseStates[phase].status = "completed";
        else if (index === failedIndex) phaseStates[phase] = {
          status: "failed",
          evidence: [buildRetryEvidence("legacy_reason", entry.reason || entry.summary || entry.task || "legacy failure", "legacy_memory")],
        };
      }
      return phaseStates;
    })(),
    evidence: [buildRetryEvidence("legacy_reason", entry.reason || entry.summary || entry.task || "legacy failure", "legacy_memory")],
    mutation: {
      strategy: "resume_from_failed_phase",
      instructions: [`Resume from the ${fallbackPhase} phase using the latest deterministic evidence.`],
    },
  };
  return {
    roleName: String(entry.roleName || ""),
    taskKind,
    taskFingerprint,
    taskSnippet,
    outcome: {
      status: String(outcome?.status || "unknown"),
      retryAction: outcome?.retryAction != null ? String(outcome.retryAction) : null,
      failureClass: outcome?.failureClass != null ? String(outcome.failureClass) : null,
      recordedAt: String(outcome?.recordedAt || entry.recordedAt || new Date(0).toISOString()),
    },
    retryState,
  };
}

function buildRetryMutationInstructions(failedPhase: WorkerExecutionPhase, details: {
  targetFiles: string[];
  filesTouched: string[];
  currentBranch?: string | null;
  prUrl?: string | null;
  buildStatus?: string | null;
  testsStatus?: string | null;
  dispatchBlockReason?: string | null;
}) {
  const instructions = [];
  if (details.targetFiles.length > 0) {
    instructions.push(`Keep scope anchored to: ${details.targetFiles.slice(0, 6).join(", ")}.`);
  }
  if (failedPhase === WORKER_EXECUTION_PHASE.PLAN) {
    instructions.push("Re-validate repo, tools, and scoped files before editing.");
    if (details.dispatchBlockReason) {
      instructions.push(`Resolve the recorded blocker first: ${truncate(details.dispatchBlockReason, 180)}.`);
    }
  } else if (failedPhase === WORKER_EXECUTION_PHASE.EDIT) {
    instructions.push("Inspect the last touched files before any new search.");
    if (details.filesTouched.length > 0) {
      instructions.push(`Resume edits from: ${details.filesTouched.slice(0, 6).join(", ")}.`);
    }
  } else if (failedPhase === WORKER_EXECUTION_PHASE.TEST) {
    instructions.push("Start by reproducing the recorded verification/build/test evidence before wider edits.");
    if (details.buildStatus) instructions.push(`Repair BUILD=${details.buildStatus} before entering push.`);
    if (details.testsStatus) instructions.push(`Repair TESTS=${details.testsStatus} before entering push.`);
  } else if (failedPhase === WORKER_EXECUTION_PHASE.PUSH) {
    if (details.dispatchBlockReason === UNSUPPORTED_UPSTREAM_CI_DEFERRAL_REASON) {
      instructions.push("Do not stop because main shows the same CI signature. Reproduce the failing PR check on your branch, patch it, rerun targeted verification, and push the repair to the existing PR.");
      instructions.push("Only report partial/blocked if an external outage or permission/access block prevents action, and cite that blocker exactly.");
    } else {
      instructions.push("Reuse the recorded branch/PR context and resolve git or clean-tree blockers before another push.");
    }
    if (details.currentBranch) instructions.push(`Continue from branch: ${details.currentBranch}.`);
    if (details.prUrl) instructions.push(`Update the existing PR instead of opening a duplicate: ${details.prUrl}.`);
  }
  if (instructions.length === 0) {
    instructions.push(`Resume from the ${failedPhase} phase using the latest deterministic evidence.`);
  }
  return instructions.slice(0, 4);
}

function buildPhaseAwareRetryState(input: {
  instruction: WorkerInstruction;
  parsed: Partial<ParsedWorkerResponse> & Record<string, unknown>;
  statusOverride?: string | null;
  retryAction?: string | null;
  failureClass?: string | null;
  verificationEvidence?: VerificationEvidence | null;
  failedPhaseOverride?: WorkerExecutionPhase | null;
}) {
  const parsed = input.parsed && typeof input.parsed === "object" ? input.parsed : {};
  const verificationEvidence = input.verificationEvidence || parsed.verificationEvidence || null;
  const report = verificationEvidence?.report || parsed.verificationReport || null;
  const buildStatus = resolveVerificationFieldStatus(report, "build");
  const testsStatus = resolveVerificationFieldStatus(report, "tests");
  const filesTouched = Array.isArray(parsed.filesTouched) ? parsed.filesTouched.map((file) => String(file || "")).filter(Boolean) : [];
  const targetFiles = Array.isArray(input.instruction?.targetFiles) ? input.instruction.targetFiles.map((file) => String(file || "")).filter(Boolean) : [];
  const currentBranch = parsed.currentBranch != null ? String(parsed.currentBranch) : null;
  const prUrl = parsed.prUrl != null ? String(parsed.prUrl) : null;
  const mergedSha = (parsed as any).mergedSha != null ? String((parsed as any).mergedSha) : null;
  const dispatchBlockReason = parsed.dispatchBlockReason != null ? String(parsed.dispatchBlockReason) : null;
  const fullOutput = String(parsed.fullOutput || parsed.summary || "");
  const status = String(input.statusOverride || parsed.status || "unknown").toLowerCase();
  const hasEditEvidence = filesTouched.length > 0;
  const hasTestEvidence =
    Boolean(verificationEvidence)
    || Boolean(parsed.verificationReport)
    || /===verification[_\s]?report===|===npm test output start===|npm test|npm run build|build=|tests=/i.test(fullOutput);
  const hasPushEvidence =
    Boolean(currentBranch || prUrl || mergedSha)
    || /git push|gh pr create|box_branch=|box_pr_url=|box_merged_sha=/i.test(fullOutput);
  const artifactDetail = verificationEvidence?.artifactDetail || null;
  const hasFailingVerification = buildStatus === "fail" || testsStatus === "fail";
  const hasPushArtifactGap = verificationEvidence?.passed === false && (
    artifactDetail?.hasSha === false
    || artifactDetail?.hasCleanTreeEvidence === false
    || artifactDetail?.hasTaskScopedCleanTreeEvidence === false
    || prUrl
    || currentBranch
  );
  const hasTestArtifactGap = verificationEvidence?.passed === false && (
    hasFailingVerification
    || (artifactDetail?.hasTestOutput === false && artifactDetail?.hasSha !== false && artifactDetail?.hasCleanTreeEvidence !== false)
  );
  const failedPhase = input.failedPhaseOverride
    || (
      status === "verification_failed"
      || hasFailingVerification
      || hasTestArtifactGap
        ? WORKER_EXECUTION_PHASE.TEST
        : hasPushArtifactGap
          ? WORKER_EXECUTION_PHASE.PUSH
          : hasPushEvidence && status !== "done" && status !== "success" && status !== "skipped"
            ? WORKER_EXECUTION_PHASE.PUSH
            : hasTestEvidence && status !== "done" && status !== "success" && status !== "skipped"
              ? WORKER_EXECUTION_PHASE.TEST
              : hasEditEvidence
                ? WORKER_EXECUTION_PHASE.EDIT
                : WORKER_EXECUTION_PHASE.PLAN
    );
  const failedIndex = WORKER_EXECUTION_PHASE_ORDER.indexOf(failedPhase);
  const highestReachedIndex = hasPushEvidence
    ? WORKER_EXECUTION_PHASE_ORDER.indexOf(WORKER_EXECUTION_PHASE.PUSH)
    : hasTestEvidence
      ? WORKER_EXECUTION_PHASE_ORDER.indexOf(WORKER_EXECUTION_PHASE.TEST)
      : hasEditEvidence
        ? WORKER_EXECUTION_PHASE_ORDER.indexOf(WORKER_EXECUTION_PHASE.EDIT)
        : WORKER_EXECUTION_PHASE_ORDER.indexOf(WORKER_EXECUTION_PHASE.PLAN);
  const phaseStates = buildPhaseStateMap();
  const evidence = [];
  const planEvidence = [];
  const editEvidence = [];
  const testEvidence = [];
  const pushEvidence = [];

  if (targetFiles.length > 0) {
    const item = buildRetryEvidence("target_files", targetFiles.slice(0, 6).join(", "), "instruction");
    evidence.push(item);
    planEvidence.push(item);
  }
  if (dispatchBlockReason) {
    const item = buildRetryEvidence("dispatch_block_reason", dispatchBlockReason, "dispatch_contract");
    evidence.push(item);
    if (failedPhase === WORKER_EXECUTION_PHASE.PLAN) planEvidence.push(item);
    if (failedPhase === WORKER_EXECUTION_PHASE.PUSH) pushEvidence.push(item);
  }
  if (input.failureClass) {
    evidence.push(buildRetryEvidence("failure_class", input.failureClass, "failure_classifier"));
  }
  if (input.retryAction) {
    evidence.push(buildRetryEvidence("retry_action", input.retryAction, "retry_strategy"));
  }
  if (filesTouched.length > 0) {
    const item = buildRetryEvidence("files_touched", filesTouched.slice(0, 6).join(", "), "worker_output");
    evidence.push(item);
    editEvidence.push(item);
  }
  if (buildStatus) {
    const item = buildRetryEvidence("build_status", `BUILD=${buildStatus}`, "verification_report");
    evidence.push(item);
    testEvidence.push(item);
  }
  if (testsStatus) {
    const item = buildRetryEvidence("tests_status", `TESTS=${testsStatus}`, "verification_report");
    evidence.push(item);
    testEvidence.push(item);
  }
  if (verificationEvidence?.gaps?.length) {
    const item = buildRetryEvidence("verification_gaps", verificationEvidence.gaps.slice(0, 2).join("; "), "verification_gate");
    evidence.push(item);
    testEvidence.push(item);
  }
  if (currentBranch) {
    const item = buildRetryEvidence("branch", currentBranch, "worker_output");
    evidence.push(item);
    pushEvidence.push(item);
  }
  if (prUrl) {
    const item = buildRetryEvidence("pr_url", prUrl, "worker_output");
    evidence.push(item);
    pushEvidence.push(item);
  }
  if (mergedSha) {
    const item = buildRetryEvidence("merged_sha", mergedSha, "worker_output");
    evidence.push(item);
    pushEvidence.push(item);
  }
  if (artifactDetail?.hasSha === false) {
    pushEvidence.push(buildRetryEvidence("missing_sha", "BOX_MERGED_SHA evidence missing", "verification_gate"));
  }
  if (artifactDetail?.hasCleanTreeEvidence === false && artifactDetail?.hasTaskScopedCleanTreeEvidence !== true) {
    pushEvidence.push(buildRetryEvidence("missing_clean_tree", "clean-tree evidence missing", "verification_gate"));
  }
  if (artifactDetail?.hasTestOutput === false) {
    testEvidence.push(buildRetryEvidence("missing_test_output", "raw npm test output missing", "verification_gate"));
  }

  for (const [index, phase] of WORKER_EXECUTION_PHASE_ORDER.entries()) {
    if (status === "done" || status === "success" || status === "skipped") {
      phaseStates[phase].status = index <= highestReachedIndex ? "completed" : "pending";
    } else if (index < failedIndex) {
      phaseStates[phase].status = "completed";
    } else if (index === failedIndex) {
      phaseStates[phase].status = "failed";
    } else {
      phaseStates[phase].status = "pending";
    }
  }

  phaseStates[WORKER_EXECUTION_PHASE.PLAN].evidence = planEvidence.slice(0, 4);
  phaseStates[WORKER_EXECUTION_PHASE.EDIT].evidence = editEvidence.slice(0, 4);
  phaseStates[WORKER_EXECUTION_PHASE.TEST].evidence = testEvidence.slice(0, 4);
  phaseStates[WORKER_EXECUTION_PHASE.PUSH].evidence = pushEvidence.slice(0, 4);

  return {
    schemaVersion: 1,
    phaseOrder: [...WORKER_EXECUTION_PHASE_ORDER],
    currentPhase: failedPhase,
    failedPhase,
    resumeFromPhase: failedPhase,
    lastCompletedPhase: failedIndex > 0 ? WORKER_EXECUTION_PHASE_ORDER[failedIndex - 1] : null,
    phaseStates,
    evidence: evidence.slice(0, 8),
    mutation: {
      strategy: "resume_from_failed_phase",
      instructions: buildRetryMutationInstructions(failedPhase, {
        targetFiles,
        filesTouched,
        currentBranch,
        prUrl,
        buildStatus,
        testsStatus,
        dispatchBlockReason,
      }),
    },
  };
}

async function persistPhaseAwareRetryArtifacts(config, input: {
  roleName: string;
  instruction: WorkerInstruction;
  status: string;
  retryAction?: string | null;
  failureClass?: string | null;
  retryState: Record<string, unknown>;
}) {
  await persistReflectionMemory(config, {
    roleName: input.roleName,
    taskKind: input.instruction.taskKind,
    task: String(input.instruction.task || ""),
    status: input.status,
    retryAction: input.retryAction || null,
    failureClass: input.failureClass || null,
    retryState: input.retryState,
  });
  const runtimeLineage = buildWorkerRuntimeLineage(input.instruction, {
    roleName: input.roleName,
  });
  const checkpointThreadId = String(runtimeLineage.checkpointThreadId || "");
  if (!checkpointThreadId) return;
  await writeBoundaryCheckpoint(
    config,
    buildPhaseAwareAttemptCheckpoint(input.retryState, {
      taskId: input.instruction.taskId != null ? String(input.instruction.taskId) : null,
      roleName: input.roleName,
      status: input.status,
      retryAction: input.retryAction || null,
      failureClass: input.failureClass || null,
      lineage: runtimeLineage.lineage,
      lineageJoinKey: runtimeLineage.lineageJoinKey,
    }),
    {
      thread_id: checkpointThreadId,
      checkpoint_ns: CHECKPOINT_NS.ATTEMPT,
    },
  );
}

export function loadReflectionMemoryContext(config, roleName, taskKind, taskText, failureClass?: string | null) {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, REFLECTION_MEMORY_FILE);
  if (!existsSync(filePath)) return "";
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    const entries = Array.isArray(raw?.entries)
      ? raw.entries.map(normalizeReflectionMemoryEntry).filter(Boolean)
      : [];
    const normalizedRole = String(roleName || "").toLowerCase().trim();
    const normalizedKind = String(taskKind || "").toLowerCase().trim();
    const taskNeedle = String(taskText || "").toLowerCase().trim();
    const taskFingerprint = buildTaskFingerprint(taskKind || "general", taskText || "");
    const normalizedFailureClass = String(failureClass || "").toLowerCase().trim();
    const relevant = entries.filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (String(entry?.roleName || "").toLowerCase().trim() !== normalizedRole) return false;
      if (normalizedKind && String(entry?.taskKind || "").toLowerCase().trim() !== normalizedKind) return false;
      if (
        normalizedFailureClass
        && entry?.outcome?.failureClass
        && String(entry.outcome.failureClass || "").toLowerCase().trim() !== normalizedFailureClass
      ) return false;
      if (!taskNeedle) return true;
      const entryFingerprint = String(entry?.taskFingerprint || "");
      if (taskFingerprint && entryFingerprint === taskFingerprint) return true;
      const snippet = String(entry?.taskSnippet || "").toLowerCase();
      return snippet.includes(taskNeedle.slice(0, Math.min(40, taskNeedle.length)))
        || taskNeedle.includes(snippet.slice(0, Math.min(40, snippet.length)));
    }).slice(-3);
    if (relevant.length === 0) return "";
    const bullets = relevant.map((entry, index) => {
      const retryState = entry.retryState || {};
      const evidence = Array.isArray(retryState.evidence)
        ? retryState.evidence.slice(0, 3).map((item) => `${item.code}=${item.detail}`).join("; ")
        : "none";
      const mutation = Array.isArray(retryState?.mutation?.instructions)
        ? retryState.mutation.instructions.slice(0, 3).map((item) => `   - ${item}`).join("\n")
        : "   - Resume from the recorded failed phase.";
      return [
        `${index + 1}. status=${entry?.outcome?.status || "unknown"} retryAction=${entry?.outcome?.retryAction || "none"} failedPhase=${retryState?.failedPhase || "unknown"} resumeFrom=${retryState?.resumeFromPhase || "plan"}`,
        `   evidence: ${evidence}`,
        "   mutate next attempt:",
        mutation,
      ].join("\n");
    }).join("\n");
    return `## RETRY STATE\nRecent same-lane retry state to mutate this attempt:\n${bullets}`;
  } catch {
    return "";
  }
}

async function persistReflectionMemory(config, input: {
  roleName: string;
  taskKind?: string;
  task: string;
  status: string;
  retryAction?: string | null;
  failureClass?: string | null;
  retryState?: Record<string, unknown> | null;
}) {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, REFLECTION_MEMORY_FILE);
  let payload: any = { schemaVersion: REFLECTION_MEMORY_SCHEMA_VERSION, updatedAt: null, entries: [] };
  try {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      if (raw && typeof raw === "object") payload = raw;
    }
  } catch {
    payload = { schemaVersion: REFLECTION_MEMORY_SCHEMA_VERSION, updatedAt: null, entries: [] };
  }
  const nextEntries = Array.isArray(payload?.entries) ? payload.entries : [];
  const recordedAt = new Date().toISOString();
  nextEntries.push({
    roleName: String(input.roleName || ""),
    taskKind: String(input.taskKind || "general"),
    taskFingerprint: buildTaskFingerprint(input.taskKind || "general", input.task || ""),
    taskSnippet: String(input.task || "").slice(0, 240),
    outcome: {
      status: String(input.status || "unknown"),
      retryAction: input.retryAction ? String(input.retryAction) : null,
      failureClass: input.failureClass ? String(input.failureClass) : null,
      recordedAt,
    },
    retryState: normalizeStoredRetryState(input.retryState, WORKER_EXECUTION_PHASE.PLAN),
  });
  payload = {
    schemaVersion: REFLECTION_MEMORY_SCHEMA_VERSION,
    updatedAt: recordedAt,
    entries: nextEntries.slice(-MAX_REFLECTION_ENTRIES),
  };
  await writeJson(filePath, payload);
}

function computeDynamicQualityFloor(config, taskHints: TaskHints = {}) {
  let floor = QUALITY_FLOOR_DEFAULT;
  const stateDir = config?.paths?.stateDir || "state";
  try {
    const analyticsPath = path.join(stateDir, "cycle_analytics.json");
    if (existsSync(analyticsPath)) {
      const raw = JSON.parse(readFileSync(analyticsPath, "utf8"));
      const latest = raw?.lastCycle || raw;
      const premiumEfficiency = Number(
        latest?.kpis?.executionAdjustedPremiumEfficiency
        ?? latest?.kpis?.rawPremiumEfficiency
        ?? latest?.executionAdjustedPremiumEfficiency
        ?? latest?.rawPremiumEfficiency
      );
      if (Number.isFinite(premiumEfficiency)) {
        if (premiumEfficiency < 0.35) floor += 0.08;
        else if (premiumEfficiency > 0.70) floor -= 0.05;
      }
    }
    const healthPath = path.join(stateDir, "cycle_health.json");
    if (existsSync(healthPath)) {
      const health = JSON.parse(readFileSync(healthPath, "utf8"));
      const anomalies = Array.isArray(health?.lastCycle?.anomalies) ? health.lastCycle.anomalies : [];
      const hasVerificationBreach = anomalies.some((item) => String(item?.metric || "") === "verificationCompletionMs");
      if (hasVerificationBreach) floor += 0.04;
    }
  } catch {
    // fail-open
  }
  if (String(taskHints?.complexity || "").toLowerCase() === "critical") floor += 0.03;
  return Math.max(0.5, Math.min(0.95, Math.round(floor * 1000) / 1000));
}

function estimateModelExpectedQuality(config, model) {
  const configured = config?.copilot?.qualityByModel;
  const key = String(model || "").toLowerCase();
  const fallback = {
    "claude haiku 4": 0.7,
    "claude haiku 4.5": 0.72,
    "claude sonnet 4.6": 0.85,
    "claude opus 4.6": 0.95,
    "gpt-5.4": 0.88,
  } as Record<string, number>;
  if (configured && typeof configured === "object") {
    const direct = Number(configured[model]);
    const normalized = Number(configured[key]);
    if (Number.isFinite(direct)) return Math.max(0, Math.min(1, direct));
    if (Number.isFinite(normalized)) return Math.max(0, Math.min(1, normalized));
  }
  return fallback[key] ?? 0.8;
}

function deriveOutcomeQualityScore(status: string, verificationEvidence: unknown, dispatchContract: any): number {
  const normalized = String(status || "unknown").toLowerCase();
  const hasEvidence = Boolean(verificationEvidence) || dispatchContract?.doneWorkerWithVerificationReportEvidence === true;
  if (normalized === "done" || normalized === "success") return hasEvidence ? 1 : 0.82;
  if (normalized === "partial") return hasEvidence ? 0.68 : 0.52;
  if (normalized === "blocked") return 0.18;
  return 0;
}

export function resolvePostVerificationTelemetryOutcome(
  status: unknown,
  reworkDecision?: { shouldRework?: boolean; shouldEscalate?: boolean } | null,
): string {
  const normalizedStatus = String(status || "unknown").trim().toLowerCase();
  if (reworkDecision?.shouldRework) return TERMINATION_CAUSE.VERIFICATION_FAILED;
  if (reworkDecision?.shouldEscalate && normalizedStatus === "done") return "blocked";
  return normalizedStatus || "unknown";
}

type SpawnAsyncResult = {
  status: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
};

type VerificationEvidence = {
  profile: string;
  hasReport: boolean;
  report: unknown;
  responsiveMatrix: unknown;
  prUrl: string | null;
  gaps: string[];
  passed: boolean;
  attempt: number;
  validatedAt: string;
  roleName: string;
  taskSnippet: string;
  /** Optional-field failures from the VERIFICATION_REPORT (tracked for calibration, not blocking). */
  optionalFieldFailures: string[];
  artifactDetail?: {
    hasSha: boolean;
    hasTestOutput: boolean;
    hasCleanTreeEvidence?: boolean;
    hasTaskScopedCleanTreeEvidence?: boolean;
    cleanTreeMode?: string;
    taskScopedCleanTargets?: string[];
    hasReplayAttachEvidence?: boolean;
    hasExplicitTestOutputBlock?: boolean;
    hasUnfilledPlaceholder: boolean;
    hasExplicitShaMarker: boolean;
    hasExplicitTestBlock: boolean;
    mergedSha: string | null;
  } | null;
  toolExecutionTelemetry?: unknown;
  hookCoverageAudit?: unknown;
};

type ParsedWorkerResponse = ReturnType<typeof parseWorkerResponse> & {
  verificationEvidence?: VerificationEvidence | null;
};

export function shouldRecordHookCoverageAudit(input: {
  telemetry?: {
    envelopes?: unknown[];
    hookDecisions?: unknown[];
    gaps?: unknown[];
    hasDeterministicCoverage?: boolean;
  } | null;
  runtimeDecisions?: unknown[];
  runtimeAuditGaps?: unknown[];
}): boolean {
  const telemetry = input?.telemetry;
  const envelopeCount = Array.isArray(telemetry?.envelopes) ? telemetry.envelopes.length : 0;
  const workerDecisionCount = Array.isArray(telemetry?.hookDecisions) ? telemetry.hookDecisions.length : 0;
  const telemetryGapCount = Array.isArray(telemetry?.gaps) ? telemetry.gaps.filter(Boolean).length : 0;
  const runtimeDecisionCount = Array.isArray(input?.runtimeDecisions) ? input.runtimeDecisions.length : 0;
  const runtimeAuditGapCount = Array.isArray(input?.runtimeAuditGaps) ? input.runtimeAuditGaps.filter(Boolean).length : 0;
  return telemetry?.hasDeterministicCoverage === true
    || envelopeCount > 0
    || workerDecisionCount > 0
    || telemetryGapCount > 0
    || runtimeDecisionCount > 0
    || runtimeAuditGapCount > 0;
}

type DispatchVerificationContract = {
  doneWorkerWithVerificationReportEvidence: boolean;
  doneWorkerWithCleanTreeStatusEvidence: boolean;
  dispatchBlockReason: string | null;
  dispatchBlockReasonContract: { code: string; detail: Record<string, unknown>; raw: string } | null;
  /** True when the worker's done-path output lacks required closure fields. */
  closureBoundaryViolation: boolean;
  replayClosure: {
    contractSatisfied: boolean;
    canonicalCommands: string[];
    executedCommands: string[];
    rawArtifactEvidenceLinks: string[];
  };
};

const ANALYTICS_COMPLETED_WORKER_STATUSES = new Set(["done", "success", "skipped"]);

export function isAnalyticsCompletedWorkerStatus(status: unknown): boolean {
  return ANALYTICS_COMPLETED_WORKER_STATUSES.has(String(status || "").toLowerCase());
}

const TERMINAL_WORKER_STATUSES = new Set([
  "done",
  "success",
  "skipped",
  "partial",
  "blocked",
  "error",
  "failed",
  "recovered",
]);

export function isTerminalWorkerStatus(status: unknown): boolean {
  return TERMINAL_WORKER_STATUSES.has(String(status || "").toLowerCase().trim());
}

export function shouldResolveRecoveredWorkerEscalations(status: unknown): boolean {
  const normalizedStatus = String(status || "").toLowerCase().trim();
  return normalizedStatus !== "blocked" && normalizedStatus !== "error" && normalizedStatus !== "transient_error";
}

// ── Span contract emitter ─────────────────────────────────────────────────────

/** Canonical agent identifier for workers in span events. */
export const WORKER_AGENT_ID = "worker";

export const WORKER_MODEL_CALL_HOOK = Object.freeze({
  SETTINGS_OVERLAY_RESOLVED: "settings_overlay_resolved",
  BEFORE_MODEL_CALL: "before_model_call",
  AFTER_MODEL_CALL: "after_model_call",
});

export type WorkerModelCallHook = (typeof WORKER_MODEL_CALL_HOOK)[keyof typeof WORKER_MODEL_CALL_HOOK];

export function emitWorkerModelCallHookEvent(
  hook: WorkerModelCallHook,
  roleName: string,
  model: string | null,
  lineageId: string | null,
  payload: Record<string, unknown> = {},
): void {
  emitEvent(
    EVENTS.POLICY_MODEL_SELECTED,
    EVENT_DOMAIN.POLICY,
    `model-hook-${String(roleName || "worker")}-${hook}-${Date.now()}`,
    {
      hook,
      roleName: String(roleName || "worker"),
      model: model ?? null,
      lineageId: lineageId ?? null,
      ...payload,
    },
  );
}

/**
 * Build a PLANNING_STAGE_TRANSITION span event for a worker.
 * Conforms to SPAN_CONTRACT: stamps spanId, parentSpanId, traceId, agentId.
 *
 * @param correlationId — non-empty cycle trace ID
 * @param stageFrom     — stage being left (one of ORCHESTRATION_LOOP_STEPS)
 * @param stageTo       — stage being entered
 * @param opts          — optional parentSpanId, durationMs, taskId
 * @returns validated event envelope
 */
export function emitWorkerSpanTransition(
  correlationId: string,
  stageFrom: string,
  stageTo: string,
  opts: { parentSpanId?: string | null; durationMs?: number | null; taskId?: string | null } = {},
) {
  return buildSpanEvent(
    EVENTS.PLANNING_STAGE_TRANSITION,
    EVENT_DOMAIN.PLANNING,
    correlationId,
    { agentId: WORKER_AGENT_ID, parentSpanId: opts.parentSpanId ?? null },
    {
      [SPAN_CONTRACT.stageTransition.taskId]:     opts.taskId ?? null,
      [SPAN_CONTRACT.stageTransition.stageFrom]:  stageFrom,
      [SPAN_CONTRACT.stageTransition.stageTo]:    stageTo,
      [SPAN_CONTRACT.stageTransition.durationMs]: opts.durationMs ?? null,
    },
  );
}

/**
 * Build a PLANNING_TASK_DROPPED span event for a worker (blocked/capacity-exhausted path).
 * Conforms to SPAN_CONTRACT.dropReason.
 *
 * @param correlationId  — non-empty cycle trace ID
 * @param taskId         — identifier of the dropped task
 * @param reason         — human-readable drop reason
 * @param dropCode       — machine code from SPAN_CONTRACT.dropCodes (defaults to CAPACITY_EXHAUSTED)
 * @param opts           — optional parentSpanId, stageWhenDropped
 * @returns validated event envelope
 */
export function emitWorkerSpanDrop(
  correlationId: string,
  taskId: string,
  reason: string,
  dropCode: string = SPAN_CONTRACT.dropCodes.CAPACITY_EXHAUSTED,
  opts: { parentSpanId?: string | null; stageWhenDropped?: string } = {},
) {
  return buildSpanEvent(
    EVENTS.PLANNING_TASK_DROPPED,
    EVENT_DOMAIN.PLANNING,
    correlationId,
    { agentId: WORKER_AGENT_ID, parentSpanId: opts.parentSpanId ?? null },
    {
      [SPAN_CONTRACT.dropReason.taskId]:           taskId,
      [SPAN_CONTRACT.dropReason.stageWhenDropped]: opts.stageWhenDropped ?? "workers_running",
      [SPAN_CONTRACT.dropReason.reason]:           reason,
      [SPAN_CONTRACT.dropReason.dropCode]:         dropCode,
    },
  );
}

// ── Premium usage tracking ──────────────────────────────────────────────────

function logPremiumUsage(
  config,
  roleName,
  model,
  taskKind,
  durationMs,
  { outcome, taskId, lineageId, lineage, lineageJoinKey }: PremiumUsageMeta = {},
) {
  const logPath = path.join(config.paths?.stateDir || "state", "premium_usage_log.json");
  let entries = [];
  try {
    if (existsSync(logPath)) {
      entries = JSON.parse(readFileSync(logPath, "utf8"));
      if (!Array.isArray(entries)) entries = [];
    }
  } catch { entries = []; }
  entries.push({
    worker: roleName,
    model,
    taskKind: taskKind || "general",
    startedAt: new Date(Date.now() - durationMs).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs,
    outcome: outcome || "unknown",
    taskId: taskId || null,
    lineageId: lineageId || null,
    lineage: lineage || null,
    lineageJoinKey: lineageJoinKey || resolveInterventionLineageJoinKey(lineage || null),
  });
  // Keep last 500 entries to prevent unbounded growth
  if (entries.length > 500) entries = entries.slice(-500);
  try { writeFileSync(logPath, JSON.stringify(entries, null, 2), "utf8"); } catch { /* non-critical */ }
}

/**
 * Resolve the lineage ID used to join worker dispatch telemetry, premium usage,
 * and cycle analytics.
 *
 * Priority:
 *   1) explicit instruction.lineageId
 *   2) inherited instruction.parentLineageId
 *   3) deterministic synthetic ID from task fingerprint + numeric taskId + attempt
 *
 * Returns null when no stable lineage key can be derived.
 */
export function resolveWorkerExecutionLineageId(instruction: any): string | null {
  const explicit = typeof instruction?.lineageId === "string" ? instruction.lineageId.trim() : "";
  if (explicit) return explicit;
  const embedded = typeof instruction?.lineage?.lineageId === "string"
    ? instruction.lineage.lineageId.trim()
    : typeof instruction?.lineageContract?.lineageId === "string"
      ? instruction.lineageContract.lineageId.trim()
      : "";
  if (embedded) return embedded;

  const parent = typeof instruction?.parentLineageId === "string" ? instruction.parentLineageId.trim() : "";
  if (parent) return parent;

  const rawTaskId = Number(instruction?.taskId);
  if (!Number.isInteger(rawTaskId) || rawTaskId <= 0) return null;

  const fingerprint = buildTaskFingerprint(instruction?.taskKind || "general", instruction?.task || "");
  const attempt = Number(instruction?.reworkAttempt || 0) + 1;
  return buildLineageId(fingerprint, rawTaskId, attempt);
}

function hasMeaningfulLineageContract(lineage: InterventionLineageContract): boolean {
  return Object.entries(lineage).some(([key, value]) => key !== "schemaVersion" && value !== null);
}

export function buildWorkerRuntimeLineage(
  instruction: any,
  defaults: {
    roleName?: string | null;
    model?: string | null;
    lane?: string | null;
    capability?: string | null;
    specialized?: boolean | null;
    rerouteReasonCode?: string | null;
  } = {},
): {
  lineage: InterventionLineageContract | null;
  lineageJoinKey: string | null;
  checkpointThreadId: string | null;
} {
  const taskKind = String(instruction?.taskKind || "general").trim() || "general";
  const taskText = String(instruction?.task || "").trim();
  const fallbackTaskIdentity = instruction?.semanticKey
    ? String(instruction.semanticKey).trim()
    : `${taskKind}::${buildTaskFingerprint(taskKind, taskText).slice(0, 24)}`;
  const { lineage, lineageJoinKey } = resolveStableInterventionLineage(
    instruction?.lineageContract ?? instruction?.lineage ?? instruction,
    {
      lineageId: resolveWorkerExecutionLineageId(instruction),
      taskId: instruction?.taskId != null ? String(instruction.taskId) : null,
      taskIdentity: fallbackTaskIdentity,
      cycleId: instruction?.cycleId ?? null,
      taskKind,
      interventionId: instruction?.interventionId ?? instruction?.taskId ?? null,
      promptFamilyKey: instruction?.promptFamilyKey ?? null,
      model: defaults.model ?? null,
      role: defaults.roleName ?? null,
      lane: defaults.lane ?? instruction?.lane ?? instruction?.effectiveLane ?? instruction?.capabilityLane ?? null,
      capability: defaults.capability ?? instruction?.capability ?? instruction?.capabilityTag ?? null,
      specialized: defaults.specialized ?? instruction?.specialized ?? null,
      rerouteReasonCode: defaults.rerouteReasonCode ?? instruction?.rerouteReasonCode ?? null,
    },
    {
      explicitJoinKey: instruction?.lineageJoinKey
        ?? instruction?.lineage?.lineageJoinKey
        ?? instruction?.lineageContract?.lineageJoinKey,
      taskKind,
      role: defaults.roleName ?? null,
    },
  );
  if (!hasMeaningfulLineageContract(lineage)) {
    return {
      lineage: null,
      lineageJoinKey: null,
      checkpointThreadId: null,
    };
  }
  return {
    lineage,
    lineageJoinKey,
    checkpointThreadId: lineageJoinKey || lineage.lineageId || lineage.taskId || lineage.taskIdentity || null,
  };
}

// ── Memory-hit telemetry ─────────────────────────────────────────────────────

const MEMORY_HIT_LOG_FILE = "memory_hit_log.json";
const MEMORY_HIT_LOG_MAX  = 200;

/**
 * Persist a MemoryHitRecord to state/memory_hit_log.json.
 * Sync write — mirrors logPremiumUsage. Never throws.
 */
function logMemoryHit(config: WorkerRunnerConfig, record: MemoryHitRecord): void {
  try {
    const logPath = path.join(config.paths?.stateDir || "state", MEMORY_HIT_LOG_FILE);
    let entries: MemoryHitRecord[] = [];
    try {
      if (existsSync(logPath)) {
        const parsed2 = JSON.parse(readFileSync(logPath, "utf8"));
        if (Array.isArray(parsed2)) entries = parsed2;
      }
    } catch { entries = []; }
    entries.push(record);
    if (entries.length > MEMORY_HIT_LOG_MAX) entries = entries.slice(-MEMORY_HIT_LOG_MAX);
    try { writeFileSync(logPath, JSON.stringify(entries, null, 2), "utf8"); } catch { /* non-critical */ }
  } catch { /* non-critical — telemetry must never block dispatch */ }
}

/**
 * Update the most-recent memory hit entry matching taskId with the worker's
 * final outcome.  Outcome mapping: ties the retrieval event to task completion.
 * Never throws.
 */
function updateMemoryHitOutcome(config: WorkerRunnerConfig, taskId: string | null, outcome: string): void {
  if (!taskId) return;
  try {
    const logPath = path.join(config.paths?.stateDir || "state", MEMORY_HIT_LOG_FILE);
    if (!existsSync(logPath)) return;
    let entries: MemoryHitRecord[] = [];
    try {
      const parsed2 = JSON.parse(readFileSync(logPath, "utf8"));
      if (Array.isArray(parsed2)) entries = parsed2;
    } catch { return; }
    // Update last matching entry whose outcome is still null (unresolved)
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as any;
      if (e && e.taskId === taskId && e.outcome === null) {
        e.outcome = outcome;
        break;
      }
    }
    try { writeFileSync(logPath, JSON.stringify(entries, null, 2), "utf8"); } catch { /* non-critical */ }
  } catch { /* non-critical */ }
}

/**
 * Compute the memory hit ratio from the most-recent log entries.
 *
 * A "hit" is defined as a record where at least one hint or lesson was injected
 * (hintsInjected + lessonsInjected > 0). Returns a value in [0, 1].
 * Returns 0 when no data exists (fail-open — callers treat 0 as "no signal").
 *
 * @param config — BOX config object
 * @param limit  — max entries to consider (default 50)
 */
export function computeMemoryHitRatio(config: WorkerRunnerConfig, limit = 50): number {
  try {
    const logPath = path.join(config.paths?.stateDir || "state", MEMORY_HIT_LOG_FILE);
    if (!existsSync(logPath)) return 0;
    const raw = JSON.parse(readFileSync(logPath, "utf8"));
    if (!Array.isArray(raw) || raw.length === 0) return 0;
    const recent = raw.slice(-limit);
    let hits = 0;
    for (const e of recent) {
      if (!e || typeof e !== "object") continue;
      const injected = Number((e as any).hintsInjected || 0) + Number((e as any).lessonsInjected || 0);
      if (injected > 0) hits++;
    }
    return recent.length > 0 ? hits / recent.length : 0;
  } catch {
    return 0;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text, max) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Compute a recent ROI proxy from the premium usage log for the given task kind.
 * Returns a value in [0, 1]: ratio of "done" outcomes in the last 10 matching entries.
 * Returns 0 when there is no history (fail-open — caller treats 0 as "no signal").
 */
function computeRecentROI(config, taskKind: string): number {
  try {
    const entries = loadPremiumUsageEntries(config);
    if (!Array.isArray(entries)) return 0;
    const relevant = entries
      .filter((e) => !taskKind || e.taskKind === taskKind)
      .slice(-10);
    if (relevant.length === 0) return 0;
    const successCount = relevant.filter((e) => e.outcome === "done").length;
    return successCount / relevant.length;
  } catch {
    return 0; // fail-open: absence of history must never block dispatch
  }
}

function computeOutcomeMetrics(config, taskKind: string) {
  try {
    const entries = loadPremiumUsageEntries(config);
    if (!Array.isArray(entries)) return { sampleCount: 0, successRate: 0, recentROI: 0 };
    const relevant = entries
      .filter((e) => !taskKind || e.taskKind === taskKind)
      .slice(-12);
    if (relevant.length === 0) return { sampleCount: 0, successRate: 0, recentROI: 0 };
    const successCount = relevant.filter((e) => String(e.outcome || "").toLowerCase() === "done").length;
    const successRate = successCount / relevant.length;
    return {
      sampleCount: relevant.length,
      successRate,
      recentROI: successRate,
    };
  } catch {
    return { sampleCount: 0, successRate: 0, recentROI: 0 };
  }
}

function loadPremiumUsageEntries(config): any[] {
  try {
    const logPath = path.join(config.paths?.stateDir || "state", "premium_usage_log.json");
    if (!existsSync(logPath)) return [];
    const entries = JSON.parse(readFileSync(logPath, "utf8"));
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

export async function computePromptCacheRoutingSignal(
  config: WorkerRunnerConfig,
  taskKind: string,
  roleName: string,
  lineage: { lineageId?: string | null; lineageJoinKey?: string | null } = {},
): Promise<PromptCacheRoutingSignal> {
  return summarizePromptCacheTelemetryForScope(config, {
    taskKind,
    role: roleName,
    lineageId: lineage.lineageId ?? null,
    lineageJoinKey: lineage.lineageJoinKey ?? null,
  });
}

export async function computeFailureFinishRoutingSignal(
  config: WorkerRunnerConfig,
  taskKind: string,
  roleName: string,
  lineage: { lineageId?: string | null; lineageJoinKey?: string | null } = {},
): Promise<FailureFinishEvidenceSignal> {
  return summarizeFailureFinishEvidenceForScope(config, {
    taskKind,
    role: roleName,
    lineageId: lineage.lineageId ?? null,
    lineageJoinKey: lineage.lineageJoinKey ?? null,
  });
}

export function deriveWorkerFinishCode(parsed: Partial<ParsedWorkerResponse> & Record<string, unknown>, fallbackCode: string | null = null): string {
  const dispatchBlockReason = String(parsed?.dispatchBlockReason || "").trim();
  if (dispatchBlockReason) return dispatchBlockReason;
  const report = parsed?.verificationReport;
  const buildStatus = resolveVerificationFieldStatus(report, "build");
  if (buildStatus === "fail") return "verification_report_fail:build";
  const testsStatus = resolveVerificationFieldStatus(report, "tests");
  if (testsStatus === "fail") return "verification_report_fail:tests";
  const status = String(parsed?.status || fallbackCode || "unknown").trim().toLowerCase();
  return status || "unknown";
}

function resolveAdaptiveRetryCap(failureClass: string, config: WorkerRunnerConfig): number {
  const policyOverride = (config as any)?.runtime?.adaptiveRetry?.[failureClass];
  const basePolicy = DEFAULT_RETRY_POLICIES[failureClass];
  const source = policyOverride && typeof policyOverride === "object"
    ? { ...basePolicy, ...policyOverride }
    : basePolicy;
  const cap = Number((source as any)?.escalateAfter ?? (source as any)?.maxRetries ?? (source as any)?.maxReworkAttempts ?? 3);
  return Number.isFinite(cap) ? Math.max(1, Math.floor(cap)) : 3;
}

function loadBenchmarkGroundTruthSignal(config) {
  try {
    const stateDir = config.paths?.stateDir || "state";
    const filePath = path.join(stateDir, "benchmark_ground_truth.json");
    if (!existsSync(filePath)) return null;
    const payload = JSON.parse(readFileSync(filePath, "utf8"));
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    const latest = entries.length > 0 ? entries[0] : null;
    if (!latest || !Array.isArray(latest.recommendations)) return null;
    return latest;
  } catch {
    return null;
  }
}

function analyzeBenchmarkReadiness(config, taskHints: TaskHints = {}) {
  const latest = loadBenchmarkGroundTruthSignal(config);
  const recommendations = Array.isArray(latest?.recommendations) ? latest.recommendations : [];
  if (recommendations.length === 0) return { hasSignal: false, unresolvedRatio: 0, avgScore: 0, avgGain: 0 };

  let unresolved = 0;
  let scoreCount = 0;
  let scoreSum = 0;
  let gainCount = 0;
  let gainSum = 0;
  for (const rec of recommendations as BenchmarkRecommendation[]) {
    const status = String(rec?.implementationStatus || "pending").toLowerCase();
    if (status !== "implemented" && status !== "implemented_correctly") unresolved++;
    const score = Number(rec?.benchmarkScore);
    if (Number.isFinite(score)) { scoreCount++; scoreSum += score; }
    const gain = Number(rec?.capacityGain);
    if (Number.isFinite(gain)) { gainCount++; gainSum += gain; }
  }

  const avgScore = scoreCount > 0 ? scoreSum / scoreCount : 0;
  const avgGain = gainCount > 0 ? gainSum / gainCount : 0;
  const unresolvedRatio = recommendations.length > 0 ? unresolved / recommendations.length : 0;

  const complexity = String(taskHints.complexity || "").toLowerCase();
  const hardTask = complexity === "critical" || complexity === "high" || Number(taskHints.estimatedLines || 0) >= 3000;
  const highUncertainty = hardTask && (
    unresolvedRatio >= 0.6 ||
    (avgScore > 0 && avgScore < 0.7) ||
    (avgGain > 0 && avgGain < 0.1)
  );

  return {
    hasSignal: true,
    unresolvedRatio: Math.round(unresolvedRatio * 1000) / 1000,
    avgScore: Math.round(avgScore * 1000) / 1000,
    avgGain: Math.round(avgGain * 1000) / 1000,
    highUncertainty,
  };
}

/**
 * Load compiled lesson-based policies from state/learned_policies.json.
 * Fail-open: returns [] on any read or parse error.
 */
function loadLearnedPolicies(config): any[] {
  try {
    const pPath = path.join(config.paths?.stateDir || "state", "learned_policies.json");
    if (!existsSync(pPath)) return [];
    const data = JSON.parse(readFileSync(pPath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return []; // non-critical; missing policy file must never block dispatch
  }
}

async function buildSemanticTaskContext(config, instruction): Promise<string> {
  try {
    const rootDir = resolveWorkerExecutionCwd(config);
    const scan = await scanProject({ rootDir });
    const candidates = buildSemanticFileCandidatesFromScan(scan);
    const retrievalQuery = [
      String(instruction?.task || ""),
      String(instruction?.context || ""),
      String(instruction?.verification || ""),
      String(instruction?.scope || ""),
    ].join("\n");
    const ranked = rankSemanticFileCandidates(retrievalQuery, candidates, {
      tokenBudget: 550,
      maxEntries: 8,
      cacheKey: `worker:${rootDir}:${String(instruction?.taskKind || "general")}:${retrievalQuery}`,
    });
    if (ranked.length === 0) return "";
    return compileRankedContextSection(
      "SEMANTIC RETRIEVAL CONTEXT (deterministic, token-budgeted)",
      ranked,
      { tokenBudget: 550, maxEntries: 8 },
    );
  } catch (err) {
    await appendProgress(
      config,
      `[WORKER][SEMANTIC_CONTEXT] retrieval skipped (non-fatal): ${String((err as any)?.message || err)}`
    );
    return "";
  }
}

function getLiveLogPath(config, roleName) {
  const stateDir = config.paths?.stateDir || "state";
  const safeRole = String(roleName || "worker").replace(/[^a-z0-9_-]+/gi, "_");
  return path.join(stateDir, `live_worker_${safeRole}.log`);
}

export function buildLiveWorkerLogStamp(config, roleName) {
  const currentMode = String(config?.platformModeState?.currentMode || "self_dev").trim() || "self_dev";
  const activeTargetSession = config?.activeTargetSession && typeof config.activeTargetSession === "object"
    ? config.activeTargetSession
    : null;
  const parts = [
    `mode=${currentMode}`,
    `role=${String(roleName || "worker")}`,
  ];
  if (currentMode === "single_target_delivery" && activeTargetSession?.projectId && activeTargetSession?.sessionId) {
    parts.push(`projectId=${String(activeTargetSession.projectId).trim()}`);
    parts.push(`sessionId=${String(activeTargetSession.sessionId).trim()}`);
  }
  return `[${parts.join(" ")}]`;
}

export function formatLiveWorkerLogChunk(config, roleName, text) {
  const stamp = buildLiveWorkerLogStamp(config, roleName);
  const chunks = String(text || "").replace(/\r\n/g, "\n").split("\n");
  return chunks.map((line, index) => {
    if (!line && index === chunks.length - 1) {
      return "";
    }
    return `${stamp} ${line}`;
  }).join("\n");
}

export async function captureRerereState(repoPath: string): Promise<string[]> {
  const rrCacheDir = path.join(repoPath, ".git", "rr-cache");
  const seen: string[] = [];

  async function walk(dirPath: string) {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(
        dirPath,
        { withFileTypes: true },
      ) as Array<{ name: string; isDirectory: () => boolean }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relative = path.relative(rrCacheDir, fullPath).replace(/\\/g, "/");
      seen.push(relative);
      if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  await walk(rrCacheDir);
  return seen.sort();
}

export function buildConflictReplayWorktreeName(conflictHash: string): string {
  const normalized = String(conflictHash || "replay")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `replay-${normalized || "default"}`;
}

export async function validateWorktreeCleanup(repoPath: string, worktreePath: string): Promise<{ cleaned: boolean; leakedState: string[] }> {
  const worktreeName = path.basename(String(worktreePath || "").replace(/[\\/]+$/, ""));
  const leakedState: string[] = [];
  try {
    await fs.access(worktreePath);
    leakedState.push(`worktree:${worktreePath}`);
  } catch {
    // cleaned from filesystem
  }
  const metadataDir = path.join(repoPath, ".git", "worktrees", worktreeName);
  try {
    await fs.access(metadataDir);
    leakedState.push(`git-metadata:${metadataDir}`);
  } catch {
    // cleaned from git metadata
  }
  return { cleaned: leakedState.length === 0, leakedState };
}

export async function runDeterministicConflictReplayRuntime(
  config: WorkerRunnerConfig,
  opts: { repoPath: string; baseRef?: string; commits?: string[]; conflictHash?: string },
): Promise<{
  ok: boolean;
  worktreePath: string | null;
  replayedCommits: string[];
  rerereEntriesBefore: string[];
  rerereEntriesAfter: string[];
  cleanup: { cleaned: boolean; leakedState: string[] };
  blockReason?: string;
}> {
  const repoPath = String(opts?.repoPath || "").trim();
  if (!repoPath) {
    return {
      ok: false,
      worktreePath: null,
      replayedCommits: [],
      rerereEntriesBefore: [],
      rerereEntriesAfter: [],
      cleanup: { cleaned: true, leakedState: [] },
      blockReason: "conflict_replay_missing_repo_path",
    };
  }

  const normalizedCommits = Array.isArray(opts?.commits)
    ? opts.commits.map((commit) => String(commit || "").trim()).filter(Boolean)
    : [];
  const replayHashSource = JSON.stringify({
    baseRef: String(opts?.baseRef || "HEAD"),
    commits: normalizedCommits,
    conflictHash: String(opts?.conflictHash || ""),
  });
  const replayHash = createHash("sha1").update(replayHashSource).digest("hex").slice(0, 12);
  const stateDir = String(config?.paths?.stateDir || path.join(repoPath, "state"));
  const worktreeRoot = path.join(stateDir, "conflict_replays");
  const worktreePath = path.join(worktreeRoot, buildConflictReplayWorktreeName(String(opts?.conflictHash || replayHash)));
  const rerereEntriesBefore = await captureRerereState(repoPath);
  const replayedCommits: string[] = [];

  await fs.mkdir(worktreeRoot, { recursive: true });

  try {
    await spawnAsync("git", ["worktree", "add", "--detach", worktreePath, String(opts?.baseRef || "HEAD")], { cwd: repoPath });
    await spawnAsync("git", ["config", "rerere.enabled", "true"], { cwd: worktreePath });

    for (const commit of normalizedCommits) {
      const result = await spawnAsync("git", ["cherry-pick", "--allow-empty", commit], { cwd: worktreePath }) as any;
      if (Number(result?.status || 0) !== 0) {
        await spawnAsync("git", ["cherry-pick", "--abort"], { cwd: worktreePath }).catch(() => {});
        const cleanup = await (async () => {
          await spawnAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath }).catch(() => {});
          await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
          return validateWorktreeCleanup(repoPath, worktreePath);
        })();
        const rerereEntriesAfter = await captureRerereState(repoPath);
        return {
          ok: false,
          worktreePath,
          replayedCommits,
          rerereEntriesBefore,
          rerereEntriesAfter,
          cleanup,
          blockReason: `conflict_replay_failed:${commit}`,
        };
      }
      replayedCommits.push(commit);
    }

    const rerereEntriesAfter = await captureRerereState(repoPath);
    await spawnAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath }).catch(() => {});
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    const cleanup = await validateWorktreeCleanup(repoPath, worktreePath);
    return {
      ok: true,
      worktreePath,
      replayedCommits,
      rerereEntriesBefore,
      rerereEntriesAfter,
      cleanup,
    };
  } catch (err) {
    await spawnAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath }).catch(() => {});
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    const cleanup = await validateWorktreeCleanup(repoPath, worktreePath);
    const rerereEntriesAfter = await captureRerereState(repoPath);
    return {
      ok: false,
      worktreePath,
      replayedCommits,
      rerereEntriesBefore,
      rerereEntriesAfter,
      cleanup,
      blockReason: String((err as any)?.message || err),
    };
  }
}

function roleToWorkerStateFile(roleName: unknown): string {
  const slug = String(roleName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `worker_${slug || "worker"}.json`;
}

function toLegacySessionsBody(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, any>;
  if (obj.workerSessions && typeof obj.workerSessions === "object" && !Array.isArray(obj.workerSessions)) {
    return obj.workerSessions as Record<string, any>;
  }
  if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
    return obj.data as Record<string, any>;
  }
  const clone = { ...obj };
  delete clone.schemaVersion;
  delete clone.updatedAt;
  delete clone.latestCycleId;
  delete clone.cycles;
  return clone;
}

async function persistLegacyWorkerSessionArtifacts(
  config: WorkerRunnerConfig,
  roleName: string,
  input: {
    phase: "start" | "complete";
    task?: string;
    status?: string;
    pr?: string | null;
    dispatchBlockReason?: string | null;
  }
): Promise<void> {
  try {
    const runtimeContext = (config ?? {}) as Record<string, any>;
    const platformModeState = runtimeContext.platformModeState as Record<string, any> | undefined;
    const activeTargetSession = runtimeContext.activeTargetSession as Record<string, any> | undefined;
    const stateDir = config.paths?.stateDir || "state";
    const nowIso = new Date().toISOString();

    const sessionsPath = path.join(stateDir, "worker_sessions.json");
    let sessions: Record<string, any> = {};
    try {
      if (existsSync(sessionsPath)) {
        sessions = toLegacySessionsBody(JSON.parse(readFileSync(sessionsPath, "utf8")));
      }
    } catch {
      sessions = {};
    }

    const existingSession = sessions[roleName] && typeof sessions[roleName] === "object"
      ? sessions[roleName]
      : {};

    if (input.phase === "start") {
      sessions[roleName] = {
        ...existingSession,
        status: "working",
        startedAt: nowIso,
        updatedAt: nowIso,
        mode: String(platformModeState?.currentMode || "self_dev"),
        projectId: String(activeTargetSession?.projectId || "").trim() || null,
        sessionId: String(activeTargetSession?.sessionId || "").trim() || null,
      };
    } else {
      sessions[roleName] = {
        ...existingSession,
        status: "idle",
        lastStatus: String(input.status || "unknown").toLowerCase(),
        updatedAt: nowIso,
        mode: String(platformModeState?.currentMode || existingSession.mode || "self_dev"),
        projectId: String(activeTargetSession?.projectId || existingSession.projectId || "").trim() || null,
        sessionId: String(activeTargetSession?.sessionId || existingSession.sessionId || "").trim() || null,
      };

      for (const [aliasRole, aliasSession] of Object.entries(sessions)) {
        if (aliasRole === roleName) continue;
        if (!aliasSession || typeof aliasSession !== "object") continue;
        if (String((aliasSession as any).resolvedRole || "") !== roleName) continue;
        if (String((aliasSession as any).status || "") !== "working") continue;
        sessions[aliasRole] = {
          ...(aliasSession as Record<string, unknown>),
          status: "idle",
          lastStatus: String(input.status || "unknown").toLowerCase(),
          updatedAt: nowIso,
        };
      }
    }

    await writeJson(
      sessionsPath,
      addSchemaVersion(sessions, STATE_FILE_TYPE.WORKER_SESSIONS),
    );

    const workerPath = path.join(stateDir, roleToWorkerStateFile(roleName));
    let workerState: Record<string, any> = {};
    try {
      if (existsSync(workerPath)) {
        const parsed = JSON.parse(readFileSync(workerPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          workerState = parsed as Record<string, any>;
        }
      }
    } catch {
      workerState = {};
    }

    const previousLog = Array.isArray(workerState.activityLog) ? workerState.activityLog : [];
    const entry = input.phase === "start"
      ? {
          at: nowIso,
          status: "working",
          task: String(input.task || ""),
          mode: String(platformModeState?.currentMode || "self_dev"),
          projectId: String(activeTargetSession?.projectId || "").trim() || null,
          sessionId: String(activeTargetSession?.sessionId || "").trim() || null,
        }
      : {
          at: nowIso,
          status: String(input.status || "unknown").toLowerCase(),
          task: String(input.task || ""),
          pr: input.pr || null,
          dispatchBlockReason: input.dispatchBlockReason || null,
          mode: String(platformModeState?.currentMode || workerState.mode || "self_dev"),
          projectId: String(activeTargetSession?.projectId || workerState.projectId || "").trim() || null,
          sessionId: String(activeTargetSession?.sessionId || workerState.sessionId || "").trim() || null,
        };

    await writeJson(workerPath, {
      ...workerState,
      status: input.phase === "start" ? "working" : "idle",
      startedAt: input.phase === "start" ? nowIso : (workerState.startedAt || null),
      updatedAt: nowIso,
      mode: String(platformModeState?.currentMode || workerState.mode || "self_dev"),
      projectId: String(activeTargetSession?.projectId || workerState.projectId || "").trim() || null,
      sessionId: String(activeTargetSession?.sessionId || workerState.sessionId || "").trim() || null,
      activityLog: [...previousLog, entry].slice(-200),
    });
  } catch {
    // Session artifact persistence is observability-only and must never block worker execution.
  }
}

async function appendLiveWorkerLog(config, logPath, roleName, text) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, formatLiveWorkerLogChunk(config, roleName, text), "utf8");
}

// ── Find worker config by role name ─────────────────────────────────────────

function findWorkerByName(config, roleName) {
  const registry = getRoleRegistry(config);
  const workers = registry?.workers || {};
  const normalize = (value: unknown) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const target = normalize(roleName);
  for (const [kind, worker] of Object.entries(workers) as Array<[string, WorkerRegistryEntry]>) {
    if (!worker?.name) continue;
    if (worker.name === roleName) return { kind, ...worker };
    if (normalize(worker.name) === target) return { kind, ...worker };
  }
  return null;
}

export function shouldEnableFullToolAccess(roleName: unknown, taskKind: unknown, taskText: unknown = ""): boolean {
  const agentSlug = nameToSlug(roleName);
  if (agentSlug) {
    const profile = resolveAgentExecutionProfile(agentSlug);
    if (profile.valid) return resolveAgentSessionInputPolicy(profile, "auto") === "allow_all";
  }
  const normalizedRole = String(roleName || "").trim().toLowerCase();
  const normalizedTaskKind = normalizeTaskKindLabel(taskKind);
  const registeredWorker = findWorkerByName({}, normalizedRole);
  if (registeredWorker) return true;
  const isImplementationTask = !normalizedTaskKind || normalizedTaskKind === "implementation";
  if (isImplementationTask) return true;
  if (normalizedRole === "evolution-worker") return true;
  return isAthenaReviewOrPostmortemTask(normalizedTaskKind, taskText);
}

export function evaluateWorkerRoleCapability(config, roleName: unknown, taskKind: unknown, taskText: unknown = "") {
  return assertRoleCapabilityForTask(config, roleName, taskKind, taskText);
}

/**
 * Apply trust classification and ranked filtering to knowledge-memory hints for prompt injection.
 *
 * Returns hints sorted high→medium, dropping LOW trust unless privilegedCaller=true.
 * Each returned entry is annotated with a `trust` metadata field.
 *
 * This is the canonical trust gate between knowledge_memory.json entries and the
 * worker prompt. Callers must not bypass this function to inject raw hints.
 *
 * @param hints           - raw hint/lesson entries from knowledge_memory.json
 * @param workerKind      - the worker's registered kind (e.g. "governance", "evolution")
 * @returns { selected, droppedLowTrustCount, isPrivileged }
 */
export function applyMemoryTrustFilter(
  hints: unknown[],
  workerKind: unknown,
): {
  selected: Array<Record<string, unknown> & { trust: { level: string; source: string; reason: string; taggedAt: string } }>;
  droppedLowTrustCount: number;
  isPrivileged: boolean;
} {
  const privilegedCaller = isPrivilegedMemoryRequester(workerKind);
  const { selected, droppedLowTrustCount } = filterMemoryEntriesByTrust(
    Array.isArray(hints) ? hints : [],
    { includeLowTrust: privilegedCaller, privilegedCaller },
  );
  return { selected, droppedLowTrustCount, isPrivileged: privilegedCaller };
}

// ── Repo contamination detection and recovery ────────────────────────────────

/** Patterns in worker output that indicate repo contamination (out-of-scope file modifications). */
const CONTAMINATION_INDICATORS = [
  /scope\s+violation/i,
  /unrelated\s+file/i,
  /modified\s+outside\s+(declared\s+)?scope/i,
  /git\s+checkout\s+--/i,
];

/**
 * Detect whether a worker's output indicates repo contamination — i.e., files
 * were modified outside the declared task scope.
 *
 * Returns isContamination=true when the summary text contains known contamination
 * markers OR when filesTouched contains entries that fall outside filesHint scope.
 *
 * @param summary      - worker summary text (may contain SCOPE VIOLATION markers)
 * @param filesTouched - files the worker reported touching
 * @param filesHint    - declared scope from the task (empty means "no scope declared")
 */
export function detectRepoContamination(
  summary: string,
  filesTouched: string[],
  filesHint: string[],
): { isContamination: boolean; unrelatedFiles: string[] } {
  const text = String(summary || "");
  const markerFound = CONTAMINATION_INDICATORS.some(r => r.test(text));

  let unrelatedFiles: string[] = [];
  if (Array.isArray(filesHint) && filesHint.length > 0
      && Array.isArray(filesTouched) && filesTouched.length > 0) {
    const normalizedHints = filesHint.map(h => h.replace(/\\/g, "/").toLowerCase());
    unrelatedFiles = filesTouched.filter(file => {
      const normalized = file.replace(/\\/g, "/").toLowerCase();
      return !normalizedHints.some(hint => {
        if (normalized === hint) return true;
        if (normalized.startsWith(hint.endsWith("/") ? hint : hint + "/")) return true;
        const hintBase = hint.replace(/\.(ts|js)$/, "");
        return normalized.includes(hintBase);
      });
    });
  }

  return {
    isContamination: markerFound || unrelatedFiles.length > 0,
    unrelatedFiles,
  };
}

/**
 * Attempt to recover branch cleanliness by reverting files outside the task scope.
 * Runs `git checkout -- <file>` for each file in filesToRecover.
 *
 * This is a best-effort, deterministic recovery: it retries up to maxAttempts times.
 * A blocked/partial closure is only permitted after all recovery attempts are exhausted.
 *
 * @param config         - runner config (used for path resolution context)
 * @param filesToRecover - files to revert via git checkout
 * @param maxAttempts    - max attempts before giving up (default 2)
 */
export async function attemptBranchCleanlinessRecovery(
  config: WorkerRunnerConfig,
  filesToRecover: string[],
  maxAttempts: number = 2,
): Promise<{ recovered: boolean; attemptsMade: number; errors: string[] }> {
  if (!Array.isArray(filesToRecover) || filesToRecover.length === 0) {
    return { recovered: true, attemptsMade: 0, errors: [] };
  }

  const errors: string[] = [];
  let attempt = 0;
  let pending = [...filesToRecover];
  const recoveryCwd = resolveWorkerExecutionCwd(config);

  while (attempt < maxAttempts && pending.length > 0) {
    attempt++;
    const failedThisAttempt: string[] = [];
    for (const file of pending) {
      try {
        const r = await spawnAsync("git", ["checkout", "--", file], {
          cwd: recoveryCwd,
          env: { ...process.env },
        }) as SpawnAsyncResult;
        if (r.status !== 0) {
          failedThisAttempt.push(file);
          errors.push(
            `[attempt ${attempt}] git checkout -- ${file} exit=${r.status}: ${String(r.stderr || "").slice(0, 80)}`
          );
        }
      } catch (e: unknown) {
        failedThisAttempt.push(file);
        errors.push(
          `[attempt ${attempt}] git checkout -- ${file}: ${String((e as Error)?.message || e).slice(0, 80)}`
        );
      }
    }
    pending = failedThisAttempt;
  }

  return { recovered: pending.length === 0, attemptsMade: attempt, errors };
}

// ── Task-aware model resolution ───────────────────────────────────────────────
// Priority: taskKind → role preference → worker model → uncertainty-aware routing → default
// Policy adjustments from compiled lessons may override the candidate after selection.

async function resolveModel(
  config,
  roleName,
  taskKind,
  taskHints: TaskHints = {},
  routingAdjustments: RoutingAdjustment[] = [],
  routingSignals: {
    promptCacheSignal?: PromptCacheRoutingSignal | null;
    failureFinishSignal?: FailureFinishEvidenceSignal | null;
  } = {},
) {
  const defaultModel = config?.copilot?.defaultModel || "Claude Sonnet 4.6";
  const strongModel = config?.copilot?.strongModel || defaultModel;
  const efficientModel = config?.copilot?.efficientModel || defaultModel;

  let candidate;
  // 1. Task-kind override (e.g. "scan" always uses GPT-5.3-Codex)
  if (taskKind) {
    const byKind = config?.copilot?.preferredModelsByTaskKind?.[taskKind];
    if (Array.isArray(byKind) && byKind.length > 0) candidate = byKind[0];
  }
  // 2. Role-specific preference
  if (!candidate) {
    const byRole = config?.copilot?.preferredModelsByRole?.[roleName];
    if (Array.isArray(byRole) && byRole.length > 0) candidate = byRole[0];
  }
  // 3. Worker's registered static model
  if (!candidate) {
    const workerConfig = findWorkerByName(config, roleName);
    if (workerConfig?.model) candidate = workerConfig.model;
  }
  // 4. Quality-floor-aware routing: combines uncertainty-aware routing with a minimum
  //    quality floor so the cheapest model that meets the floor is selected.
  //    Falls back to the strongest model when no candidate satisfies the floor.
  if (!candidate) {
    const recentROI = computeRecentROI(config, taskKind);
    const outcomeMetrics = computeOutcomeMetrics(config, taskKind);
    const promptCacheSignal = routingSignals.promptCacheSignal
      ?? await computePromptCacheRoutingSignal(config, taskKind, roleName);
    const failureFinishSignal = routingSignals.failureFinishSignal || null;
    const benchmarkSignal = analyzeBenchmarkReadiness(config, taskHints);
    const dynamicQualityFloor = computeDynamicQualityFloor(config, taskHints);
    const qualityFloorRoute = await routeModelWithRealizedROI(
      config,
      taskHints,
      { defaultModel, strongModel, efficientModel, qualityByModel: config?.copilot?.qualityByModel || {} },
      {
        qualityFloor: dynamicQualityFloor,
        promptCacheHitRate: promptCacheSignal.hitRate,
        promptCacheSavedTokens: promptCacheSignal.avgSavedTokens,
        lineageSignals: failureFinishSignal ? {
          lowRoiSignalCount: failureFinishSignal.lowRoiSignalCount,
          promptCacheHitRate: promptCacheSignal.hitRate,
          promptCacheSavedTokens: promptCacheSignal.avgSavedTokens,
          latestFailureClass: failureFinishSignal.latestFailureClass,
          latestFinishCode: failureFinishSignal.latestFinishCode,
          latestFinishStatus: failureFinishSignal.latestFinishStatus,
        } : undefined,
      },
    );
    candidate = qualityFloorRoute.model;
    if (
      benchmarkSignal.hasSignal &&
      benchmarkSignal.highUncertainty &&
      qualityFloorRoute.selectionPattern !== "constraint-first" &&
      qualityFloorRoute.selectionPattern !== "cooldown-stability" &&
      (qualityFloorRoute.tier === COMPLEXITY_TIER.T3 || String(taskHints.complexity || "").toLowerCase() === "critical")
    ) {
      candidate = strongModel;
      try {
        appendProgress(
          config,
          `[UNCERTAINTY_ESCALATION] ${roleName}: hard-task benchmark uncertainty -> ${strongModel} (avgScore=${benchmarkSignal.avgScore.toFixed(2)} avgGain=${benchmarkSignal.avgGain.toFixed(2)} unresolved=${benchmarkSignal.unresolvedRatio.toFixed(2)} sample=${outcomeMetrics.sampleCount})`
        );
      } catch { /* non-critical */ }
    }
    if (qualityFloorRoute.uncertainty !== "low" || !qualityFloorRoute.meetsQualityFloor || qualityFloorRoute.selectionPattern !== "balanced") {
      try {
        appendProgress(config,
          `[QUALITY_FLOOR_ROUTE] ${roleName}: tier=${qualityFloorRoute.tier} uncertainty=${qualityFloorRoute.uncertainty} pattern=${qualityFloorRoute.selectionPattern} meetsFloor=${qualityFloorRoute.meetsQualityFloor} realizedROI=${qualityFloorRoute.realizedROI.toFixed(2)} dynamicFloor=${dynamicQualityFloor.toFixed(2)} recentROI=${recentROI.toFixed(2)} cacheHitRate=${promptCacheSignal.hitRate.toFixed(2)} cacheSavedTokens=${promptCacheSignal.avgSavedTokens} → ${candidate}`
        );
      } catch { /* non-critical */ }
    }
  }

  // 5. Apply routing adjustments derived from compiled lesson policies.
  //    Recurring failure classes (e.g. syntax errors, import errors) override the
  //    complexity-based selection since model capability was NOT the root cause.
  const sonnetModel = config?.copilot?.sonnetModel || "Claude Sonnet 4.6";
  for (const adj of routingAdjustments) {
    if (adj.modelOverride === "force-sonnet") {
      const previous = candidate;
      // Use explicit Sonnet — not defaultModel, which may itself be Codex/Opus.
      // force-sonnet means "this failure class is tooling, not reasoning — Sonnet is sufficient".
      candidate = sonnetModel;
      if (String(previous || "") !== String(sonnetModel || "")) {
        try {
          appendProgress(config,
            `[POLICY_ROUTE] ${roleName}: ${previous} → ${sonnetModel} (policy=${adj.policyId}: ${adj.reason})`
          );
        } catch { /* non-critical */ }
      }
      break; // First critical policy override wins
    }
    if (adj.modelOverride === "block-opus" && /opus/i.test(String(candidate || ""))) {
      candidate = defaultModel;
      try {
        appendProgress(config,
          `[POLICY_ROUTE] ${roleName}: Opus blocked → ${defaultModel} (policy=${adj.policyId}: ${adj.reason})`
        );
      } catch { /* non-critical */ }
      break;
    }
  }

  // 6. Enforce model policy — ban fast/30x, gate Opus to large tasks
  const policy = enforceModelPolicy(candidate || defaultModel, taskHints, defaultModel);
  if (policy.downgraded) {
    try { appendProgress(config, `[MODEL_POLICY] ${roleName}: ${policy.reason}`); } catch { /* non-critical */ }
  }
  return policy.model;
}

// ── Build conversation-only context (persona is in .agent.md) ───────────────

export function buildConversationContext(history, instruction: WorkerInstruction, sessionState: WorkerSessionState = {}, config: WorkerRunnerConfig = {}, workerKind = null, promptControls: PromptControls = {}) {
  const parts = [];

  // Persistent worker state — always injected first so workers always know where they stand
  const targetRepo = config.env?.targetRepo || "(not set)";
  const branch = sessionState.currentBranch || null;
  const prs = Array.isArray(sessionState.createdPRs) ? sessionState.createdPRs : [];
  const filesTouchedAll = Array.isArray(sessionState.filesTouched) ? sessionState.filesTouched : [];
  const activityLog = Array.isArray(sessionState.activityLog) ? sessionState.activityLog : [];

  parts.push("## YOUR PERSISTENT STATE");
  parts.push(`Target Repo: ${targetRepo}`);
  if (branch) parts.push(`Current Branch: ${branch}`);
  if (prs.length > 0) parts.push(`PRs You Created: ${prs.slice(-5).join(", ")}`);
  if (filesTouchedAll.length > 0) {
    const shown = filesTouchedAll.slice(-10);
    const more = filesTouchedAll.length - shown.length;
    parts.push(`Files You've Worked On: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  parts.push("");

  if (activityLog.length > 0) {
    parts.push("## YOUR ACTIVITY LOG");
    activityLog.slice(-5).forEach(entry => {
      const date = entry.at ? entry.at.slice(0, 16).replace("T", " ") : "?";
      const files = Array.isArray(entry.files) && entry.files.length > 0
        ? ` | ${entry.files.slice(0, 4).join(", ")}` : "";
      const pr = entry.pr ? ` → PR ${entry.pr.split("/").pop()}` : "";
      parts.push(`[${date}] ${String(entry.status || "").toUpperCase().padEnd(8)} ${String(entry.task || "").slice(0, 80)}${pr}${files}`);
    });
    parts.push("");
  }

  // Inject knowledge memory lessons relevant to this worker.
  // Trust classification + ranked filtering is applied before injection:
  //   HIGH trust (system/deterministic): always included, shown first.
  //   MEDIUM trust (model-produced): always included.
  //   LOW trust (user-mediated free text): dropped unless caller is privileged.
  // Privileged callers (governance, system, janus) receive all trust levels with an
  // explicit [LOW-TRUST] label so they can assess and re-classify if needed.
  try {
    const kmPath = path.join(config.paths?.stateDir || "state", "knowledge_memory.json");
    if (existsSync(kmPath)) {
      const km = JSON.parse(readFileSync(kmPath, "utf8"));
      const privilegedCaller = isPrivilegedMemoryRequester(workerKind);

      const targetFiltered = Array.isArray(km.promptHints)
        ? km.promptHints.filter(h => {
            const target = String(h.targetAgent || "").toLowerCase();
            return target === "all" || target === "workers" || target === String(workerKind || "").toLowerCase();
          })
        : [];

      // Apply trust classification + ranked filtering (high→medium, drop low unless privileged)
      const { selected: trustedHints, droppedLowTrustCount: droppedHints } = filterMemoryEntriesByTrust(
        targetFiltered,
        { includeLowTrust: privilegedCaller, privilegedCaller },
      );

      const rawLessons = Array.isArray(km.lessons) ? km.lessons.slice(-5) : [];
      const { selected: trustedLessons, droppedLowTrustCount: droppedLessons } = filterMemoryEntriesByTrust(
        rawLessons,
        { includeLowTrust: privilegedCaller, privilegedCaller },
      );
      const filteredLessons = trustedLessons.filter(
        l => (l as any).severity === "critical" || (l as any).severity === "warning",
      );

      if (trustedHints.length > 0 || filteredLessons.length > 0) {
        parts.push("## SYSTEM LEARNINGS (from previous cycles)");
        for (const hint of trustedHints) {
          const h = hint as any;
          const trustLabel = hint.trust.level.toUpperCase();
          const lowNotice = hint.trust.level === "low" ? " [LOW-TRUST — verify before applying]" : "";
          parts.push(`- [${trustLabel}] ${h.hint} (reason: ${h.reason})${lowNotice}`);
        }
        for (const lesson of filteredLessons) {
          const l = lesson as any;
          const trustLabel = lesson.trust.level.toUpperCase();
          parts.push(`- [${trustLabel}] [${String(l.severity).toUpperCase()}] ${l.lesson}`);
        }
        if ((droppedHints + droppedLessons) > 0) {
          parts.push(`- [INFO] ${droppedHints + droppedLessons} low-trust hint(s) omitted (set privileged caller to include them).`);
        }
        parts.push("");
      }
    }
  } catch { /* knowledge memory not available yet — no-op */ }

  // Loop detection — inject a visible warning before history if the worker is stuck
  const myMessages = history.filter(m => {
    const from = String(m?.from || "").toLowerCase();
    return from !== "athena" && from !== "prometheus";
  });
  const recentOwn = myMessages.slice(-3);
  const allFailed = recentOwn.length >= 2 && recentOwn.every(m =>
    m.status === "error" || m.status === "blocked" ||
    String(m.content || "").toLowerCase().startsWith("error")
  );
  const repeatedContent = recentOwn.length >= 2 &&
    recentOwn.every(m => truncate(m.content, 120) === truncate(recentOwn[0].content, 120));

  if (repeatedContent) {
    parts.push("## ⚠️ LOOP DETECTED — YOU ARE REPEATING THE SAME OUTPUT");
    parts.push("Your last responses are identical. You are in a loop.");
    parts.push("MANDATORY: Stop completely. Do NOT repeat the same action.");
    parts.push("Step 1: Re-read the task from scratch — assume your previous understanding was wrong.");
    parts.push("Step 2: Pick a completely different implementation strategy.");
    parts.push("Step 3: If you genuinely cannot proceed differently, output BOX_STATUS=blocked with a root-cause analysis.");
    parts.push("");
  } else if (allFailed) {
    parts.push("## ⚠️ REPEATED FAILURE — CHANGE YOUR APPROACH");
    parts.push(`You have failed ${recentOwn.length} times in a row on this task. Your current approach is not working.`);
    parts.push("MANDATORY before continuing:");
    parts.push("  1. Identify WHY each previous attempt failed (permissions? missing deps? wrong file? wrong assumption?)");
    parts.push("  2. Form a NEW hypothesis about the root cause.");
    parts.push("  3. Apply a fundamentally different fix strategy.");
    parts.push("  4. If after this attempt it still fails, output BOX_STATUS=blocked with:");
    parts.push("     - All approaches you tried");
    parts.push("     - The exact error each time");
    parts.push("     - Evidence-based root cause analysis for why none of them worked");
    parts.push("");
  }

  if (history.length > 0) {
    parts.push("## CONVERSATION HISTORY");
    // Bounded session compaction: when history exceeds compactionThreshold, collapse
    // older messages into a single sentinel summary to reduce token pressure while
    // retaining full context for the most-recent turns.
    const compactionCfg = (config as any)?.workerRunContract?.sessionCompaction;
    const compactionEnabled = compactionCfg?.enabled !== false;
    const maxVerbatim = Number(compactionCfg?.maxHistoryMessages ?? 12);
    const compactionThreshold = Number(compactionCfg?.compactionThreshold ?? 20);
    let historyToShow: typeof history;
    if (compactionEnabled && history.length > compactionThreshold) {
      const olderCount = history.length - maxVerbatim;
      const sentinel = {
        from: "system",
        content: `[COMPACTED: ${olderCount} earlier message(s) summarized — recent ${maxVerbatim} messages shown verbatim below]`,
        timestamp: (history[olderCount - 1] as any)?.timestamp,
      };
      historyToShow = [sentinel, ...history.slice(-maxVerbatim)];
    } else {
      historyToShow = history.slice(-maxVerbatim);
    }
    for (const msg of historyToShow) {
      const from = String(msg?.from || "").toLowerCase();
      if (from === "athena" || from === "prometheus") {
        parts.push(`\nINSTRUCTION: ${truncate(msg.content, 600)}`);
      } else {
        parts.push(`\nYOU (${msg.from}): ${truncate(msg.content, 800)}`);
      }
    }
    parts.push("");
  }

  parts.push("## NEW INSTRUCTION");
  parts.push("Treat this instruction as an execution brief: objective, constraints, and success criteria.");
  parts.push("You own the method. If a better implementation order or safer approach exists, use it and explain why in your summary.");
  parts.push("Do not follow literal step ordering if repository reality suggests a stronger senior-level approach.");
  parts.push("\n## EXECUTION INTEGRITY PROTOCOL");
  parts.push("1) Verify access before acting. Validate: target repo path, required files, required tools, and required remote/API access.");
  parts.push("2) Never guess. Do not use assumed/projected facts when evidence is missing. If you need data, fetch it.");
  parts.push("3) If anything is inaccessible, do not improvise. Report the exact blocker with evidence.");
  parts.push("4) If you choose an alternative path, include impact analysis: correctness risk, scope impact, rollback, and whether it is a permanent fix or temporary workaround.");
  parts.push("5) Prefer permanent deterministic fixes over temporary bypasses.");
  parts.push("6) PR ownership is yours end-to-end: create/update your PR for your task, monitor GitHub checks, fix failures you see, and when checks are green merge it yourself.");
  parts.push("7) If checks remain pending, keep watching until green or report the exact failing/pending checks.");
  parts.push("8) A red PR is NOT resolved by saying main is red too. If your PR checks fail, reproduce the failing branch check, patch what is actionable on your branch, rerun targeted verification, and update the same PR. Only stop as partial/blocked when an external outage, permission block, or missing access prevents action, and cite that blocker explicitly.");

  parts.push("\n## INDEPENDENT THINKING — VERIFY YOUR ORDERS");
  parts.push("You are a senior engineer, not a blind executor. Before implementing your instructions:");
  parts.push("1) EVALUATE the plan: Does this instruction make technical sense for the codebase? Is it the right approach?");
  parts.push("2) CHECK for conflicts: Will this change break something that's already working? Does it conflict with other workers' work?");
  parts.push("3) VALIDATE scope: Is the instruction appropriately scoped for this project type? (Don't add enterprise security to a portfolio site, don't skip auth on a SaaS app)");
  parts.push("4) CHALLENGE if wrong: If the instruction contains a technical error, an incorrect assumption, or a suboptimal approach:");
  parts.push("   - State what's wrong and why");
  parts.push("   - Propose the correct approach");
  parts.push("   - Implement the CORRECT version, not the flawed instruction");
  parts.push("   - Document your reasoning in the summary");
  parts.push("5) ENHANCE if possible: If you see an obviously better way to achieve the goal that the plan didn't consider, do it the better way.");
  parts.push("6) NEVER blindly execute instructions that would:");
  parts.push("   - Break existing passing tests");
  parts.push("   - Remove functionality that's currently working");
  parts.push("   - Add unnecessary complexity for the project type");
  parts.push("   - Introduce security vulnerabilities");
  parts.push("You own the quality of YOUR output. Execute at a senior engineering level — methodology is yours.");
  parts.push("\n## WORK QUALITY MANDATE");
  parts.push("Each premium request costs real money. You MUST deliver complete, correct, production-quality work in this single request.");
  parts.push("- Write exactly as much code as the task requires — no more, no less.");
  parts.push("- Prefer focused, targeted changes that solve the problem cleanly over large rewrites.");
  parts.push("- Complete your ENTIRE assigned task in one shot — do not leave partial work for a follow-up request.");
  parts.push("- If your task involves multiple files, fix ALL of them before reporting done.");
  parts.push("- Senior production standard: correct logic, proper error handling, edge cases handled, tests where relevant.");
  parts.push("\n## TOOL EXECUTION GOVERNANCE");
  parts.push("Use tools directly when needed to complete the task.");
  parts.push("Runtime policy and hook enforcement are applied automatically by the runner.");
  parts.push("Do not print TOOL_INTENT or HOOK_DECISION pseudo-telemetry lines in your response.");

  // Canonical verification commands from the central registry
  const verifCmds = getVerificationCommands(config);
  parts.push("\n## CANONICAL VERIFICATION COMMANDS");
  parts.push(`Use these exact commands for verification (do NOT invent shell globs):`);
  parts.push(`  Test:  ${verifCmds.test}`);
  parts.push(`  Lint:  ${verifCmds.lint}`);
  parts.push(`  Build: ${verifCmds.build}`);
  parts.push("\n## TEST SCOPE POLICY (REQUIRED)");
  parts.push("Run ONLY tests that are directly related to your change set (targeted tests).");
  parts.push("Do NOT run the full repository test suite unless the task explicitly requires full-suite validation.");
  parts.push("If no specific test target is provided, infer the smallest relevant test set from touched files and verification commands.");
  parts.push("In your evidence, state exactly which targeted tests you ran and why they are sufficient for this task.");

  // Prompt tier budget — informs the worker how much reasoning depth is expected.
  // T3 (architectural): deep think required, critic mandatory, multi-pass.
  // T2 (medium): two-pass, moderate reasoning.
  // T1 (routine): lean, direct implementation — no extra passes needed.
  const tier = promptControls.tier;
  if (tier === COMPLEXITY_TIER.T3) {
    parts.push("\n## PROMPT TIER BUDGET — T3 (ARCHITECTURAL)");
    parts.push("This task is classified as T3: deep architectural reasoning required.");
    parts.push("- Mandatory: multi-pass reasoning (design → implement → verify → critique).");
    parts.push("- Perform a critic step before finalising: challenge your own solution.");
    parts.push("- Verify all edge cases explicitly before reporting done.");
    parts.push("- Budget: up to 5 continuation passes if needed.");
  } else if (tier === COMPLEXITY_TIER.T2) {
    parts.push("\n## PROMPT TIER BUDGET — T2 (MEDIUM)");
    parts.push("This task is classified as T2: two-pass reasoning expected.");
    parts.push("- Implement first, then verify the result before reporting done.");
    parts.push("- Budget: up to 3 continuation passes if needed.");
  }
  // T1: no tier section — keep the prompt lean for routine patches.

  // Role-based verification — inject requirements specific to this worker's kind
  if (workerKind) {
    parts.push("");
    parts.push(buildVerificationChecklist(workerKind));
  } else {
    // Fallback for unknown roles — basic verification
    parts.push("\n## SELF-VERIFICATION PROTOCOL");
    parts.push("Before reporting done, verify your work: run build, run tests, check edge cases.");
    parts.push("Include this exact verification report block and replace placeholders:");
    parts.push("```");
    parts.push(CANONICAL_VERIFICATION_REPORT_TEMPLATE);
    parts.push("```");
  }

  // Hard constraints from compiled lesson policies — injected prominently so the
  // model cannot silently violate them. Blocking constraints cause immediate rework
  // if violated. Violation is detected via the verification gate at post-task review.
  const hardConstraints = Array.isArray(promptControls.hardConstraints) ? promptControls.hardConstraints : [];
  if (hardConstraints.length > 0) {
    parts.push("\n## HARD CONSTRAINTS (enforced from prior cycle lessons — violations trigger rework)");
    for (const hc of hardConstraints) {
      const blockLabel = hc.blocking ? " [BLOCKING]" : "";
      parts.push(`${hc.constraint}${blockLabel}`);
    }
  }

  if (promptControls.deliberationMode === "multi-attempt") {
    const searchBudget = Number(promptControls.searchBudget || 0);
    const uncertaintyLevel = String(promptControls.uncertaintyLevel || "high");
    const candidateFirstMoves = Array.isArray(promptControls.candidateFirstMoves)
      ? promptControls.candidateFirstMoves
      : [];
    const recommendedFirstMove = promptControls.recommendedFirstMove ?? candidateFirstMoves[0] ?? null;
    parts.push("\n## SELECTIVE DELIBERATION POLICY");
    parts.push("This task is high-uncertainty. Use bounded multi-attempt reasoning:");
    parts.push(`Uncertainty classification: ${uncertaintyLevel}.`);
    parts.push("1) Attempt 1: initial implementation pass.");
    parts.push("2) Attempt 2+: reflect on failure signals and revise plan before edits.");
    if (searchBudget > 0) {
      parts.push(`3) Bounded search budget: at most ${searchBudget} focused repository searches before coding.`);
    }
    if (recommendedFirstMove?.summary) {
      parts.push(`Recommended first move: ${recommendedFirstMove.summary}`);
    }
    if (candidateFirstMoves.length > 0) {
      parts.push("Candidate first moves scored with cheap verification signals:");
      for (const [index, candidate] of candidateFirstMoves.entries()) {
        const score = Number.isFinite(Number(candidate?.score)) ? ` [score=${Number(candidate.score).toFixed(3)}]` : "";
        const cheapSignals = Array.isArray(candidate?.cheapSignals) && candidate.cheapSignals.length > 0
          ? ` — cheap signals: ${candidate.cheapSignals.join("; ")}`
          : "";
        parts.push(`${index + 1}) ${candidate.summary}${score}${cheapSignals}`);
      }
    }
    parts.push("Do not loop indefinitely; converge to a concrete implementation or explicit blocker.");
  }

  const selfDevContract = evaluateSelfDevProtectionBoundary({}, config);
  if (selfDevContract.active) {
    parts.push("");
    parts.push(buildPromptAssemblyPrompt({ agentName: "worker", config }));
    parts.push("");
    parts.push(getSelfDevWorkerContext(config));
  }

  const targetExecutionContext = buildTargetExecutionWorkerContext(config);
  if (targetExecutionContext) {
    parts.push("");
    parts.push(targetExecutionContext);
  }

  const shadowExecutionDiscipline = buildShadowExecutionDiscipline(instruction, config);
  if (shadowExecutionDiscipline) {
    parts.push("");
    parts.push(shadowExecutionDiscipline);
  }

  parts.push("\n## OUTPUT FORMAT");
  parts.push("Think deeply and work naturally. Write your full reasoning, analysis, and implementation details.");
  parts.push("At the END of your response, include these REQUIRED machine-readable markers:");
  parts.push("BOX_STATUS=<done|partial|blocked|error>  ← REQUIRED — do NOT omit");
  parts.push("BOX_PR_URL=<url>   (required when you created/updated a PR)");
  parts.push("BOX_BRANCH=<name>  (required when you created/switched a branch)");
  parts.push("BOX_FILES_TOUCHED=<comma-separated list>  (files you edited/created)");
  parts.push("BOX_ACCESS=repo:<ok|blocked>;files:<ok|blocked>;tools:<ok|blocked>;api:<ok|blocked>  (if you encountered access issues)");
  parts.push("PR POLICY: If your task changes code, open or update your PR and carry it to merge when checks are green.");

  // Mandatory completion gate checklist injected immediately before the task so the
  // model sees it right before the work description and again when writing its response.
  // Omitting any item → verification gate rejects the done status and triggers rework.
  if (!isDiscoverySafeTask(instruction.taskKind)) {
    // Extract specific test file paths from the plan's verification field so workers
    // run only the tests relevant to their changes — not the full 1000+ test suite.
    const targetTestFiles = (() => {
      const verText = String(instruction.verification || "");
      const testFileRe = /(?:^|\d+\.\s*)(tests\/[^\s—\-–|\n\r]+(?:\.test\.ts|\.test\.js))/gm;
      const found = new Set<string>();
      let m;
      while ((m = testFileRe.exec(verText)) !== null) found.add(m[1].trim());
      return [...found];
    })();
    const testRunCmd = targetTestFiles.length > 0
      ? `npm test -- ${targetTestFiles.join(" ")}`
      : "npm test -- tests/core/<module>.test.ts";
    const scopedTargetFiles = Array.isArray(instruction.targetFiles)
      ? instruction.targetFiles.map((file) => String(file || "").trim()).filter(Boolean)
      : [];
    parts.push("");
    parts.push("## ⛔ MANDATORY COMPLETION GATE — CHECK BEFORE WRITING BOX_STATUS=done");
    parts.push("At the end of your response, you MUST include ALL four of these — the gate scans for them literally:");
    parts.push("  ✓ BOX_MERGED_SHA=<actual sha>            ← run: git rev-parse HEAD after merge");
    parts.push("  ✓ CLEAN_TREE_STATUS=clean                ← run: git status --porcelain when the whole repo is clean");
    if (scopedTargetFiles.length > 0) {
      parts.push("    OR, when unrelated files keep the shared repo dirty, include this exact alternate evidence:");
      parts.push("      CLEAN_TREE_STATUS=dirty-other-tasks-only");
      parts.push("      TASK_SCOPED_CLEAN_STATUS=clean");
      parts.push(`      TASK_SCOPED_CLEAN_TARGETS=${scopedTargetFiles.join(", ")}`);
      parts.push(`      ← prove with: git status --porcelain -- ${scopedTargetFiles.join(" ")}`);
    }
    parts.push(`  ✓ ===NPM TEST OUTPUT START===            ← run: ${testRunCmd}`);
    parts.push("    <paste full raw test stdout here>");
    parts.push("    ===NPM TEST OUTPUT END===");
    parts.push("  ✓ ===VERIFICATION_REPORT===              ← use pass/fail/n/a, not placeholders");
    parts.push("    BUILD=pass  TESTS=pass  SECURITY=pass  ...etc.");
    parts.push("    ===END_VERIFICATION===");
    parts.push("  ✓ BOX_EXPECTED_OUTCOME=<one-line: what this task was supposed to achieve>");
    parts.push("  ✓ BOX_ACTUAL_OUTCOME=<one-line: what was actually done/delivered>");
    parts.push("  ✓ BOX_DEVIATION=none|minor|major  ← 'none' if on-plan, 'minor'/'major' if off-plan");
    parts.push("If ANY item is missing, unfilled, or uses an old format → write BOX_STATUS=partial and list what could not be completed.");
    parts.push("⚠️ Do NOT use POST_MERGE_TEST_OUTPUT — that format is rejected. Use ===NPM TEST OUTPUT START/END=== instead.");
    parts.push("Before you send your final answer, do one last literal self-check on your draft.");
    parts.push("If your final answer still contains any placeholder/example text below, you MUST replace it with real evidence or downgrade to BOX_STATUS=partial:");
    parts.push("  - <pass|fail|n/a>");
    parts.push("  - BOX_MERGED_SHA=<sha>");
    parts.push("  - <paste full raw npm test stdout here>");
    parts.push("  - POST_MERGE_TEST_OUTPUT");
    parts.push("Do NOT copy instructional examples verbatim into your final evidence block.");
  }

  parts.push(String(instruction.task || ""));

  // Warn when the task text provides no specific test file targets so the worker
  // knows it must supply concrete test evidence in its VERIFICATION_REPORT.
  const taskText = String(instruction.task || "");
  const hasSpecificTestTarget = /\.(test|spec)\.(ts|js|tsx|jsx)/i.test(taskText) ||
    /\/tests?\/[^\s]+/.test(taskText) ||
    /[—\-–]\s*test[:\s]/i.test(taskText);
  if (!hasSpecificTestTarget) {
    parts.push("");
    parts.push("## ⚠️ VERIFICATION TARGET REQUIRED");
    parts.push("No specific test file target was detected in this task's verification commands.");
    parts.push("You MUST provide specific test evidence in your VERIFICATION_REPORT:");
    parts.push("  - Run targeted tests: 'npm test -- tests/core/<module>.test.ts'");
    parts.push("  - Reference it explicitly in evidence. Do NOT run the full test suite unless explicitly requested by task text.");
    parts.push("  - Generic 'npm test passed' alone is NOT accepted as verification evidence.");
  }

  if (instruction.context) {
    parts.push("");
    parts.push("Additional context:");
    parts.push(String(instruction.context));
    if (String(instruction.context).includes("## CI_FAILURE_CONTEXT")) {
      parts.push("Use CI_FAILURE_CONTEXT as authoritative failure evidence for deterministic ci-fix work.");
    }
  }
  if (instruction.isFollowUp && instruction.previousResult) {
    parts.push("");
    parts.push(`Your previous result: ${truncate(instruction.previousResult, 400)}`);
  }

  return parts.join("\n");
}

/**
 * Inject CI_FAILURE_CONTEXT into a ci-fix worker instruction when the context
 * doesn't already contain it.  Reads local state artifact logs in priority order.
 * Always injects something — either log evidence or an explicit no-data marker.
 *
 * Exported for unit testing.
 */
export async function injectCiFailureContextIfMissing(
  instruction: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const existingCtx = String(instruction?.context || "");
  if (existingCtx.includes("## CI_FAILURE_CONTEXT")) return instruction;

  const stateDir = String((config as any)?.paths?.stateDir ?? "");
  let ciContext: string | null = null;
  if (stateDir) {
    for (const artifactName of ["npm_test_full.log", "npm_test_relevant.log", "test_run.log", "build_run.log", "evo_run_latest.log"]) {
      try {
        const logContent = await fs.readFile(path.join(stateDir, artifactName), "utf8");
        if (logContent.trim().length > 0) {
          const excerpt = logContent.slice(-4000);
          ciContext = `## CI_FAILURE_CONTEXT\nsource: worker_runner_fallback:${artifactName}\ncommit_sha: unknown\n\n${excerpt}`;
          break;
        }
      } catch {
        // Artifact missing — try next
      }
    }
  }
  if (!ciContext) {
    ciContext = `## CI_FAILURE_CONTEXT\nsource: no_evidence_available\ncommit_sha: unknown\nnote: No CI failure logs could be retrieved. Do not speculate about the failure cause. Use npm test to reproduce and diagnose.`;
  }
  const trimmed = existingCtx.trim();
  return {
    ...instruction,
    context: trimmed ? `${trimmed}\n\n${ciContext}` : ciContext,
  };
}

// ── Parse worker response ────────────────────────────────────────────────────
// Exported for unit testing of marker extraction and access-guard normalization.
export function parseWorkerResponse(stdout, stderr) {
  const output = String(stdout || "");
  const combined = `${output}\n${String(stderr || "")}`;

  // Extract status marker
  const statusMatch = combined.match(/BOX_STATUS=(\w+)/i);
  const status = statusMatch ? statusMatch[1].toLowerCase() : "done";

  // Extract PR URL
  const prMatch = combined.match(/BOX_PR_URL=(https?:\/\/\S+)/i);
  const prUrl = prMatch ? prMatch[1] : null;

  // Extract branch name — workers output BOX_BRANCH=feature/... when they create/switch a branch
  const branchMatch = combined.match(/BOX_BRANCH=(\S+)/i);
  const currentBranch = branchMatch ? branchMatch[1] : null;

  // Extract files edited/created — workers output BOX_FILES_TOUCHED=src/a.js,src/b.js
  const filesMatch = combined.match(/BOX_FILES_TOUCHED=([^\n\r]+)/i);
  const filesTouched = filesMatch
    ? filesMatch[1].split(",").map(f => f.trim()).filter(Boolean)
    : [];

  const accessHeaderMatch = combined.match(/BOX_ACCESS=([^\n\r]+)/i);
  const accessHeader = accessHeaderMatch ? accessHeaderMatch[1].trim() : null;
  const accessPairs = accessHeader
    ? accessHeader
      .split(";")
      .map(part => String(part || "").trim())
      .filter(Boolean)
      .map(part => {
        const [rawScope, rawState] = part.split(":");
        return {
          scope: String(rawScope || "").trim().toLowerCase(),
          state: String(rawState || "").trim().toLowerCase(),
        };
      })
    : [];
  const blockedScopes = accessPairs.filter(item => item.state === "blocked").map(item => item.scope);
  const hasBlockedAccess = blockedScopes.length > 0;
  const blockerMatch = combined.match(/BOX_BLOCKER=([^\n\r]+)/i);
  let dispatchBlockReason = blockerMatch ? blockerMatch[1].trim() : null;

  // Guardrail: if access protocol reports blocked but status is not blocked,
  // force status to blocked for safe deterministic follow-up routing.
  // Exception: status=skipped means work is already done (e.g. already-merged);
  // tool access being blocked is irrelevant — do NOT override skipped to blocked.
  let normalizedStatus = ["done", "partial", "blocked", "error", "skipped"].includes(status) ? status : "done";
  if (hasBlockedAccess && normalizedStatus !== "blocked" && normalizedStatus !== "skipped") {
    normalizedStatus = "blocked";
  }
  if (normalizedStatus === "blocked" && !dispatchBlockReason) {
    dispatchBlockReason = hasBlockedAccess
      ? `access_blocked:${blockedScopes.join(",")}`
      : null;
  }

  // Summary: preserve full natural-language output (no truncation)
  const lines = output.split(/\r?\n/).filter(l => l.trim());
  const meaningfulLines = lines.filter(l =>
    !l.startsWith("●") &&
    !l.startsWith("✓") &&
    !l.startsWith("⏺") &&
    !l.includes("tool_call") &&
    l.trim().length > 5
  );
  const summary = meaningfulLines.join("\n") || output;

  // Extract verification evidence from worker output
  const verificationReport = parseVerificationReport(combined);
  const responsiveMatrix = parseResponsiveMatrix(combined);
  const cleanTreeStatus = hasCleanTreeStatusEvidence(combined);

  // Extract explicit merged SHA marker (BOX_MERGED_SHA=<sha>).
  // Stored for audit and lineage — also surfaced in the done-path artifact check.
  const mergedSha = extractMergedSha(output);
  const unsupportedUpstreamCiDeferral = detectUnsupportedUpstreamCiDeferral(combined, {
    status: normalizedStatus,
    prUrl,
    mergedSha,
    hasBlockedAccess,
  });
  if (unsupportedUpstreamCiDeferral && !dispatchBlockReason) {
    dispatchBlockReason = UNSUPPORTED_UPSTREAM_CI_DEFERRAL_REASON;
  }
  // Self-reported hook telemetry is retained for audit/debug purposes only.
  // Pairing/coverage gaps must not drive status because the current worker
  // runner does not receive authoritative per-tool execution events from the
  // Copilot CLI. However, an explicit self-reported execute deny remains a
  // hard stop so downstream safety gates do not accept an apparently "done"
  // worker that also claims its execution was denied.
  const toolExecutionTelemetry = parseToolExecutionTelemetry(combined);
  if (
    toolExecutionTelemetry.deniedDecisions.length > 0
    && normalizedStatus !== "blocked"
    && normalizedStatus !== "skipped"
  ) {
    normalizedStatus = "blocked";
    if (!dispatchBlockReason) {
      const firstDenied = toolExecutionTelemetry.deniedDecisions[0];
      dispatchBlockReason = `tool_policy_denied:${String(firstDenied?.reasonCode || "unknown")}`;
    }
  }

  return {
    status: normalizedStatus,
    prUrl,
    currentBranch,
    filesTouched,
    accessHeader,
    blockedAccessScopes: blockedScopes,
    dispatchBlockReason,
    dispatchBlockReasonContract: parseDispatchBlockReasonContract(dispatchBlockReason),
    summary,
    fullOutput: output,
    verificationReport,
    responsiveMatrix,
    cleanTreeStatus,
    mergedSha,
    unsupportedUpstreamCiDeferral,
    toolExecutionTelemetry,
  };
}

export function extractStreamingWorkerResultMarker(stdout, stderr) {
  const combined = `${String(stdout || "")}\n${String(stderr || "")}`;
  if (!/BOX_STATUS=(\w+)/i.test(combined)) {
    return null;
  }
  const parsed = parseWorkerResponse(stdout, stderr);
  if (!parsed.verificationReport) {
    return null;
  }

  if (parsed.status === "done") {
    const artifact = checkPostMergeArtifact(combined, { expectedTargetFiles: [] });
    if (!artifact.hasArtifact) {
      return null;
    }
  }

  return {
    status: parsed.status,
    prUrl: parsed.prUrl,
  };
}

export function shouldTreatAbortedWorkerRunAsTerminalResult(result, stdout, stderr) {
  if (!result || result.aborted !== true) return null;

  const abortReason = String(result.stderr || "");
  if (!abortReason.includes(POST_FINAL_OUTPUT_ABORT_REASON)) {
    return null;
  }

  const marker = extractStreamingWorkerResultMarker(stdout, stderr);
  if (!marker) return null;

  return marker;
}

/**
 * Check whether a worker's done-path output contains the required closure
 * evidence fields (BOX_EXPECTED_OUTCOME, BOX_ACTUAL_OUTCOME, BOX_DEVIATION).
 *
 * These fields enforce the completion boundary: a worker cannot be accepted
 * as done without self-reported closure evidence that matches the postmortem
 * schema used by Athena (expectedOutcome / actualOutcome / deviation).
 *
 * @param output — worker's full stdout (or combined stdout+stderr)
 * @returns {{ valid: boolean, missingFields: string[] }}
 */
export function checkWorkerOutputClosureFields(output: string): {
  valid: boolean;
  missingFields: string[];
} {
  const text = String(output || "");
  const missingFields: string[] = [];

  if (!/BOX_EXPECTED_OUTCOME=\S/i.test(text)) missingFields.push("BOX_EXPECTED_OUTCOME");
  if (!/BOX_ACTUAL_OUTCOME=\S/i.test(text))   missingFields.push("BOX_ACTUAL_OUTCOME");
  if (!/BOX_DEVIATION=(none|minor|major)/i.test(text)) missingFields.push("BOX_DEVIATION");

  return { valid: missingFields.length === 0, missingFields };
}

export function deriveDeterministicCleanTreeEvidence(
  repoStatusOutput: string,
  scopedStatusOutput: string,
  targetFiles: string[] = [],
): { mode: "global" | "task-scoped" | "none"; lines: string[] } {
  const normalizedTargets = Array.isArray(targetFiles)
    ? targetFiles.map((file) => String(file || "").trim()).filter(Boolean)
    : [];
  const repoDirty = String(repoStatusOutput || "").trim().length > 0;
  if (!repoDirty) {
    return {
      mode: "global",
      lines: ["CLEAN_TREE_STATUS=clean"],
    };
  }

  const scopedDirty = String(scopedStatusOutput || "").trim().length > 0;
  if (normalizedTargets.length > 0 && !scopedDirty) {
    return {
      mode: "task-scoped",
      lines: [
        "CLEAN_TREE_STATUS=dirty-other-tasks-only",
        "TASK_SCOPED_CLEAN_STATUS=clean",
        `TASK_SCOPED_CLEAN_TARGETS=${normalizedTargets.join(", ")}`,
      ],
    };
  }

  return { mode: "none", lines: [] };
}

export function resolveCleanTreeEvidenceTargets(parsed, instruction): string[] {
  const parsedFilesTouched = Array.isArray(parsed?.filesTouched)
    ? parsed.filesTouched.map((file) => String(file || "").trim()).filter(Boolean)
    : [];
  const instructionTargetFiles = Array.isArray(instruction?.targetFiles)
    ? instruction.targetFiles.map((file) => String(file || "").trim()).filter(Boolean)
    : [];

  if (parsedFilesTouched.length > 0 && instructionTargetFiles.length > 0) {
    const instructionTargetSet = new Set<string>(instructionTargetFiles);
    const intersection = parsedFilesTouched.filter((file) => instructionTargetSet.has(file));
    if (intersection.length > 0) {
      return [...new Set<string>(intersection)];
    }
  }

  if (parsedFilesTouched.length > 0) {
    return [...new Set<string>(parsedFilesTouched)];
  }

  return [...new Set<string>(instructionTargetFiles)];
}

export function inferWorkerReportedTaskScopedCleanTreeEvidence(parsed, instruction): {
  mode: "task-scoped" | "none";
  lines: string[];
} {
  const normalizedStatus = String(parsed?.status || "").trim().toLowerCase();
  if (normalizedStatus !== "done" && normalizedStatus !== "success") {
    return { mode: "none", lines: [] };
  }

  const mergedSha = String(parsed?.mergedSha || "").trim();
  if (!mergedSha) {
    return { mode: "none", lines: [] };
  }

  const targetFiles = resolveCleanTreeEvidenceTargets(parsed, instruction);
  if (targetFiles.length === 0) {
    return { mode: "none", lines: [] };
  }

  return {
    mode: "task-scoped",
    lines: [
      "CLEAN_TREE_STATUS=dirty-other-tasks-only",
      "TASK_SCOPED_CLEAN_STATUS=clean",
      `TASK_SCOPED_CLEAN_TARGETS=${targetFiles.join(", ")}`,
    ],
  };
}

async function supplementCleanTreeEvidenceIfMissing(config, parsed, instruction) {
  const normalizedStatus = String(parsed?.status || "").trim().toLowerCase();
  if (
    !parsed
    || hasCleanTreeStatusEvidence(parsed.fullOutput || "")
    || (normalizedStatus !== "done" && normalizedStatus !== "success")
  ) {
    return { applied: false, mode: "none" as const };
  }

  const workerReportedEvidence = inferWorkerReportedTaskScopedCleanTreeEvidence(parsed, instruction);
  if (workerReportedEvidence.mode !== "none" && workerReportedEvidence.lines.length > 0) {
    parsed.fullOutput = `${String(parsed.fullOutput || "").trimEnd()}\n${workerReportedEvidence.lines.join("\n")}`.trim();
    parsed.cleanTreeStatus = true;
    return { applied: true, mode: workerReportedEvidence.mode };
  }

  const cwd = resolveWorkerExecutionCwd(config);
  const targetFiles = resolveCleanTreeEvidenceTargets(parsed, instruction);

  try {
    const repoStatus = await spawnAsync("git", ["status", "--porcelain"], { cwd }) as SpawnAsyncResult;
    if (repoStatus.status !== 0) return { applied: false, mode: "none" as const };

    let scopedStatusOutput = "";
    if (String(repoStatus.stdout || "").trim().length > 0 && targetFiles.length > 0) {
      const scopedStatus = await spawnAsync("git", ["status", "--porcelain", "--", ...targetFiles], { cwd }) as SpawnAsyncResult;
      if (scopedStatus.status !== 0) return { applied: false, mode: "none" as const };
      scopedStatusOutput = String(scopedStatus.stdout || "");
    }

    const evidence = deriveDeterministicCleanTreeEvidence(
      String(repoStatus.stdout || ""),
      scopedStatusOutput,
      targetFiles,
    );
    if (evidence.mode === "none" || evidence.lines.length === 0) {
      return { applied: false, mode: "none" as const };
    }

    parsed.fullOutput = `${String(parsed.fullOutput || "").trimEnd()}\n${evidence.lines.join("\n")}`.trim();
    parsed.cleanTreeStatus = true;
    return { applied: true, mode: evidence.mode };
  } catch {
    return { applied: false, mode: "none" as const };
  }
}

export function isNonRetryablePolicyBlockReason(reason: unknown): boolean {
  const text = String(reason || "").trim().toLowerCase();
  if (!text) return false;
  if (text.startsWith("cloud_agent_governance_policy_violation:")) return true;
  if (text.includes("non_retryable=true")) return true;
  if (text.startsWith("tool_policy_denied:hook_deny_")) return true;
  // Runtime hook denials from enforcePreExecuteHookDecisions are always non-retryable.
  if (text.startsWith("runtime_hook_denied:")) return true;
  return false;
}

/**
 * Extract a standardized violation summary from a completed worker result object.
 *
 * Callers (e.g. the orchestrator) use this to build per-cycle contract-violation
 * counters without duplicating the extraction logic at every call site.
 *
 * Returns a plain object with three boolean flags:
 *   closureBoundaryViolation — dispatchContract.closureBoundaryViolation was true
 *   hookTelemetryViolation   — dispatchBlockReason starts with "hook_telemetry_inconsistent"
 *   isDispatchBlocked        — any non-null dispatchBlockReason was set
 */
export function extractWorkerViolationSummary(workerResult: unknown): {
  closureBoundaryViolation: boolean;
  hookTelemetryViolation: boolean;
  isDispatchBlocked: boolean;
} {
  if (!workerResult || typeof workerResult !== "object") {
    return { closureBoundaryViolation: false, hookTelemetryViolation: false, isDispatchBlocked: false };
  }
  const r = workerResult as Record<string, unknown>;
  const dispatchContract = r.dispatchContract && typeof r.dispatchContract === "object"
    ? r.dispatchContract as Record<string, unknown>
    : null;
  const blockReason = typeof r.dispatchBlockReason === "string" ? r.dispatchBlockReason : "";
  return {
    closureBoundaryViolation: dispatchContract?.closureBoundaryViolation === true,
    hookTelemetryViolation:   blockReason.startsWith("hook_telemetry_inconsistent"),
    isDispatchBlocked:        blockReason.length > 0,
  };
}

/**
 * Build a deterministic WorkerRunContract for a dispatch by merging box.config.json
 * defaults with optional per-instruction overrides. Provides bounded execution bounds
 * (maxTurns, sessionInputPolicy) and tracing metadata for every worker invocation.
 */
export function buildWorkerRunContract(config: any, instruction: any): import("../types/index.js").WorkerRunContract {
  const base = config?.workerRunContract || {};
  const modelCallSettings = resolveModelCallSettingsOverlay(base?.modelCallSettings, instruction?.modelCallSettings);
  const traceMetadataBase =
    typeof base?.traceMetadata === "object" && base.traceMetadata
      ? { ...base.traceMetadata as Record<string, unknown> }
      : {};
  const hasModelCallSettings = Object.keys(modelCallSettings).length > 0;
  return {
    maxTurns:                 Number(instruction?.maxTurns  ?? modelCallSettings.maxTurns ?? base?.maxTurns  ?? 50),
    workflowName:             String(instruction?.workflowName ?? base?.workflowName ?? "box-evolution"),
    groupId:                  String(instruction?.groupId   ?? base?.groupId   ?? "box-workers"),
    traceMetadata:            hasModelCallSettings
                                ? { ...traceMetadataBase, modelCallSettings }
                                : traceMetadataBase,
    traceIncludeSensitiveData: base?.traceIncludeSensitiveData === true ? true : false,
    sessionInputPolicy:       (base?.sessionInputPolicy || "auto") as "allow_all" | "no_tools" | "auto",
  };
}

export function isWorkerAgentResolutionFailure(output: unknown): boolean {
  return /no such agent:/i.test(String(output || ""));
}

export function buildWorkerPersonaFallbackPrompt(agentSlug: unknown, prompt: unknown): string {
  const promptText = String(prompt || "");
  const slug = String(agentSlug || "").trim();
  const persona = slug ? readAgentPersona(slug) : "";
  return persona ? `## YOUR ROLE\n${persona}\n\n${promptText}` : promptText;
}

/**
 * Derive a short, deterministic run identifier from taskId + attempt + timestamp.
 * Used to correlate failure envelopes, retry decisions, and boundary checkpoints
 * within a single attempt lineage.
 */
function buildRunId(taskId: string | number | null | undefined, attempt: number): string {
  const seed = `${String(taskId ?? "")}:${attempt}:${Date.now()}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

// ── Main Worker Conversation ─────────────────────────────────────────────────

export async function runWorkerConversation(config, roleName, instruction, history = [], sessionState: WorkerSessionState = {}, _token?: CancellationToken | null) {
  // ── Attempt-scoped execution metadata ────────────────────────────────────
  // runId links all failure/retry artifacts for this specific attempt lineage.
  // firstAttemptAt is only set once and carried forward across retries.
  const attempt = Number(instruction?.reworkAttempt ?? 0);
  const runId = buildRunId(instruction?.taskId, attempt);
  let runtimeLineage = buildWorkerRuntimeLineage(instruction, {
    roleName: String(roleName || "worker"),
  });
  const _dispatchLineageId: string | null = runtimeLineage.lineage?.lineageId || null;
  const firstAttemptAt: string = String(
    instruction?.firstAttemptAt ?? new Date().toISOString()
  );
  const attemptMeta: AttemptMeta = { runId, attempt, firstAttemptAt };

  const taskHints: TaskHints = {
    estimatedLines: Number(instruction.estimatedLines || 0),
    estimatedDurationMinutes: Number(instruction.estimatedDurationMinutes || 0),
    complexity: String(instruction.complexity || instruction.estimatedComplexity || "")
  };

  // ── Task 2: Load compiled lesson policies and derive dispatch controls ──────
  // learned_policies.json is written by the orchestrator after each cycle from
  // postmortem lessons. Routing adjustments and prompt hard constraints are
  // derived here — fail-open so a missing/corrupt file never blocks dispatch.
  const learnedPolicies = loadLearnedPolicies(config);
  const routingAdjustments: RoutingAdjustment[] = deriveRoutingAdjustments(learnedPolicies);
  const hardConstraints: PromptHardConstraint[] = buildPromptHardConstraints(learnedPolicies);
  const recentROI = computeRecentROI(config, instruction.taskKind);
  const outcomeMetrics = computeOutcomeMetrics(config, instruction.taskKind);
  const _benchmarkSignal = analyzeBenchmarkReadiness(config, taskHints);
  const promptCacheSignal = await computePromptCacheRoutingSignal(
    config,
    instruction.taskKind || "general",
    String(roleName || "worker"),
    {
      lineageId: _dispatchLineageId,
      lineageJoinKey: runtimeLineage.lineageJoinKey,
    },
  );
  const failureFinishSignal = await computeFailureFinishRoutingSignal(
    config,
    instruction.taskKind || "general",
    String(roleName || "worker"),
    {
      lineageId: _dispatchLineageId,
      lineageJoinKey: runtimeLineage.lineageJoinKey,
    },
  );
  const deliberation = decideDeliberationPolicy(
    taskHints,
    { recentROI },
    {
      benchmarkGroundTruth: loadBenchmarkGroundTruthSignal(config),
      outcomeMetrics,
      lineageSignals: {
        lowRoiSignalCount: failureFinishSignal.lowRoiSignalCount,
        promptCacheHitRate: promptCacheSignal.hitRate,
        promptCacheSavedTokens: promptCacheSignal.avgSavedTokens,
        latestFailureClass: failureFinishSignal.latestFailureClass,
        latestFinishCode: failureFinishSignal.latestFinishCode,
        latestFinishStatus: failureFinishSignal.latestFinishStatus,
      },
    }
  );
  const modelCallSettings: ModelCallSettingsOverlay = resolveModelCallSettingsOverlay(
    config?.workerRunContract?.modelCallSettings,
    instruction?.modelCallSettings,
  );
  try {
    emitWorkerModelCallHookEvent(
      WORKER_MODEL_CALL_HOOK.SETTINGS_OVERLAY_RESOLVED,
      String(roleName || "worker"),
      null,
      _dispatchLineageId,
      {
        applied: Object.keys(modelCallSettings).length > 0,
        hasModelOverride: typeof modelCallSettings.model === "string" && modelCallSettings.model.length > 0,
        hasMaxTurnsOverride: typeof modelCallSettings.maxTurns === "number",
      },
    );
  } catch { /* telemetry is non-critical */ }

  // ── Task 1: Uncertainty-aware model selection ─────────────────────────────
  // resolveModel now uses routeModelWithUncertainty (backed by historical ROI)
  // and applies policy routing adjustments from recurring failure lessons.
  let model = await resolveModel(
    config,
    roleName,
    instruction.taskKind,
    taskHints,
    routingAdjustments,
    {
      promptCacheSignal,
      failureFinishSignal,
    },
  );

  // ── Hard-task escalation: deliberation.mode → strong model upgrade ─────────
  // assessHardTaskEscalation (called inside decideDeliberationPolicy) can signal
  // that the task requires multi-attempt deliberation. When that happens, also
  // upgrade the model to strongModel if it is different from the resolved model,
  // ensuring hard tasks run on the most capable model available.
  if (deliberation.mode === "multi-attempt") {
    const defaultModel = config?.copilot?.defaultModel || "Claude Sonnet 4.6";
    const strongModel = config?.copilot?.strongModel || defaultModel;
    if (model !== strongModel) {
      const escalated = enforceModelPolicy(strongModel, taskHints, defaultModel);
      if (!escalated.downgraded) {
        const previousModel = model;
        model = strongModel;
        appendProgress(config,
          `[HARD_TASK_ESCALATION] ${roleName}: model upgraded ${previousModel} → ${model} (deliberation=multi-attempt reason=${deliberation.reason || "complex-task"})`
        ).catch(() => { /* non-critical */ });
      }
    }
  }

  // Per-task model override overlay is applied after routing/escalation and still
  // enforced by global model policy so unsafe models cannot bypass guards.
  if (modelCallSettings.model) {
    const defaultModel = config?.copilot?.defaultModel || "Claude Sonnet 4.6";
    const overlaid = enforceModelPolicy(modelCallSettings.model, taskHints, defaultModel);
    model = overlaid.model;
  }

  // Classify complexity tier for prompt budget injection
  const { tier } = classifyComplexityTier(taskHints);
  runtimeLineage = buildWorkerRuntimeLineage(instruction, {
    roleName: String(roleName || "worker"),
    model,
  });

  // ── Cooperative cancellation: check before spawning subprocess ───────────
  if (_token?.cancelled) {
    throw new CancelledError(_token.reason || "cancelled-before-dispatch");
  }

  // ── Typed event: model routing decision telemetry ─────────────────────────
  // Emit after model is fully resolved (including deliberation escalation)
  // so downstream consumers see the final routing decision, not an intermediate one.
  // lineageId links this routing event to the matching premium_usage_log entry.
  try {
    const policyResult = enforceModelPolicy(model, taskHints, config?.copilot?.defaultModel || "Claude Sonnet 4.6");
    emitEvent(EVENTS.POLICY_MODEL_ROUTED, EVENT_DOMAIN.POLICY, `model-route-${roleName}-${Date.now()}`, {
      roleName,
      resolvedModel: model,
      tier,
      wasDowngraded: policyResult.downgraded,
      routingReasonCode: deliberation.mode === "multi-attempt" ? "hard-task-escalation" : "standard",
      taskKind: instruction.taskKind || "general",
      lineageId: _dispatchLineageId,
      lineageJoinKey: runtimeLineage.lineageJoinKey,
      lineage: runtimeLineage.lineage,
      meetsQualityFloor: !policyResult.downgraded,
    });
  } catch { /* telemetry is non-critical */ }

  const command = config.env?.copilotCliCommand || "copilot";
  const agentSlug = nameToSlug(roleName); // "king-david", "esther", etc.

  // Resolve worker kind for role-based verification
  const workerConfig = findWorkerByName(config, roleName);
  const workerKind = workerConfig?.kind || null;
  const semanticContext = await buildSemanticTaskContext(config, instruction);
  const instructionWithSemanticContext = semanticContext
    ? {
      ...instruction,
      context: [semanticContext, String(instruction?.context || "").trim()].filter(Boolean).join("\n\n"),
    }
    : instruction;

  // ── Worker-runner CI context fallback ─────────────────────────────────────
  const taskKindNorm = String(instruction?.taskKind || "").toLowerCase().replace(/[_\s]+/g, "-");
  const taskTextLower = String(instruction?.task || "").toLowerCase();
  const isCiFixTask = taskKindNorm === "ci-fix" || /\bci[-_\s]?fix\b/.test(taskTextLower);
  const ciFixEnrichedInstruction = isCiFixTask
    ? await injectCiFailureContextIfMissing(instructionWithSemanticContext as Record<string, unknown>, config)
    : instructionWithSemanticContext;
  const reflectionMemoryContext = loadReflectionMemoryContext(config, roleName, instruction.taskKind, instruction.task, (instruction as any).failureClass ?? null);
  const reflectedInstruction = reflectionMemoryContext
    ? {
        ...ciFixEnrichedInstruction,
        context: [reflectionMemoryContext, String((ciFixEnrichedInstruction as any)?.context || "").trim()].filter(Boolean).join("\n\n"),
      }
    : ciFixEnrichedInstruction;

  // Build conversation-only context with prompt tier budget and hard constraints injected
  const conversationContext = buildConversationContext(
    history, reflectedInstruction, sessionState, config, workerKind,
    {
      tier,
      hardConstraints,
      deliberationMode: deliberation.mode,
      searchBudget: deliberation.searchBudget,
      uncertaintyLevel: deliberation.uncertaintyLevel,
      candidateFirstMoves: deliberation.candidateFirstMoves,
      recommendedFirstMove: deliberation.recommendedFirstMove,
    }
  );

  // ── Memory-hit telemetry production ───────────────────────────────────────
  // Emit a record capturing how many memory hints/lessons were available for
  // this dispatch. Outcome starts null and is filled in after the worker returns.
  const _memoryHitTaskId = String(instruction.taskId || instruction.task || roleName || "");
  try {
    const kmPath = path.join(config.paths?.stateDir || "state", "knowledge_memory.json");
    let hintsInjected = 0;
    let lessonsInjected = 0;
    let droppedLowTrust = 0;
    let isPrivileged = false;
    if (existsSync(kmPath)) {
      const km = JSON.parse(readFileSync(kmPath, "utf8"));
      const privilegedCaller = isPrivilegedMemoryRequester(workerKind);
      isPrivileged = privilegedCaller;
      const targetFiltered = Array.isArray(km.promptHints)
        ? km.promptHints.filter((h: any) => {
            const target = String(h.targetAgent || "").toLowerCase();
            return target === "all" || target === "workers" || target === String(workerKind || "").toLowerCase();
          })
        : [];
      const { selected: filteredHints, droppedLowTrustCount: dropped1 } = filterMemoryEntriesByTrust(
        targetFiltered, { includeLowTrust: privilegedCaller, privilegedCaller },
      );
      const rawLessons = Array.isArray(km.lessons) ? km.lessons.slice(-5) : [];
      const { selected: filteredLessons, droppedLowTrustCount: dropped2 } = filterMemoryEntriesByTrust(
        rawLessons, { includeLowTrust: privilegedCaller, privilegedCaller },
      );
      const criticalLessons = filteredLessons.filter(
        (l: any) => l.severity === "critical" || l.severity === "warning",
      );
      hintsInjected   = filteredHints.length;
      lessonsInjected = criticalLessons.length;
      droppedLowTrust = dropped1 + dropped2;
    }
    const hitRecord = buildMemoryHitRecord({
      lineageId:       String(_dispatchLineageId || instruction.lineageRootId || ""),
      taskId:          _memoryHitTaskId || null,
      workerKind:      workerKind ?? null,
      taskKind:        instruction.taskKind ?? null,
      hintsInjected,
      lessonsInjected,
      droppedLowTrust,
      isPrivileged,
    });
    logMemoryHit(config, hitRecord);
  } catch { /* telemetry is non-critical */ }

  await appendProgress(
    config,
    `[WORKER:${roleName}] [${instruction.taskKind || "general"}→${model}] deliberation=${deliberation.mode}/${deliberation.uncertaintyLevel} ${truncate(instruction.task, 70)}`
  );

  await persistLegacyWorkerSessionArtifacts(config, String(roleName || "worker"), {
    phase: "start",
    task: String(instruction?.task || ""),
  });

  const updatedHistory = [
    ...history,
    { from: "prometheus", content: instruction.task, timestamp: new Date().toISOString() }
  ];

  const capabilityCheck = evaluateWorkerRoleCapability(config, roleName, instruction.taskKind, instruction.task);
  if (!capabilityCheck.allowed) {
    const summary = `Role capability check failed: ${capabilityCheck.code} — ${capabilityCheck.message}`;
    const replayClosure = buildReplayClosureEvidence(summary);
    const dispatchContract: DispatchVerificationContract = {
      doneWorkerWithVerificationReportEvidence: false,
      doneWorkerWithCleanTreeStatusEvidence: false,
      dispatchBlockReason: `role_capability_check_failed:${capabilityCheck.code}`,
      dispatchBlockReasonContract: parseDispatchBlockReasonContract(`role_capability_check_failed:${capabilityCheck.code}`),
      closureBoundaryViolation: false,
      replayClosure: {
        contractSatisfied: replayClosure.contractSatisfied === true,
        canonicalCommands: Array.isArray(replayClosure.canonicalCommands) ? replayClosure.canonicalCommands : [],
        executedCommands: Array.isArray(replayClosure.executedCommands) ? replayClosure.executedCommands : [],
        rawArtifactEvidenceLinks: Array.isArray(replayClosure.rawArtifactEvidenceLinks) ? replayClosure.rawArtifactEvidenceLinks : [],
      },
    };
    await appendProgress(config, `[WORKER:${roleName}] ${summary}`);
    await persistLegacyWorkerSessionArtifacts(config, String(roleName || "worker"), {
      phase: "complete",
      task: String(instruction?.task || ""),
      status: "blocked",
      pr: null,
      dispatchBlockReason: dispatchContract.dispatchBlockReason,
    });
    updatedHistory.push({
      from: roleName,
      content: summary,
      fullOutput: summary,
      prUrl: null,
      timestamp: new Date().toISOString(),
      status: "blocked"
    });
    return {
      status: "blocked",
      summary,
      prUrl: null,
      currentBranch: null,
      filesTouched: [],
      updatedHistory,
      workerKind,
      tier,
      verificationReport: null,
      responsiveMatrix: null,
      verificationEvidence: null,
      dispatchContract,
      lineage: runtimeLineage.lineage,
      lineageJoinKey: runtimeLineage.lineageJoinKey,
      fullOutput: summary,
      failureClassification: null,
      retryDecision: null
    };
  }

  const selfDevPreDispatch = evaluateSelfDevProtectionBoundary({
    changedFiles: Array.isArray(instruction.targetFiles) ? instruction.targetFiles : [],
    changedFilesCount: Array.isArray(instruction.targetFiles) ? instruction.targetFiles.length : 0,
  }, config);
  if (selfDevPreDispatch.active && selfDevPreDispatch.warnings.length > 0) {
    await appendProgress(
      config,
      `[WORKER:${roleName}] SELF_DEV_GUARD caution plannedScope=${selfDevPreDispatch.warnings.slice(0, 3).join("; ")}`
    );
  }
  if (selfDevPreDispatch.active && !selfDevPreDispatch.allowed) {
    const summary = `Self-dev protection wall blocked planned scope: ${selfDevPreDispatch.blocked.join("; ")}`;
    const replayClosure = buildReplayClosureEvidence(summary);
    const dispatchContract: DispatchVerificationContract = {
      doneWorkerWithVerificationReportEvidence: false,
      doneWorkerWithCleanTreeStatusEvidence: false,
      dispatchBlockReason: "self_dev_guard_breach:planned_scope",
      dispatchBlockReasonContract: parseDispatchBlockReasonContract("self_dev_guard_breach:planned_scope"),
      closureBoundaryViolation: false,
      replayClosure: {
        contractSatisfied: replayClosure.contractSatisfied === true,
        canonicalCommands: Array.isArray(replayClosure.canonicalCommands) ? replayClosure.canonicalCommands : [],
        executedCommands: Array.isArray(replayClosure.executedCommands) ? replayClosure.executedCommands : [],
        rawArtifactEvidenceLinks: Array.isArray(replayClosure.rawArtifactEvidenceLinks) ? replayClosure.rawArtifactEvidenceLinks : [],
      },
    };
    await appendProgress(config, `[WORKER:${roleName}] ${summary}`);
    updatedHistory.push({
      from: roleName,
      content: summary,
      fullOutput: summary,
      prUrl: null,
      timestamp: new Date().toISOString(),
      status: "blocked"
    });
    return {
      status: "blocked",
      summary,
      prUrl: null,
      currentBranch: null,
      filesTouched: [],
      updatedHistory,
      workerKind,
      tier,
      verificationReport: null,
      responsiveMatrix: null,
      verificationEvidence: null,
      dispatchContract,
      lineage: runtimeLineage.lineage,
      lineageJoinKey: runtimeLineage.lineageJoinKey,
      fullOutput: summary,
      failureClassification: null,
      retryDecision: null
    };
  }

  const targetExecutionBoundary = evaluateTargetExecutionBoundary({
    changedFiles: Array.isArray(instruction.targetFiles) ? instruction.targetFiles : [],
    taskKind: instruction?.taskKind,
    task: instruction?.task,
    context: instruction?.context,
    verification: instruction?.verification,
  }, config);
  if (targetExecutionBoundary.active && targetExecutionBoundary.executionContext.workspacePath) {
    await appendProgress(
      config,
      `[WORKER:${roleName}] TARGET_EXECUTION mode=${targetExecutionBoundary.executionContext.executionMode || "blocked"} workspace=${targetExecutionBoundary.executionContext.workspacePath}`
    );
  }
  if (targetExecutionBoundary.active && !targetExecutionBoundary.allowed) {
    const summary = `Target execution boundary blocked planned scope: ${targetExecutionBoundary.blocked.join("; ")}`;
    const replayClosure = buildReplayClosureEvidence(summary);
    const dispatchContract: DispatchVerificationContract = {
      doneWorkerWithVerificationReportEvidence: false,
      doneWorkerWithCleanTreeStatusEvidence: false,
      dispatchBlockReason: targetExecutionBoundary.dispatchBlockReason || "target_execution_guard:planned_scope",
      dispatchBlockReasonContract: parseDispatchBlockReasonContract(targetExecutionBoundary.dispatchBlockReason || "target_execution_guard:planned_scope"),
      closureBoundaryViolation: false,
      replayClosure: {
        contractSatisfied: replayClosure.contractSatisfied === true,
        canonicalCommands: Array.isArray(replayClosure.canonicalCommands) ? replayClosure.canonicalCommands : [],
        executedCommands: Array.isArray(replayClosure.executedCommands) ? replayClosure.executedCommands : [],
        rawArtifactEvidenceLinks: Array.isArray(replayClosure.rawArtifactEvidenceLinks) ? replayClosure.rawArtifactEvidenceLinks : [],
      },
    };
    await appendProgress(config, `[WORKER:${roleName}] ${summary}`);
    updatedHistory.push({
      from: roleName,
      content: summary,
      fullOutput: summary,
      prUrl: null,
      timestamp: new Date().toISOString(),
      status: "blocked"
    });
    return {
      status: "blocked",
      summary,
      prUrl: null,
      currentBranch: null,
      filesTouched: [],
      updatedHistory,
      workerKind,
      tier,
      verificationReport: null,
      responsiveMatrix: null,
      verificationEvidence: null,
      dispatchContract,
      lineage: runtimeLineage.lineage,
      lineageJoinKey: runtimeLineage.lineageJoinKey,
      fullOutput: summary,
      failureClassification: null,
      retryDecision: null
    };
  }

  const workerExecutionCwd = resolveWorkerExecutionCwd(config);
  const targetExecutionContext = targetExecutionBoundary.executionContext;

  const runContract = buildWorkerRunContract(config, instruction);
  const agentProfile = resolveAgentExecutionProfile(agentSlug);
  if (!agentProfile.valid) {
    const summary = `Agent profile contract check failed for ${agentSlug}: ${agentProfile.violations.join(", ") || "unknown_violation"}`;
    const replayClosure = buildReplayClosureEvidence(summary);
    const dispatchContract: DispatchVerificationContract = {
      doneWorkerWithVerificationReportEvidence: false,
      doneWorkerWithCleanTreeStatusEvidence: false,
      dispatchBlockReason: `agent_profile_invalid:${agentSlug}`,
      dispatchBlockReasonContract: parseDispatchBlockReasonContract(`agent_profile_invalid:${agentSlug}`),
      closureBoundaryViolation: false,
      replayClosure: {
        contractSatisfied: replayClosure.contractSatisfied === true,
        canonicalCommands: Array.isArray(replayClosure.canonicalCommands) ? replayClosure.canonicalCommands : [],
        executedCommands: Array.isArray(replayClosure.executedCommands) ? replayClosure.executedCommands : [],
        rawArtifactEvidenceLinks: Array.isArray(replayClosure.rawArtifactEvidenceLinks) ? replayClosure.rawArtifactEvidenceLinks : [],
      },
    };
    await appendProgress(config, `[WORKER:${roleName}] ${summary}`);
    await persistLegacyWorkerSessionArtifacts(config, String(roleName || "worker"), {
      phase: "complete",
      task: String(instruction?.task || ""),
      status: "blocked",
      pr: null,
      dispatchBlockReason: dispatchContract.dispatchBlockReason,
    });
    updatedHistory.push({
      from: roleName,
      content: summary,
      fullOutput: summary,
      prUrl: null,
      timestamp: new Date().toISOString(),
      status: "blocked"
    });
    return {
      status: "blocked",
      summary,
      prUrl: null,
      currentBranch: null,
      filesTouched: [],
      updatedHistory,
      workerKind,
      tier,
      verificationReport: null,
      responsiveMatrix: null,
      verificationEvidence: null,
      dispatchContract,
      lineage: runtimeLineage.lineage,
      lineageJoinKey: runtimeLineage.lineageJoinKey,
      fullOutput: summary,
      failureClassification: null,
      retryDecision: null
    };
  }
  const effectiveSessionInputPolicy = resolveAgentSessionInputPolicy(agentProfile, runContract.sessionInputPolicy);
  runContract.traceMetadata = {
    ...runContract.traceMetadata,
    agentProfileSource: agentProfile.source,
    agentSessionInputPolicy: effectiveSessionInputPolicy,
    agentHookCoverage: agentProfile.hookCoverage,
  };
  const allowAllTools = effectiveSessionInputPolicy === "allow_all";
  const args = buildAgentArgs({
    agentSlug,
    prompt: conversationContext,
    model,
    modelCallSettings,
    allowAll: allowAllTools,
    noAskUser: allowAllTools,
    maxContinues: undefined,
    runContract,
  });

  // Compute timeout: config.runtime.workerTimeoutMinutes → ms.
  // 0 or negative means no timeout for worker execution.
  const workerTimeoutMinutes = Number(config?.runtime?.workerTimeoutMinutes || 0);
  const workerTimeoutMs = workerTimeoutMinutes > 0 ? workerTimeoutMinutes * 60 * 1000 : null;
  const liveLogPath = getLiveLogPath(config, roleName);

  await appendLiveWorkerLog(
    config,
    liveLogPath,
    roleName,
    [
      "",
      `${"=".repeat(80)}`,
      `[${new Date().toISOString()}] START role=${roleName} model=${model}`,
      `TASK: ${instruction.task}`,
      `${"-".repeat(80)}`,
      ""
    ].join("\n")
  );

  const routingTaskId = String(instruction.taskId || buildTaskFingerprint(instruction.taskKind || "general", instruction.task || "").slice(0, 24));
  const estimatedPromptTokens = Math.max(1, Math.ceil(conversationContext.length / 4));
  try {
    await appendRouteROIEntry(config, {
      taskId: routingTaskId,
      model,
      tier,
      estimatedTokens: estimatedPromptTokens,
      expectedQuality: estimateModelExpectedQuality(config, model),
      lineageId: _dispatchLineageId,
      lineage: runtimeLineage.lineage,
      lineageJoinKey: runtimeLineage.lineageJoinKey,
      taskKind: instruction.taskKind || "general",
      role: String(roleName || "worker"),
    });
  } catch {
    // non-critical routing telemetry
  }

  const startMs = Date.now();
  let streamedStdout = "";
  let streamedStderr = "";
  let streamedResultEmitted = false;
  let finalOutputExitTimer: NodeJS.Timeout | null = null;
  const configuredFinalOutputGraceMs = Number(config?.runtime?.workerFinalOutputExitGraceMs ?? DEFAULT_FINAL_OUTPUT_EXIT_GRACE_MS);
  const finalOutputExitGraceMs = Number.isFinite(configuredFinalOutputGraceMs) && configuredFinalOutputGraceMs > 0
    ? configuredFinalOutputGraceMs
    : 0;

  const emitStreamingResultMarker = () => {
    if (streamedResultEmitted) return;
    const marker = extractStreamingWorkerResultMarker(streamedStdout, streamedStderr);
    if (!marker) return;
    streamedResultEmitted = true;
    appendLiveWorkerLog(
      config,
      liveLogPath,
      roleName,
      `\n[${new Date().toISOString()}] RESULT_EMITTED status=${marker.status}${marker.prUrl ? ` pr=${marker.prUrl}` : ""} exit_pending=true\n`
    ).catch(() => {});
    appendProgress(
      config,
      `[WORKER:${roleName}] Final output emitted status=${marker.status}${marker.prUrl ? ` PR=${marker.prUrl}` : ""} (process exit pending)`
    ).catch(() => {});

    if (finalOutputExitGraceMs > 0) {
      finalOutputExitTimer = setTimeout(() => {
        if (abortController.signal.aborted) return;
        abortController.abort(`${POST_FINAL_OUTPUT_ABORT_REASON} after ${finalOutputExitGraceMs}ms`);
      }, finalOutputExitGraceMs);
    }
  };

  // Circuit breaker: detect consecutive transient API errors from the Copilot CLI
  // and abort the process early instead of waiting for 45-minute timeout.
  const TRANSIENT_ERROR_THRESHOLD = 10;
  let transientErrorCount = 0;
  const abortController = new AbortController();

  const executeWorkerModelCall = async (spawnArgs: string[]) => spawnAsync(command, spawnArgs, {
    cwd: workerExecutionCwd,
    env: {
      ...process.env,
      GH_TOKEN: config.env?.githubToken || process.env.GH_TOKEN || "",
      GITHUB_TOKEN: config.env?.githubToken || process.env.GITHUB_TOKEN || "",
      TARGET_REPO: targetExecutionContext?.targetRepo || config.env?.targetRepo || "",
      TARGET_BASE_BRANCH: targetExecutionContext?.targetBaseBranch || config.env?.targetBaseBranch || "main",
      TARGET_WORKSPACE_PATH: targetExecutionContext?.workspacePath || "",
      TARGET_SESSION_ID: targetExecutionContext?.sessionId || "",
      TARGET_PROJECT_ID: targetExecutionContext?.projectId || "",
      TARGET_EXECUTION_MODE: targetExecutionContext?.executionMode || "box"
    },
    timeoutMs: workerTimeoutMs,
    signal: abortController.signal,
    onStdout: (chunk) => {
      const text = String(chunk);
      streamedStdout += text;
      appendLiveWorkerLog(config, liveLogPath, roleName, text).catch(() => {});
      if (/transient API error/i.test(text)) {
        transientErrorCount++;
        if (transientErrorCount >= TRANSIENT_ERROR_THRESHOLD) {
          abortController.abort(
            `[ATLAS] Transient API error circuit breaker: ${transientErrorCount} consecutive errors — aborting to avoid waste`
          );
        }
      } else if (text.trim().length > 20) {
        transientErrorCount = 0;
      }
      emitStreamingResultMarker();
    },
    onStderr: (chunk) => {
      const text = String(chunk);
      streamedStderr += text;
      appendLiveWorkerLog(config, liveLogPath, roleName, `[stderr] ${text}`).catch(() => {});
      if (/transient API error/i.test(text)) {
        transientErrorCount++;
        if (transientErrorCount >= TRANSIENT_ERROR_THRESHOLD) {
          abortController.abort(
            `[ATLAS] Transient API error circuit breaker: ${transientErrorCount} consecutive errors — aborting to avoid waste`
          );
        }
      }
      emitStreamingResultMarker();
    }
  }) as Promise<SpawnAsyncResult>;

  // Propagate external cancellation token into the subprocess AbortController.
  // This allows the orchestrator's per-cycle token to surface here and abort
  // a long-running copilot CLI spawn without waiting for the next stop check.
  if (_token?.cancelled) {
    abortController.abort(_token.reason || "cancelled-before-spawn");
  }

  try {
    emitWorkerModelCallHookEvent(
      WORKER_MODEL_CALL_HOOK.BEFORE_MODEL_CALL,
      String(roleName || "worker"),
      model,
      _dispatchLineageId,
      {
        taskId: instruction?.taskId ?? null,
        taskKind: instruction?.taskKind ?? "general",
        runId,
      },
    );
  } catch { /* telemetry is non-critical */ }

  let result = await executeWorkerModelCall(args);
  let stdout = String(result?.stdout || "");
  let stderr = String(result?.stderr || "");
  if (result.status !== 0 && isWorkerAgentResolutionFailure(`${stderr}\n${stdout}`)) {
    const fallbackArgs = buildAgentArgs({
      prompt: buildWorkerPersonaFallbackPrompt(agentSlug, conversationContext),
      model,
      modelCallSettings,
      allowAll: allowAllTools,
      noAskUser: allowAllTools,
      maxContinues: undefined,
      runContract,
    });
    await appendProgress(config, `[WORKER:${roleName}] Agent slug ${agentSlug} unavailable in execution cwd — retrying once without --agent using embedded persona`);
    result = await executeWorkerModelCall(fallbackArgs);
    stdout = String(result?.stdout || "");
    stderr = String(result?.stderr || "");
  }

  if (finalOutputExitTimer) {
    clearTimeout(finalOutputExitTimer);
  }
  const forcedTerminalMarker = shouldTreatAbortedWorkerRunAsTerminalResult(result, stdout, stderr);
  const effectiveStatusCode = forcedTerminalMarker ? 0 : result.status;
  const effectiveStderr = forcedTerminalMarker
    ? stderr.replace(String(result?.stderr || ""), "").trim()
    : stderr;
  try {
    emitWorkerModelCallHookEvent(
      WORKER_MODEL_CALL_HOOK.AFTER_MODEL_CALL,
      String(roleName || "worker"),
      model,
      _dispatchLineageId,
      {
        taskId: instruction?.taskId ?? null,
        taskKind: instruction?.taskKind ?? "general",
        runId,
        exitCode: typeof effectiveStatusCode === "number" ? effectiveStatusCode : null,
        timedOut: result?.timedOut === true,
        aborted: result?.aborted === true,
      },
    );
  } catch { /* telemetry is non-critical */ }

  if (forcedTerminalMarker) {
    await appendLiveWorkerLog(
      config,
      liveLogPath,
      roleName,
      `\n[${new Date().toISOString()}] PROCESS_EXIT_FORCED status=${forcedTerminalMarker.status}${forcedTerminalMarker.prUrl ? ` pr=${forcedTerminalMarker.prUrl}` : ""} reason=post-final-output-grace\n`
    );
    await appendProgress(
      config,
      `[WORKER:${roleName}] Final output grace expired — forced process exit accepted as status=${forcedTerminalMarker.status}`
    );
  }

  // Cooperative cancellation: if the orchestrator cancelled while the worker was
  // running, don't advance into the verification / audit path — the cycle is being
  // torn down and any further writes would be misleading state artifacts.
  if (_token?.cancelled) {
    throw new CancelledError(_token.reason || "cancelled-after-worker-spawn");
  }

  if (effectiveStatusCode !== 0) {
    const isTransient = result.aborted === true && /transient API error circuit breaker/i.test(effectiveStderr);
    const exitCodeInfo = classifyExitCode(effectiveStatusCode);
    const reasonCode = isTransient
      ? "TRANSIENT_API_ERROR"
      : isWorkerAgentResolutionFailure(`${effectiveStderr}\n${stdout}`)
        ? "AGENT_NOT_AVAILABLE"
        : exitCodeInfo?.reasonCode ?? (result.timedOut ? "PROCESS_TIMEOUT" : "UNKNOWN_EXIT");
    const retryClass = isTransient ? "cooldown" : exitCodeInfo?.retryClass ?? (result.timedOut ? "cooldown" : null);
    const label = isTransient ? `TransientAPIError` : result.timedOut ? `Timeout` : `Error exit=${effectiveStatusCode}`;
    await appendLiveWorkerLog(
      config,
      liveLogPath,
      roleName,
      `\n[${new Date().toISOString()}] END status=error exit=${effectiveStatusCode} reason_code=${reasonCode} retry_class=${retryClass ?? "none"}${result.timedOut ? " timeout=true" : ""}${isTransient ? " transient=true" : ""}\n`
    );
    await appendProgress(config, `[WORKER:${roleName}] ${label} reason_code=${reasonCode} retry_class=${retryClass ?? "none"}`);
    const errorMsg = truncate(effectiveStderr || stdout || "unknown error", 300);
    const errorPhaseRetryState = buildPhaseAwareRetryState({
      instruction,
      parsed: {
        status: isTransient ? "transient_error" : "error",
        summary: errorMsg,
        fullOutput: `${stdout}\n${effectiveStderr}`,
        filesTouched: [],
        currentBranch: sessionState?.currentBranch || null,
        prUrl: null,
        dispatchBlockReason: null,
      },
      statusOverride: isTransient ? "transient_error" : "error",
    });

    // Persist structured escalation for worker errors/timeouts (non-critical write)
    appendEscalation(config, {
      role: roleName,
      task: instruction.task,
      blockingReasonClass: BLOCKING_REASON_CLASS.WORKER_ERROR,
      attempts: Number(instruction.reworkAttempt || 0),
      nextAction: NEXT_ACTION.RETRY,
      summary: label + ": " + errorMsg
    }).catch(() => { /* non-fatal */ });

    // Classify and persist failure (non-critical — never blocks the return)
    {
      const cfResult = classifyFailure({
        workerStatus: "error",
        blockingReasonClass: BLOCKING_REASON_CLASS.WORKER_ERROR,
        errorMessage: errorMsg,
        logLines: result.timedOut ? ["Process timed out"] : [],
        failurePhase: errorPhaseRetryState.failedPhase,
        phaseEvidence: errorPhaseRetryState.evidence,
        taskId: instruction.taskId || null,
        attemptMeta,
      });
      if (cfResult.ok) {
        const finishCode = deriveWorkerFinishCode({ status: isTransient ? "transient_error" : "error" }, reasonCode);
        appendFailureClassification(config, {
          ...cfResult.classification,
          taskKind: instruction.taskKind || "general",
          roleName: String(roleName || "worker"),
          lineageId: _dispatchLineageId,
          lineage: runtimeLineage.lineage,
          lineageJoinKey: runtimeLineage.lineageJoinKey,
          finishStatus: isTransient ? "transient_error" : "error",
          finishCode,
        }).catch(() => { /* non-fatal */ });
      }
    }

    // Resolve adaptive retry decision for error path
    let errorRetryDecision = null;
    let errorRetryROI = null;
    try {
      const exitClassification = classifyFailure({
        workerStatus: "error",
        blockingReasonClass: BLOCKING_REASON_CLASS.WORKER_ERROR,
        errorMessage: errorMsg,
        logLines: result.timedOut ? ["Process timed out"] : [],
        failurePhase: errorPhaseRetryState.failedPhase,
        phaseEvidence: errorPhaseRetryState.evidence,
        taskId: instruction.taskId || null,
        attemptMeta,
      });
      if (exitClassification.ok) {
        const rd = resolveRetryAction(
          exitClassification.classification.primaryClass,
          Number(instruction.reworkAttempt || 0),
          config,
          instruction.taskId || null
        );
        if (rd.ok) {
          const finishCode = deriveWorkerFinishCode({ status: isTransient ? "transient_error" : "error" }, reasonCode);
          errorRetryROI = assessRetryExpectedROI({
            attempt: Number(instruction.reworkAttempt || 0) + 1,
            maxRetries: resolveAdaptiveRetryCap(exitClassification.classification.primaryClass, config),
            taskKind: instruction.taskKind || "general",
            premiumUsageData: loadPremiumUsageEntries(config),
            benchmarkGroundTruth: loadBenchmarkGroundTruthSignal(config),
            promptCacheHitRate: promptCacheSignal.hitRate,
            promptCacheSavedTokens: promptCacheSignal.avgSavedTokens,
            lowRoiSignalCount: failureFinishSignal.lowRoiSignalCount,
            failureClass: exitClassification.classification.primaryClass,
            finishCode,
          });
          errorRetryDecision = applyRetrySignalTuning(rd.decision, {
            promptCacheHitRate: promptCacheSignal.hitRate,
            promptCacheSavedTokens: promptCacheSignal.avgSavedTokens,
            retryExpectedGain: errorRetryROI.expectedGain,
            retryThreshold: errorRetryROI.threshold,
            lowRoiSignalCount: failureFinishSignal.lowRoiSignalCount,
            latestFailureClass: exitClassification.classification.primaryClass,
            latestFinishCode: finishCode,
          });
          errorRetryDecision = applyRetryROIGate(errorRetryDecision, errorRetryROI);
          persistRetryMetric(config, errorRetryDecision);
          appendFailureClassification(config, {
            ...exitClassification.classification,
            taskKind: instruction.taskKind || "general",
            roleName: String(roleName || "worker"),
            lineageId: _dispatchLineageId,
            lineage: runtimeLineage.lineage,
            lineageJoinKey: runtimeLineage.lineageJoinKey,
            finishStatus: isTransient ? "transient_error" : "error",
            finishCode,
            retryRoiExpectedGain: errorRetryROI.expectedGain,
            retryRoiThreshold: errorRetryROI.threshold,
            retryRoiAllowed: errorRetryROI.allowRetry,
            retryAction: errorRetryDecision?.retryAction ?? null,
          }).catch(() => { /* non-fatal */ });
        }
      }
    } catch { /* non-fatal */ }

    // Build unified failure envelope for observability and postmortem analysis
    try {
      const terminationCause = result.timedOut ? TERMINATION_CAUSE.TIMEOUT : TERMINATION_CAUSE.ERROR;
      const cfResult2 = classifyFailure({
        workerStatus: "error",
        blockingReasonClass: BLOCKING_REASON_CLASS.WORKER_ERROR,
        errorMessage: errorMsg,
        logLines: result.timedOut ? ["Process timed out"] : [],
        failurePhase: errorPhaseRetryState.failedPhase,
        phaseEvidence: errorPhaseRetryState.evidence,
        taskId: instruction.taskId || null,
        attemptMeta,
      });
      const envelope = buildFailureEnvelope(
        cfResult2.ok ? cfResult2.classification : null,
        errorRetryDecision,
        terminationCause,
        instruction.taskId || null,
        attemptMeta,
        errorPhaseRetryState,
      );
      appendFailureClassification(config, { ...envelope, _type: "failure_envelope" }).catch(() => { /* non-fatal */ });
    } catch { /* non-fatal — envelope build must never block worker results */ }

    updatedHistory.push({
      from: roleName,
      content: `ERROR: ${errorMsg}`,
      timestamp: new Date().toISOString(),
      status: "error"
    });
    try {
      await realizeRouteROIEntry(config, routingTaskId, 0, isTransient ? "transient_error" : "error");
    } catch {
      // non-critical routing telemetry
    }
    await persistPhaseAwareRetryArtifacts(config, {
      roleName,
      instruction,
      status: isTransient ? "transient_error" : "error",
      retryAction: errorRetryDecision?.retryAction || null,
      failureClass: errorRetryDecision?.failureClass || null,
      retryState: errorPhaseRetryState,
    }).catch(() => {});
    await persistLegacyWorkerSessionArtifacts(config, String(roleName || "worker"), {
      phase: "complete",
      task: String(instruction?.task || ""),
      status: isTransient ? "transient_error" : "error",
      pr: null,
      dispatchBlockReason: null,
    });
    return {
      status: isTransient ? "transient_error" : "error",
      summary: errorMsg,
      updatedHistory,
      prUrl: null,
      tier,
      reasonCode,
      retryClass,
      failureClassification: null,
      retryDecision: errorRetryDecision
    };
  }

  // Save raw output for debugging — include runId so attempt lineages can be correlated.
  // This file is overwritten each attempt; resetAttemptBoundary below clears stale
  // attempt-scoped checkpoints so replay state stays deterministic.
  try {
    writeFileSync(
      path.join(config.paths?.stateDir || "state", `debug_worker_${roleName.replace(/\s+/g, "_")}.txt`),
      `TASK: ${instruction.task}\nRUN_ID: ${runId}\nATTEMPT: ${attempt}\n\nOUTPUT:\n${stdout}`,
      "utf8"
    );
  } catch { /* non-critical */ }

  // Reset attempt-scoped boundary checkpoint so retries begin from a clean slate.
  try {
    const checkpointThreadId = String(instruction?.taskId || instruction?.lineageId || roleName || "");
    if (checkpointThreadId) {
      await resetAttemptBoundary(config, {
        thread_id: checkpointThreadId,
        checkpoint_ns: CHECKPOINT_NS.ATTEMPT,
      });
    }
  } catch { /* non-critical — checkpoint reset must never block result path */ }

  const parsed: ParsedWorkerResponse = parseWorkerResponse(stdout, stderr);
  const cleanTreeSupplement = await supplementCleanTreeEvidenceIfMissing(config, parsed, instruction);
  if (cleanTreeSupplement.applied) {
    await appendProgress(
      config,
      `[WORKER:${roleName}] Deterministic clean-tree evidence supplemented mode=${cleanTreeSupplement.mode}`
    );
  }
  const cleanTreeTargetFiles = resolveCleanTreeEvidenceTargets(parsed, instruction);
  const artifactEvidence = checkPostMergeArtifact(parsed.fullOutput || "", {
    expectedTargetFiles: cleanTreeTargetFiles,
  });
  const replayClosure = buildReplayClosureEvidence(parsed.fullOutput || "", artifactEvidence);
  const normalizedWorkerStatus = String(parsed.status || "").toLowerCase();
  // Closure boundary enforcement: a done worker must include self-reported closure fields
  // (BOX_EXPECTED_OUTCOME, BOX_ACTUAL_OUTCOME, BOX_DEVIATION). Missing fields block finalization.
  const closureFieldCheck = checkWorkerOutputClosureFields(parsed.fullOutput || "");
  const closureBoundaryViolation =
    (normalizedWorkerStatus === "done" || normalizedWorkerStatus === "success")
    && !closureFieldCheck.valid;
  if (closureBoundaryViolation) {
    parsed.status = "partial";
    parsed.summary = `[CLOSURE BOUNDARY] done blocked — missing required closure fields: ${closureFieldCheck.missingFields.join(", ")}\n${parsed.summary}`;
    await appendProgress(config,
      `[WORKER:${roleName}] CLOSURE_BOUNDARY_VIOLATION — done downgraded to partial — missing: ${closureFieldCheck.missingFields.join(", ")}`
    );
  }
  const dispatchContract: DispatchVerificationContract = {
    doneWorkerWithVerificationReportEvidence:
      (normalizedWorkerStatus === "done" || normalizedWorkerStatus === "success")
      && hasVerificationReportEvidence(parsed.fullOutput || ""),
    doneWorkerWithCleanTreeStatusEvidence:
      (normalizedWorkerStatus === "done" || normalizedWorkerStatus === "success")
      && parsed.cleanTreeStatus === true,
    dispatchBlockReason: normalizedWorkerStatus === "blocked"
      ? (parsed.dispatchBlockReason || "worker_reported_blocked_without_reason")
      : null,
    dispatchBlockReasonContract: normalizedWorkerStatus === "blocked"
      ? parseDispatchBlockReasonContract(parsed.dispatchBlockReason || "worker_reported_blocked_without_reason")
      : null,
    closureBoundaryViolation,
    replayClosure: {
      contractSatisfied: replayClosure.contractSatisfied === true,
      canonicalCommands: Array.isArray(replayClosure.canonicalCommands) ? replayClosure.canonicalCommands : [],
      executedCommands: Array.isArray(replayClosure.executedCommands) ? replayClosure.executedCommands : [],
      rawArtifactEvidenceLinks: Array.isArray(replayClosure.rawArtifactEvidenceLinks) ? replayClosure.rawArtifactEvidenceLinks : [],
    },
  };

  // Soft-fail policy: if only API access is blocked for any worker,
  // attempt an orchestrator-side recovery: commit the dirty working tree to a
  // feature branch and open a PR using the host process's git/gh access.
  // This prevents work being silently discarded when the subagent's CLI is blocked.
  if (
    parsed.status === "blocked"
    && Array.isArray(parsed.blockedAccessScopes)
    && parsed.blockedAccessScopes.length === 1
    && String(parsed.blockedAccessScopes[0] || "") === "api"
  ) {
    parsed.status = "partial";
    parsed.summary = `[ACCESS SOFTENED] api-only access block downgraded to partial to avoid cycle stall\n${parsed.summary}`;
    await appendProgress(config, `[WORKER:${roleName}] ACCESS_SOFTENED api-only block → partial (non-blocking)`);

    // Recovery: if the worker left uncommitted changes, commit and push them here.
    try {
      const cwd = workerExecutionCwd;
      const statusResult = await spawnAsync("git", ["status", "--porcelain"], { cwd }) as SpawnAsyncResult;
      const isDirty = String(statusResult?.stdout || "").trim().length > 0;
      if (isDirty && !parsed.prUrl) {
        const slug = String(roleName || "worker").toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const ts = Date.now();
        const branch = `recovery/${slug}-${ts}`;
        await spawnAsync("git", ["checkout", "-b", branch], { cwd }) as SpawnAsyncResult;
        await spawnAsync("git", ["add", "-A"], { cwd }) as SpawnAsyncResult;
        const commitMsg = `chore: ${roleName} changes (api-blocked orchestrator recovery)`;
        await spawnAsync("git", ["commit", "-m", commitMsg], { cwd }) as SpawnAsyncResult;
        await spawnAsync("git", ["push", "-u", "origin", branch], { cwd }) as SpawnAsyncResult;
        const prTitle = `[${roleName}] api-blocked recovery — automated commit`;
        const prBody = `Orchestrator auto-committed uncommitted changes after worker reported api:blocked.\n\nOriginal task: ${String(instruction.task || "").slice(0, 200)}`;
        const prResult = await spawnAsync("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", prTitle, "--body", prBody], { cwd }) as SpawnAsyncResult;
        const prUrl = String(prResult?.stdout || "").trim().match(/https:\/\/\S+/)?.[0] || null;
        if (prUrl) {
          parsed.prUrl = prUrl;
          parsed.summary = `[ACCESS RECOVERY] orchestrator opened PR from dirty tree: ${prUrl}\n${parsed.summary}`;
          await appendProgress(config, `[WORKER:${roleName}] ACCESS_RECOVERY pr-opened branch=${branch} pr=${prUrl}`);
        }
      }
    } catch (recoveryErr) {
      // Recovery is best-effort — never block the cycle on git/gh failures
      await appendProgress(config, `[WORKER:${roleName}] ACCESS_RECOVERY failed (non-fatal): ${String((recoveryErr as Error)?.message || recoveryErr).slice(0, 120)}`).catch(() => {});
    }
  }

  // If access was reported as blocked, persist a structured escalation (non-critical)
  if (parsed.status === "blocked" && /BOX_ACCESS=[^\n]*blocked/i.test(stdout)) {
    appendEscalation(config, {
      role: roleName,
      task: instruction.task,
      blockingReasonClass: BLOCKING_REASON_CLASS.ACCESS_BLOCKED,
      attempts: Number(instruction.reworkAttempt || 0),
      nextAction: NEXT_ACTION.RETRY,
      summary: "Worker reported BOX_ACCESS blocked"
    }).catch(() => { /* non-fatal */ });
  }

  const windowsGlobArtifact = classifyNodeTestGlobWindowsArtifact(stdout);
  if (parsed.status === "blocked" && windowsGlobArtifact.isArtifact && windowsGlobArtifact.hasNpmTestPassEvidence) {
    parsed.status = "partial";
    parsed.summary = `[VERIFICATION NORMALIZED] node --test glob failure classified as Windows shell-expansion artifact; npm test passed evidence detected\n${parsed.summary}`;
    await appendProgress(config, `[WORKER:${roleName}] VERIFICATION_NORMALIZED windows-node-test-glob-artifact`);
  }

  // Policy gate: protected path changes require reviewer approval,
  // so workers cannot auto-finish these changes as fully done.
  try {
    const policy = await loadPolicy(config);
    if (policy?.requireReviewerApprovalForProtectedPaths) {
      const protectedTouched = getProtectedPathMatches(policy, parsed.filesTouched);
      if (protectedTouched.length > 0 && parsed.status === "done") {
        parsed.status = "partial";
        parsed.summary = `Reviewer approval required for protected paths: ${protectedTouched.join(", ")}\n${parsed.summary}`;
      }
    }

    const pathViolations = getRolePathViolations(policy, roleName, parsed.filesTouched);
    if (pathViolations.hasViolation) {
      const deniedPreview = pathViolations.deniedMatches.slice(0, 3).join(", ");
      const outsidePreview = pathViolations.outsideAllowed.slice(0, 3).join(", ");
      const violationSummary = [
        pathViolations.deniedMatches.length > 0 ? `denied paths: ${deniedPreview}${pathViolations.deniedMatches.length > 3 ? " ..." : ""}` : "",
        pathViolations.outsideAllowed.length > 0 ? `outside allowed paths: ${outsidePreview}${pathViolations.outsideAllowed.length > 3 ? " ..." : ""}` : ""
      ].filter(Boolean).join(" | ");

      parsed.status = "blocked";
      parsed.summary = `Role path policy violation for ${roleName}: ${violationSummary}\n${parsed.summary}`;

      // Persist structured escalation for policy violations (non-critical)
      appendEscalation(config, {
        role: roleName,
        task: instruction.task,
        blockingReasonClass: BLOCKING_REASON_CLASS.POLICY_VIOLATION,
        attempts: Number(instruction.reworkAttempt || 0),
        nextAction: NEXT_ACTION.ESCALATE_TO_HUMAN,
        summary: `Role path policy violation: ${violationSummary}`,
        prUrl: parsed.prUrl
      }).catch(() => { /* non-fatal */ });
    }

    const targetExecutionRuntimeGuard = evaluateTargetExecutionBoundary({
      changedFiles: Array.isArray(parsed.filesTouched) ? parsed.filesTouched : [],
      taskKind: instruction?.taskKind,
      task: instruction?.task,
      context: instruction?.context,
      verification: instruction?.verification,
    }, config);
    if (targetExecutionRuntimeGuard.active && !targetExecutionRuntimeGuard.allowed) {
      const guardSummary = targetExecutionRuntimeGuard.blocked.join("; ");
      parsed.status = "blocked";
      parsed.dispatchBlockReason = targetExecutionRuntimeGuard.dispatchBlockReason || "target_execution_guard:runtime_scope";
      parsed.summary = `[TARGET_EXECUTION_GUARD] ${guardSummary}\n${parsed.summary}`;
      dispatchContract.doneWorkerWithVerificationReportEvidence = false;
      dispatchContract.doneWorkerWithCleanTreeStatusEvidence = false;
      dispatchContract.dispatchBlockReason = parsed.dispatchBlockReason;
      dispatchContract.dispatchBlockReasonContract = parseDispatchBlockReasonContract(parsed.dispatchBlockReason);
      await appendProgress(config, `[WORKER:${roleName}] TARGET_EXECUTION_GUARD blocked runtime scope: ${guardSummary}`);
      appendEscalation(config, {
        role: roleName,
        task: instruction.task,
        blockingReasonClass: BLOCKING_REASON_CLASS.POLICY_VIOLATION,
        attempts: Number(instruction.reworkAttempt || 0),
        nextAction: NEXT_ACTION.ESCALATE_TO_HUMAN,
        summary: `Target execution guard breach: ${guardSummary}`,
        prUrl: parsed.prUrl
      }).catch(() => { /* non-fatal */ });
    }

    const selfDevRuntimeGuard = evaluateSelfDevProtectionBoundary({
      changedFiles: Array.isArray(parsed.filesTouched) ? parsed.filesTouched : [],
      changedFilesCount: Array.isArray(parsed.filesTouched) ? parsed.filesTouched.length : 0,
      branchName: parsed.currentBranch || sessionState?.currentBranch || null,
    }, config);
    if (selfDevRuntimeGuard.active && selfDevRuntimeGuard.warnings.length > 0) {
      await appendProgress(
        config,
        `[WORKER:${roleName}] SELF_DEV_GUARD caution runtimeScope=${selfDevRuntimeGuard.warnings.slice(0, 3).join("; ")}`
      );
    }
    if (selfDevRuntimeGuard.active && !selfDevRuntimeGuard.allowed) {
      const guardSummary = selfDevRuntimeGuard.blocked.join("; ");
      parsed.status = "blocked";
      parsed.dispatchBlockReason = "self_dev_guard_breach:runtime_scope";
      parsed.summary = `[SELF_DEV_GUARD] ${guardSummary}\n${parsed.summary}`;
      dispatchContract.doneWorkerWithVerificationReportEvidence = false;
      dispatchContract.doneWorkerWithCleanTreeStatusEvidence = false;
      dispatchContract.dispatchBlockReason = parsed.dispatchBlockReason;
      dispatchContract.dispatchBlockReasonContract = parseDispatchBlockReasonContract(parsed.dispatchBlockReason);
      await appendProgress(config, `[WORKER:${roleName}] SELF_DEV_GUARD blocked runtime scope: ${guardSummary}`);
      appendEscalation(config, {
        role: roleName,
        task: instruction.task,
        blockingReasonClass: BLOCKING_REASON_CLASS.POLICY_VIOLATION,
        attempts: Number(instruction.reworkAttempt || 0),
        nextAction: NEXT_ACTION.ESCALATE_TO_HUMAN,
        summary: `Self-dev guard breach: ${guardSummary}`,
        prUrl: parsed.prUrl
      }).catch(() => { /* non-fatal */ });
    }

    // Runtime hook telemetry is currently advisory only. The runner can audit
    // self-reported TOOL_INTENT / HOOK_DECISION lines when present, but Copilot
    // CLI does not expose authoritative per-tool execution events here. That
    // means missing or malformed pseudo-telemetry must not downgrade a done
    // result; otherwise checkpoint resume can loop forever after successful work.
    const hookTelemetry = parsed.toolExecutionTelemetry && typeof parsed.toolExecutionTelemetry === "object"
      ? parsed.toolExecutionTelemetry
      : { envelopes: [], hookDecisions: [], deniedDecisions: [], gaps: [], hasDeterministicCoverage: false };
    if (Array.isArray(hookTelemetry.envelopes)) {
      const hookEnforcement = enforcePreExecuteHookDecisions(policy, roleName, hookTelemetry.envelopes);
      const hookAudit = auditRuntimeHookEnforcement(hookEnforcement.decisions, hookTelemetry.hookDecisions);
      const recordHookCoverageAudit = shouldRecordHookCoverageAudit({
        telemetry: hookTelemetry,
        runtimeDecisions: hookEnforcement.decisions,
        runtimeAuditGaps: hookAudit.gaps,
      });
      const hookCoverageAudit = recordHookCoverageAudit
        ? auditAuthoritativeHookCoverage({
            sessionInputPolicy: effectiveSessionInputPolicy,
            hookCoverage: agentProfile.hookCoverage,
            telemetry: hookTelemetry,
            runtimeDecisions: hookEnforcement.decisions,
            runtimeAuditGaps: hookAudit.gaps,
          })
        : null;
      parsed.toolExecutionTelemetry = hookTelemetry;
      (parsed as any).hookCoverageAudit = hookCoverageAudit;
      (parsed as any).runtimeHookAudit = recordHookCoverageAudit ? hookAudit : null;
    }
  } catch {
    // Non-fatal: if policy cannot be read, keep existing worker result.
  }

  // Auto-resolve transient ACCESS_BLOCKED escalations once the same worker+task
  // completes or partially completes in a later retry.
  if (shouldResolveRecoveredWorkerEscalations(parsed.status)) {
    resolveEscalationsForTask(config, {
      role: roleName,
      task: instruction.task,
      blockingReasonClass: BLOCKING_REASON_CLASS.ACCESS_BLOCKED,
      resolutionSummary: `Worker recovered with status=${parsed.status}`,
      resolvedBy: `worker:${roleName}`,
    }).catch(() => { /* non-fatal */ });
    resolveEscalationsForTask(config, {
      role: roleName,
      task: instruction.task,
      blockingReasonClass: BLOCKING_REASON_CLASS.WORKER_ERROR,
      resolutionSummary: `Worker recovered after runtime failure with status=${parsed.status}`,
      resolvedBy: `worker:${roleName}`,
    }).catch(() => { /* non-fatal */ });
  }

  // ── Rework budget — pre-computed so both gates share the same values ─────────
  // Declared here (before the artifact gate) so the artifact gate can decide
  // whether to hard-block or to defer to the rework loop.
  const requireTaskContract = config?.runtime?.requireTaskContract !== false;
  const maxReworkAttempts = Number(config?.runtime?.maxReworkAttempts ?? 2);
  // reworkAttempt is set by buildReworkInstruction on re-dispatches; 0 on the first call
  const currentAttempt = Number(instruction.reworkAttempt || 0);

  if ((parsed as any).unsupportedUpstreamCiDeferral === true) {
    const canRetry = currentAttempt < maxReworkAttempts;
    parsed.status = canRetry ? "partial" : "blocked";
    parsed.dispatchBlockReason = UNSUPPORTED_UPSTREAM_CI_DEFERRAL_REASON;
    parsed.summary = `[CI OWNERSHIP] Unsupported upstream-only PR failure deferral. A red PR must be reproduced and repaired on the task branch unless an external outage, permission block, or missing access prevents action.\n${parsed.summary}`;
    await appendProgress(
      config,
      `[WORKER:${roleName}] CI_OWNERSHIP_ENFORCED upstream-only PR deferral rejected retry=${canRetry ? "queued" : "exhausted"}`
    );
  }

  // ── Unconditional artifact gate (strict merge evidence gate) ─────────────────
  // For any worker+task combination that requires a post-merge artifact
  // (determined by role kind AND task kind), this gate is NON-BYPASSABLE —
  // it runs regardless of config.runtime.requireTaskContract.
  //
  // Discovery-safe task kinds (scan, doc, observation, diagnosis, discovery,
  // research, review, audit) are exempt even for done-capable roles, eliminating
  // false completion loss on read-only / non-merge tasks (adaptive throttle bypass).
  //
  // Rework routing: when the verification gate and rework budget are both active
  // (requireTaskContract=true, currentAttempt < maxReworkAttempts), the artifact
  // gate does NOT hard-block immediately — it keeps parsed.status="done" so that
  // validateWorkerContract catches the same gaps and decideRework can dispatch a
  // targeted rework instruction to the worker.  Only when rework is exhausted (or
  // the verification gate is disabled) does the gate hard-block.
  //
  // Explicit telemetry is emitted for all gate outcomes:
  //   - discoveryBypass=true  → non-merge task; artifact gate skipped
  //   - rework-queued         → artifact missing but rework budget remains
  //   - hard-blocked          → artifact missing and rework exhausted / gate disabled
  //
  // The artifact is computed once here and reused by both this gate and the
  // subsequent validateWorkerContract call, avoiding duplicate evaluation.
  const scopedTargetFiles = cleanTreeTargetFiles;
  const isArtifactRequired = parsed.status === "done" && isArtifactGateRequired(workerKind ?? "unknown", instruction.taskKind);
  const precomputedArtifact = isArtifactRequired
    ? checkPostMergeArtifact(parsed.fullOutput || parsed.summary || "", {
        expectedTargetFiles: scopedTargetFiles,
      })
    : undefined;

  // Telemetry: emit bypass signal when discovery-safe task passes without artifact check
  if (parsed.status === "done" && !isArtifactRequired && isDiscoverySafeTask(instruction.taskKind)) {
    try {
      appendProgress(config,
        `[ARTIFACT GATE] ${roleName} taskKind=${instruction.taskKind} discoveryBypass=true — non-merge task bypasses artifact gate`
      );
    } catch { /* non-critical */ }
  }

  if (isArtifactRequired) {
    const artifact = precomputedArtifact!;
    if (!artifact.hasArtifact) {
      const artifactGaps = collectArtifactGaps(artifact);

      // Rework-capable path: verification gate is active and worker still has budget.
      // Keep status="done" so validateWorkerContract feeds artifact gaps into decideRework
      // with a targeted prompt.  Hard-block only when rework is exhausted or disabled.
      const canRework = requireTaskContract && currentAttempt < maxReworkAttempts;

      try {
        appendProgress(config,
          `[ARTIFACT GATE] ${roleName} ${canRework ? "rework-queued" : "hard-blocked"} taskKind=${instruction.taskKind || "unknown"} discoveryBypass=false hasSha=${artifact.hasSha} hasTestOutput=${artifact.hasTestOutput} gaps=${artifactGaps.length}`
        );
      } catch { /* non-critical */ }

      if (!canRework) {
        parsed.status = "blocked";
        parsed.summary = `[ARTIFACT GATE] done hard-blocked — ${artifactGaps.join("; ")}\n${parsed.summary}`;
      }
      // When canRework=true: status stays "done"; validateWorkerContract will catch
      // the same artifact gaps via collectArtifactGaps(precomputedArtifact) and
      // decideRework will build a targeted rework instruction for the worker.

      // Write structured audit entry so all artifact gate outcomes are traceable
      // in verification_audit.json alongside the soft-verify path entries.
      try {
        const auditPath = path.join(config.paths?.stateDir || "state", "verification_audit.json");
        let audit: unknown[] = [];
        try {
          if (existsSync(auditPath)) {
            const raw = readFileSync(auditPath, "utf8");
            const parsed2 = JSON.parse(raw);
            if (Array.isArray(parsed2)) audit = parsed2;
          }
        } catch { audit = []; }
        audit.push(buildArtifactAuditEntry(artifact, artifactGaps, {
          gateSource: canRework ? "rework-queued" : "hard-block",
          workerKind: workerKind ?? "unknown",
          roleName: String(roleName),
          taskId: instruction.taskId || null,
          taskSnippet: String(instruction.task || "").slice(0, 100),
        }));
        if (audit.length > 200) audit = audit.slice(-200);
        writeFileSync(auditPath, JSON.stringify(audit, null, 2), "utf8");
      } catch { /* non-critical */ }
    }
  }

  // ── Verification gate — evidence-based done acceptance ──────────────────────
  // Feature-flagged via config.runtime.requireTaskContract (default: true).
  // Rework threshold: config.runtime.maxReworkAttempts (default: 2, per Athena AC#2 concern).
  // Evidence snapshot schema includes profile, report fields, gaps, attempt, and timestamp (AC#4).
  // requireTaskContract / maxReworkAttempts / currentAttempt declared above (shared with artifact gate).
  // Cooperative cancellation: honour any in-flight stop signal before entering the
  // verification path — this step is NON_RETRYABLE so we must not begin if torn down.
  checkCancellationAtVerification(_token);
  if (requireTaskContract && parsed.status === "done") {

    // Artifact check is mandatory for all done-capable workers, even when workerKind is unknown.
    // Unknown workerKind falls back to the DEFAULT_PROFILE (build required, others optional).
    // Task kind is passed through so non-merge tasks (scan, doc, etc.) skip the artifact gate.
    // verificationText is passed from the packet's verification field so the named-test-proof gate
    // fires when the packet names a specific test file/description in its verification commands.
    // precomputedArtifact is reused from the hard-block gate above to avoid evaluating the same
    // output string twice.
    const effectiveKind = workerKind ?? "unknown";
    const validationResult = validateWorkerContract(effectiveKind, {
      status: parsed.status,
      fullOutput: parsed.fullOutput,
      summary: parsed.summary
    }, {
      gatesConfig: config?.gates as Record<string, unknown> | undefined,
      taskKind: instruction.taskKind,
      verificationText: String(instruction.verification || "").trim() || null,
      precomputedArtifact,
      taskTargets: scopedTargetFiles,
    });

    // Evidence snapshot for audit (AC#4 defined schema)
    const postMergeArtifact = validationResult.evidence?.postMergeArtifact as ReturnType<typeof checkPostMergeArtifact> | undefined;
    const verificationEvidence: VerificationEvidence = {
      profile: String(validationResult.evidence?.profile || effectiveKind),
      hasReport: Boolean(validationResult.evidence?.hasReport),
      report: validationResult.evidence?.report || {},
      responsiveMatrix: validationResult.evidence?.responsiveMatrix || {},
      prUrl: (validationResult.evidence?.prUrl as string | null) ?? null,
      gaps: validationResult.gaps,
      passed: validationResult.passed,
      attempt: currentAttempt,
      validatedAt: new Date().toISOString(),
      roleName: String(roleName),
      taskSnippet: String(instruction.task || "").slice(0, 100),
      optionalFieldFailures: Array.isArray(validationResult.evidence?.optionalFieldFailures)
        ? (validationResult.evidence.optionalFieldFailures as string[])
        : [],
      toolExecutionTelemetry: validationResult.evidence?.toolExecutionTelemetry ?? null,
      hookCoverageAudit: (parsed as any).hookCoverageAudit ?? null,
      artifactDetail: postMergeArtifact ? {
        hasSha: postMergeArtifact.hasSha,
        hasTestOutput: postMergeArtifact.hasTestOutput,
        hasCleanTreeEvidence: postMergeArtifact.hasCleanTreeEvidence,
        hasTaskScopedCleanTreeEvidence: (postMergeArtifact as any).hasTaskScopedCleanTreeEvidence === true,
        cleanTreeMode: String((postMergeArtifact as any).cleanTreeMode || "missing"),
        taskScopedCleanTargets: Array.isArray((postMergeArtifact as any).taskScopedCleanTargets)
          ? (postMergeArtifact as any).taskScopedCleanTargets as string[]
          : [],
        hasReplayAttachEvidence: (postMergeArtifact as any).hasReplayAttachEvidence === true,
        hasExplicitTestOutputBlock: postMergeArtifact.hasExplicitTestBlock,
        hasUnfilledPlaceholder: postMergeArtifact.hasUnfilledPlaceholder,
        hasExplicitShaMarker: postMergeArtifact.hasExplicitShaMarker,
        hasExplicitTestBlock: postMergeArtifact.hasExplicitTestBlock,
        mergedSha: postMergeArtifact.mergedSha ?? null,
      } : null,
    };

    // Persist evidence snapshot for audit trail (non-critical, keep last 200 entries)
    try {
      const auditPath = path.join(config.paths?.stateDir || "state", "verification_audit.json");
      let audit = [];
      try {
        if (existsSync(auditPath)) {
          audit = JSON.parse(readFileSync(auditPath, "utf8"));
          if (!Array.isArray(audit)) audit = [];
        }
      } catch { audit = []; }
      audit.push(verificationEvidence);
      if (audit.length > 200) audit = audit.slice(-200);
      writeFileSync(auditPath, JSON.stringify(audit, null, 2), "utf8");
    } catch { /* non-critical */ }

    const reworkDecision = decideRework(validationResult, instruction.task, currentAttempt, maxReworkAttempts);
    const telemetryOutcome = resolvePostVerificationTelemetryOutcome(parsed.status, reworkDecision);

    if (reworkDecision.shouldEscalate) {
      // Max rework attempts exhausted — block the task instead of looping
      parsed.status = "blocked";
      parsed.summary = `[VERIFICATION GATE] Escalated after ${currentAttempt} failed attempt(s). ${reworkDecision.escalationReason}\n${parsed.summary}`;

      // Persist structured escalation payload (non-critical write)
      appendEscalation(config, {
        role: roleName,
        task: instruction.task,
        blockingReasonClass: BLOCKING_REASON_CLASS.MAX_REWORK_EXHAUSTED,
        attempts: currentAttempt,
        nextAction: NEXT_ACTION.ESCALATE_TO_HUMAN,
        summary: reworkDecision.escalationReason || validationResult.gaps.slice(0, 3).join("; "),
        prUrl: parsed.prUrl
      }).catch(() => { /* non-fatal */ });
    } else if (reworkDecision.shouldRework) {
      const verificationRetryState = buildPhaseAwareRetryState({
        instruction,
        parsed: {
          ...parsed,
          verificationEvidence,
        },
        statusOverride: "verification_failed",
        retryAction: RETRY_ACTION.REWORK,
        failureClass: FAILURE_CLASS.VERIFICATION,
        failedPhaseOverride: WORKER_EXECUTION_PHASE.TEST,
        verificationEvidence,
      });
      // Push the failed attempt into history so the worker sees context on rework
      updatedHistory.push({
        from: roleName,
        content: `[VERIFICATION FAILED — attempt ${currentAttempt + 1}/${maxReworkAttempts}] ${truncate(parsed.summary, 400)}`,
        fullOutput: parsed.fullOutput,
        prUrl: parsed.prUrl,
        timestamp: new Date().toISOString(),
        status: "verification_failed",
        verificationEvidence
      });
      await appendProgress(config,
        `[WORKER:${roleName}] Verification failed (attempt ${currentAttempt + 1}/${maxReworkAttempts}) — gaps: ${validationResult.gaps.slice(0, 2).join("; ")}`
      );
      logPremiumUsage(config, roleName, model, instruction.taskKind, Date.now() - startMs, {
        outcome: telemetryOutcome,
        taskId: instruction.taskId || instruction.task || null,
        lineageId: _dispatchLineageId,
        lineage: runtimeLineage.lineage,
        lineageJoinKey: runtimeLineage.lineageJoinKey,
      });
      updateMemoryHitOutcome(config, _memoryHitTaskId || null, telemetryOutcome);
      try {
        await realizeRouteROIEntry(
          config,
          routingTaskId,
          deriveOutcomeQualityScore(telemetryOutcome, verificationEvidence, dispatchContract),
          telemetryOutcome,
        );
      } catch {
        // non-critical routing telemetry
      }
      await persistPhaseAwareRetryArtifacts(config, {
        roleName,
        instruction,
        status: "verification_failed",
        retryAction: RETRY_ACTION.REWORK,
        failureClass: FAILURE_CLASS.VERIFICATION,
        retryState: verificationRetryState,
      }).catch(() => {});
      // Re-dispatch with rework instruction; recursive depth is bounded by maxReworkAttempts
      return runWorkerConversation(config, roleName, reworkDecision.instruction, updatedHistory, sessionState);
    }

    parsed.verificationEvidence = verificationEvidence;
  }

  const finalTelemetryOutcome = resolvePostVerificationTelemetryOutcome(parsed.status);
  logPremiumUsage(config, roleName, model, instruction.taskKind, Date.now() - startMs, {
    outcome: finalTelemetryOutcome,
    taskId: instruction.taskId || instruction.task || null,
    lineageId: _dispatchLineageId,
    lineage: runtimeLineage.lineage,
    lineageJoinKey: runtimeLineage.lineageJoinKey,
  });
  updateMemoryHitOutcome(config, _memoryHitTaskId || null, finalTelemetryOutcome);

  await appendLiveWorkerLog(
    config,
    liveLogPath,
    roleName,
    `\n[${new Date().toISOString()}] END status=${parsed.status}${parsed.prUrl ? ` pr=${parsed.prUrl}` : ""}\n`
  );

  await appendProgress(config,
    `[WORKER:${roleName}] Completed status=${parsed.status}${parsed.prUrl ? ` PR=${parsed.prUrl}` : ""}`
  );

  await persistLegacyWorkerSessionArtifacts(config, String(roleName || "worker"), {
    phase: "complete",
    task: String(instruction?.task || ""),
    status: String(parsed.status || "unknown"),
    pr: parsed.prUrl || null,
    dispatchBlockReason: dispatchContract.dispatchBlockReason,
  });

  // ── Optional lineage graph recording (non-blocking; rollback via config.runtime.lineageGraphEnabled=false) ──
  // Only records when instruction.taskId is provided. Safe to skip — lineage is observability,
  // not execution state. On any failure, warn and continue.
  if (config?.runtime?.lineageGraphEnabled !== false && instruction.taskId) {
    try {
      const fp = buildTaskFingerprint(instruction.taskKind || "general", instruction.task || "");
      const attempt = Number(instruction.reworkAttempt || 0) + 1;
      const taskId = Number(instruction.taskId);
      const parentId = instruction.parentLineageId || null;
      const rootId = Number(instruction.lineageRootId || taskId);
      const depth = Number(instruction.lineageDepth || instruction.reworkAttempt || 0);
      const splitAncestry = Array.isArray(instruction.splitAncestry) ? instruction.splitAncestry : [];

      // Map worker result status to lineage entry status
      const statusMap = { done: LINEAGE_ENTRY_STATUS.PASSED, blocked: LINEAGE_ENTRY_STATUS.BLOCKED, error: LINEAGE_ENTRY_STATUS.FAILED };
      const entryStatus = statusMap[parsed.status] || LINEAGE_ENTRY_STATUS.FAILED;

      const lineageEntry = {
        id: _dispatchLineageId || buildLineageId(fp, taskId, attempt),
        taskId,
        semanticKey: String(instruction.semanticKey || `${instruction.taskKind || "general"}::${fp.slice(0, 16)}`),
        fingerprint: fp,
        parentId,
        rootId,
        depth,
        status: entryStatus,
        timestamp: new Date().toISOString(),
        failureReason: (entryStatus === LINEAGE_ENTRY_STATUS.FAILED || entryStatus === LINEAGE_ENTRY_STATUS.BLOCKED)
          ? truncate(parsed.summary || "unknown failure", 200)
          : null,
        splitAncestry
      };

      await appendLineageEntry(config, lineageEntry);
    } catch (lineageErr) {
      // Lineage recording failures are non-fatal — log but never block execution
      await appendProgress(config, `[LINEAGE] recording failed (non-fatal): ${String(lineageErr?.message || lineageErr)}`).catch(() => {});
    }
  }

  // Classify failure for error/blocked/partial statuses (non-critical)
  let failureClassification = null;
  let retryDecision = null;
  let phaseRetryState = null;
  if (parsed.status === "error" || parsed.status === "blocked" || parsed.status === "partial") {
    const nonRetryablePolicyBlock = parsed.status === "blocked"
      && isNonRetryablePolicyBlockReason(parsed.dispatchBlockReason);
    phaseRetryState = buildPhaseAwareRetryState({
      instruction,
      parsed: {
        ...parsed,
        verificationEvidence: parsed.verificationEvidence || null,
      },
      verificationEvidence: parsed.verificationEvidence || null,
    });

    // Derive blockingReasonClass from the escalation that was persisted (best-effort)
    let derivedRc = null;
    if (parsed.status === "blocked") {
      // Check common markers in summary text
      if (/policy violation|path policy/i.test(parsed.summary)) {
        derivedRc = BLOCKING_REASON_CLASS.POLICY_VIOLATION;
      } else if (/BOX_ACCESS.*blocked/i.test(parsed.fullOutput || "")) {
        derivedRc = BLOCKING_REASON_CLASS.ACCESS_BLOCKED;
      } else if (/rework.*exhausted|max rework/i.test(parsed.summary)) {
        derivedRc = BLOCKING_REASON_CLASS.MAX_REWORK_EXHAUSTED;
      } else if (/verification gate/i.test(parsed.summary)) {
        derivedRc = BLOCKING_REASON_CLASS.VERIFICATION_GATE;
      } else if (nonRetryablePolicyBlock) {
        derivedRc = BLOCKING_REASON_CLASS.POLICY_VIOLATION;
      } else if (/role_capability_check_failed|role capability/i.test(parsed.dispatchBlockReason || "")) {
        derivedRc = BLOCKING_REASON_CLASS.POLICY_VIOLATION;
      }
    }

    const cfResult = classifyFailure({
      workerStatus: parsed.status,
      blockingReasonClass: derivedRc,
      errorMessage: parsed.summary,
      failurePhase: phaseRetryState.failedPhase,
      phaseEvidence: phaseRetryState.evidence,
      taskId: instruction.taskId || null,
    });
    if (cfResult.ok) {
      const finishCode = deriveWorkerFinishCode(parsed);

      // Resolve adaptive retry decision based on failure class (non-critical)
      try {
        if (nonRetryablePolicyBlock) {
          retryDecision = {
            schemaVersion: RETRY_STRATEGY_SCHEMA_VERSION,
            taskId: instruction.taskId != null ? String(instruction.taskId) : null,
            failureClass: cfResult.classification.primaryClass,
            attempts: Number(instruction.reworkAttempt || 0),
            retryAction: RETRY_ACTION.ESCALATE,
            cooldownUntilMs: null,
            cooldownMs: null,
            escalationTarget: "daemon_queue",
            reworkQueue: null,
            verificationStep: null,
            strategyUsed: "adaptive",
            reason: `non-retryable policy block: ${String(parsed.dispatchBlockReason || "unknown")}`,
            decidedAt: new Date().toISOString(),
          };
          persistRetryMetric(config, retryDecision);
        } else {
          const retryRoiSignal = assessRetryExpectedROI({
            attempt: Number(instruction.reworkAttempt || 0) + 1,
            maxRetries: resolveAdaptiveRetryCap(cfResult.classification.primaryClass, config),
            taskKind: instruction.taskKind || "general",
            premiumUsageData: loadPremiumUsageEntries(config),
            benchmarkGroundTruth: loadBenchmarkGroundTruthSignal(config),
            promptCacheHitRate: promptCacheSignal.hitRate,
            promptCacheSavedTokens: promptCacheSignal.avgSavedTokens,
            lowRoiSignalCount: failureFinishSignal.lowRoiSignalCount,
            failureClass: cfResult.classification.primaryClass,
            finishCode,
          });
          const rd = resolveRetryAction(
            cfResult.classification.primaryClass,
            Number(instruction.reworkAttempt || 0),
            config,
            instruction.taskId || null
          );
          if (rd.ok) {
            retryDecision = applyRetrySignalTuning(rd.decision, {
              promptCacheHitRate: promptCacheSignal.hitRate,
              promptCacheSavedTokens: promptCacheSignal.avgSavedTokens,
              retryExpectedGain: retryRoiSignal.expectedGain,
              retryThreshold: retryRoiSignal.threshold,
              lowRoiSignalCount: failureFinishSignal.lowRoiSignalCount,
              latestFailureClass: cfResult.classification.primaryClass,
              latestFinishCode: finishCode,
            });
            retryDecision = applyRetryROIGate(retryDecision, retryRoiSignal);
            persistRetryMetric(config, retryDecision);
            failureClassification = {
              ...cfResult.classification,
              taskKind: instruction.taskKind || "general",
              roleName: String(roleName || "worker"),
              lineageId: _dispatchLineageId,
              lineage: runtimeLineage.lineage,
              lineageJoinKey: runtimeLineage.lineageJoinKey,
              finishStatus: parsed.status,
              finishCode,
              retryRoiExpectedGain: retryRoiSignal.expectedGain,
              retryRoiThreshold: retryRoiSignal.threshold,
              retryRoiAllowed: retryRoiSignal.allowRetry,
              retryAction: retryDecision?.retryAction ?? null,
            };
          }
        }
      } catch { /* non-fatal — retry resolution must never block worker results */ }
      if (!failureClassification) {
        failureClassification = {
          ...cfResult.classification,
          taskKind: instruction.taskKind || "general",
          roleName: String(roleName || "worker"),
          lineageId: _dispatchLineageId,
          lineage: runtimeLineage.lineage,
          lineageJoinKey: runtimeLineage.lineageJoinKey,
          finishStatus: parsed.status,
          finishCode,
          retryAction: retryDecision?.retryAction ?? null,
        };
      }
      appendFailureClassification(config, failureClassification).catch(() => { /* non-fatal */ });
    }

    // Build unified failure envelope for observability and postmortem analysis
    try {
      const statusStr = String(parsed.status);
      const envCause = statusStr === "blocked" ? TERMINATION_CAUSE.BLOCKED : TERMINATION_CAUSE.ERROR;
      const envelope = buildFailureEnvelope(
        failureClassification ? (failureClassification as Record<string, unknown>) : null,
        retryDecision ? (retryDecision as Record<string, unknown>) : null,
        envCause,
        instruction.taskId || null,
        attemptMeta,
        phaseRetryState,
      );
      appendFailureClassification(config, { ...envelope, _type: "failure_envelope" }).catch(() => { /* non-fatal */ });
    } catch { /* non-fatal — envelope build must never block worker results */ }
  }
  if (phaseRetryState) {
    phaseRetryState = buildPhaseAwareRetryState({
      instruction,
      parsed: {
        ...parsed,
        verificationEvidence: parsed.verificationEvidence || null,
      },
      retryAction: retryDecision?.retryAction || null,
      failureClass: failureClassification?.primaryClass || retryDecision?.failureClass || null,
      verificationEvidence: parsed.verificationEvidence || null,
      failedPhaseOverride: phaseRetryState.failedPhase,
    });
  }

  // Produce deterministic per-attempt artifact for the learning loop (non-critical)
  let attemptArtifact = null;
  try {
    attemptArtifact = buildAttemptArtifact(
      runId,
      attempt,
      instruction.taskId != null ? String(instruction.taskId) : null,
      parsed.status,
      failureClassification?.primaryClass ?? retryDecision?.failureClass ?? null,
      retryDecision,
      firstAttemptAt,
      phaseRetryState,
    );
  } catch { /* non-fatal — artifact build must never block worker results */ }

  // Add worker's response to history
  updatedHistory.push({
    from: roleName,
    content: parsed.summary,
    fullOutput: parsed.fullOutput,
    prUrl: parsed.prUrl,
    timestamp: new Date().toISOString(),
    status: parsed.status
  });

  try {
    await realizeRouteROIEntry(
      config,
      routingTaskId,
      deriveOutcomeQualityScore(finalTelemetryOutcome, parsed.verificationEvidence || null, dispatchContract),
      finalTelemetryOutcome,
    );
  } catch {
    // non-critical routing telemetry
  }

  if (parsed.status !== "done" && parsed.status !== "success") {
    await persistPhaseAwareRetryArtifacts(config, {
      roleName,
      instruction,
      status: parsed.status,
      retryAction: retryDecision?.retryAction || null,
      failureClass: failureClassification?.primaryClass || retryDecision?.failureClass || null,
      retryState: phaseRetryState || buildPhaseAwareRetryState({
        instruction,
        parsed: {
          ...parsed,
          verificationEvidence: parsed.verificationEvidence || null,
        },
        retryAction: retryDecision?.retryAction || null,
        failureClass: failureClassification?.primaryClass || retryDecision?.failureClass || null,
        verificationEvidence: parsed.verificationEvidence || null,
      }),
    }).catch(() => {});
  }

  // Verification boundary checkpoint: persist stable snapshot after worker completes.
  {
    const verificationThreadId = String(runtimeLineage.checkpointThreadId || instruction.taskId || instruction.task || Date.now());
    await writeBoundaryCheckpoint(config, {
      roleName,
      status: parsed.status,
      prUrl: parsed.prUrl || null,
      filesTouched: parsed.filesTouched || [],
      reworkAttempt: Number(instruction.reworkAttempt || 0),
      workerCompletedAt: new Date().toISOString(),
      lineage: runtimeLineage.lineage,
      lineageJoinKey: runtimeLineage.lineageJoinKey,
    }, { thread_id: verificationThreadId, checkpoint_ns: CHECKPOINT_NS.VERIFICATION }).catch(() => { /* non-fatal */ });
  }

  return {
    status: parsed.status,
    summary: parsed.summary,
    prUrl: parsed.prUrl,
    currentBranch: parsed.currentBranch,
    filesTouched: parsed.filesTouched,
    updatedHistory,
    workerKind,
    tier,
    verificationReport: parsed.verificationReport,
    responsiveMatrix: parsed.responsiveMatrix,
    verificationEvidence: parsed.verificationEvidence || null,
    dispatchContract,
    lineage: runtimeLineage.lineage,
    lineageJoinKey: runtimeLineage.lineageJoinKey,
    fullOutput: parsed.fullOutput,
    failureClassification,
    retryDecision,
    attemptArtifact,
  };
}

