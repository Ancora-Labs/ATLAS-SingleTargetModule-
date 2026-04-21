/**
 * BOX Orchestrator — Shared Type Definitions
 * Central type layer for the entire system.
 */

// ─── Config ────────────────────────────────────────────────────────
export interface Config {
  env: {
    githubToken: string | null;
    copilotGithubToken: string | null;
    targetRepo: string | null;
    targetBaseBranch: string;
    copilotCliCommand: string;
    budgetUsd: number;
    mode: string;
    [key: string]: unknown;
  };
  paths: {
    stateDir: string;
    policyFile: string;
    progressFile: string;
    copilotUsageFile: string;
    copilotUsageMonthlyFile: string;
    testsStateFile: string;
    [key: string]: string;
  };
  copilot: {
    strategy: string;
    allowOpusEscalation: boolean;
    allowedModels: string[];
    maxMultiplier: number;
    opusMinBudgetUsd: number;
    opusMonthlyMaxCalls: number;
  };
  git: {
    autoCreatePr: boolean;
    autoMergeOnGreen: boolean;
    autoMergeWaitSeconds: number;
    autoMergePollSeconds: number;
    autoMergeMethod: string;
    requiredCheckRuns: string[];
    requiredStatusContexts: string[];
  };
  runtime: {
    copilotAutoCompact: boolean;
    copilotRehydrateOnFail: boolean;
    copilotMaxRetries: number;
    stopOnError: boolean;
    reviewerProvider: string;
    autonomousMaxAttemptsPerTask: number;
    autonomousTaskSplitOnFailure: boolean;
    maxQueuedTasks: number;
    [key: string]: unknown;
  };
  roleRegistry?: {
    ceoSupervisor?: WorkerRoleConfig;
    planner?: WorkerRoleConfig;
    reviewer?: WorkerRoleConfig;
    workers?: Record<string, WorkerRoleConfig>;
  };
  canary?: {
    enabled?: boolean;
    defaultRatio?: number;
    governance?: {
      canaryRatio?: number;
      cohortSelectionAlgorithm?: string;
      [key: string]: unknown;
    };
  };
  gates?: {
    requireBuild?: boolean;
    requireTests?: boolean;
    requireSecurityScan?: boolean;
  };
  rollbackEngine?: {
    enabled?: boolean;
    oneCycleSlaMs?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface WorkerRoleConfig {
  id?: string;
  name: string;
  model?: string;
  kind?: string;
  [key: string]: unknown;
}

// ─── Worker Run Contract ───────────────────────────────────────────

/**
 * Deterministic run contract attached to every worker dispatch.
 * Provides bounded execution metadata for tracing, session lifecycle control,
 * and token-pressure management in long-running worker loops.
 */
export interface WorkerRunContract {
  /** Maximum number of model turns (continues) for this session. */
  maxTurns: number;
  /** Human-readable workflow name for tracing and analytics. */
  workflowName: string;
  /** Group identifier for correlated dispatches within a cycle. */
  groupId: string;
  /** Arbitrary trace metadata for observability integrations. */
  traceMetadata: Record<string, unknown>;
  /** When false (default), suppress PII/secrets from trace output. */
  traceIncludeSensitiveData: boolean;
  /**
   * Controls which tool categories are admitted in the session.
   *   allow_all  — full tool access (default for implementation workers)
   *   no_tools   — disable all tools (analysis-only workers)
   *   auto       — derive from worker kind
   */
  sessionInputPolicy: "allow_all" | "no_tools" | "auto";
}

// ─── Generic result pattern ────────────────────────────────────────
export interface Result<T = unknown> {
  ok: boolean;
  code?: string;
  reason?: string;
  message?: string;
  data?: T;
  error?: unknown;
}

// ─── Worker ────────────────────────────────────────────────────────
export type WorkerStatus = "done" | "partial" | "blocked" | "error" | "skipped";

export interface WorkerInstruction {
  task: string;
  context?: string;
  verification?: string;
  taskKind?: string;
  estimatedLines?: number;
  estimatedDurationMinutes?: number;
  complexity?: string;
}

export interface ConversationMessage {
  from: string;
  content: string;
  timestamp?: string;
  status?: string;
}

export interface WorkerSessionState {
  currentBranch?: string | null;
  createdPRs?: string[];
  filesTouched?: string[];
  activityLog?: Array<{
    at?: string;
    status?: string;
    task?: string;
    files?: string[];
    pr?: string;
  }>;
}

export interface ParsedWorkerResponse {
  status: WorkerStatus;
  prUrl: string | null;
  currentBranch: string | null;
  filesTouched: string[];
  summary: string;
  fullOutput: string;
  verificationReport?: Record<string, unknown>;
  responsiveMatrix?: Record<string, string>;
}

export interface WorkerResult {
  roleName: string;
  status: string;
  pr: string | null;
  summary: string;
  [key: string]: unknown;
}

export interface WorkerSession {
  status: "idle" | "working";
  startedAt?: string;
  history?: ConversationMessage[];
}

// ─── Orchestrator ──────────────────────────────────────────────────
export type OrchestratorStatus = "operational" | "degraded";

export interface AuditCriticalStateFilesResult {
  sessions: Record<string, WorkerSession>;
  janusDirective: JanusDirective | null;
  prometheusAnalysis: PrometheusAnalysis | null;
  degraded: boolean;
}

export interface JanusDirective {
  [key: string]: unknown;
}

export interface PrometheusAnalysis {
  [key: string]: unknown;
}

// ─── Verification ──────────────────────────────────────────────────
export type VerificationStatus = "pass" | "fail" | "n/a";
export type EvidenceRequirement = "required" | "optional" | "exempt";

export interface VerificationReport {
  build?: VerificationStatus;
  tests?: VerificationStatus;
  responsive?: VerificationStatus;
  api?: VerificationStatus;
  edgeCases?: VerificationStatus;
  security?: VerificationStatus;
}

export interface VerificationProfile {
  kind: string;
  label: string;
  lane: string;
  evidence: {
    build: EvidenceRequirement;
    tests: EvidenceRequirement;
    responsive: EvidenceRequirement;
    api: EvidenceRequirement;
    edgeCases: EvidenceRequirement;
    security: EvidenceRequirement;
    prUrl?: EvidenceRequirement;
  };
  responsiveRequired?: boolean;
  minViewports?: number;
  description: string;
}

export interface ValidationResult {
  passed: boolean;
  gaps: string[];
  evidence: {
    hasReport: boolean;
    report: Record<string, unknown>;
    responsiveMatrix: Record<string, string>;
    prUrl: string | null;
    profile: string;
    postMergeArtifact?: Record<string, unknown>;
  };
  reason?: string;
}

export interface ReworkInstruction {
  task: string;
  context: string;
  isFollowUp: boolean;
  isRework: boolean;
  reworkAttempt: number;
  maxReworkAttempts: number;
  taskKind: "rework";
}

// ─── Policy ────────────────────────────────────────────────────────
export interface Policy {
  protectedPaths?: string[];
  requireReviewerApprovalForProtectedPaths?: boolean;
  blockedCommands?: string[];
  rolePolicies?: Record<string, RolePolicy>;
  [key: string]: unknown;
}

export interface RolePolicy {
  allowedPaths?: string[];
  deniedPaths?: string[];
  blockedTaskPatterns?: string[];
  requiredTaskPatterns?: string[];
}

export interface RolePathViolation {
  role: string;
  deniedMatches: string[];
  outsideAllowed: string[];
  hasViolation: boolean;
}

// ─── Governance / Canary ───────────────────────────────────────────
export type CohortType = "canary" | "control";
export type GovernanceCanaryStatus = "running" | "promoted" | "rolled_back" | "failed";

export interface GovernanceCanaryConfig {
  enabled: boolean;
  canaryRatio: number;
  cohortSelectionAlgorithm: string;
  measurementWindowCycles: number;
  falseBlockRateMax: number;
  safetyScoreMin: number;
  falseBlockRateTrigger: number;
  safetyScoreTriggerLow: number;
  breachAction: string;
}

export interface CanaryLedgerEntry {
  canaryId: string;
  experimentId: string | null;
  policyRulePatch: Record<string, unknown>;
  canaryRatio: number;
  status: GovernanceCanaryStatus;
  statusReason: string | null;
  cohortStats: {
    canary: { cycleCount: number; falseBlockRate: number; safetyScore: number };
    control: { cycleCount: number; falseBlockRate: number; safetyScore: number };
  };
  cycleLog: Array<{
    cycleId: string;
    cohort: CohortType;
    timestamp: string;
    metrics: { falseBlockRate: number; safetyScore: number };
  }>;
  createdAt: string;
  promotedAt: string | null;
  rolledBackAt: string | null;
}

// ─── Events ────────────────────────────────────────────────────────
export type EventDomain =
  | "orchestration"
  | "planning"
  | "verification"
  | "policy"
  | "billing"
  | "governance";

export interface BoxEvent {
  event: string;
  version: number;
  correlationId: string;
  timestamp: string;
  domain: EventDomain;
  payload: Record<string, unknown>;
}

// ─── State Tracker ─────────────────────────────────────────────────
export type AlertSeverity = "low" | "medium" | "high" | "critical";

export interface Alert {
  severity?: AlertSeverity;
  source?: string;
  title?: string;
  message?: string;
  correlationId?: string;
}

export interface TestEntry {
  id: number | string;
  kind?: string;
  name?: string;
  title: string;
  status: string;
  notes?: string;
  updatedAt?: string;
}

export interface TestsState {
  tests: TestEntry[];
  totals: {
    passed: number;
    failed: number;
    running: number;
    queued: number;
  };
  updatedAt: string;
}

export interface LineageEntry {
  taskId: string;
  taskFingerprint: string;
  roleName: string;
  task: string;
  status: WorkerStatus;
  prUrl?: string | null;
  filesTouched?: string[];
  evidence?: Record<string, unknown>;
  timestamp: string;
}

// ─── Rollback ──────────────────────────────────────────────────────
export type RollbackLevel =
  | "config-only"
  | "state-schema"
  | "policy-set"
  | "orchestration-code-freeze"
  | "full-baseline-restore";

export type RollbackStatus =
  | "triggered"
  | "executing"
  | "completed"
  | "failed"
  | "sla_breach";

export interface RollbackIncident {
  schemaVersion: number;
  incidentId: string;
  level: string;
  trigger: string;
  triggeredAt: string;
  completedAt: string | null;
  status: RollbackStatus;
  stepsExecuted: string[];
  evidence: Record<string, unknown>;
  baselineRef?: string;
  healthCheckResult?: Record<string, unknown>;
  durationMs?: number;
}

// ─── Escalation ────────────────────────────────────────────────────
export type BlockingReasonClass =
  | "MAX_REWORK_EXHAUSTED"
  | "POLICY_VIOLATION"
  | "ACCESS_BLOCKED"
  | "WORKER_ERROR"
  | "VERIFICATION_GATE";

export type NextAction =
  | "RETRY"
  | "ESCALATE_TO_HUMAN"
  | "SKIP"
  | "REASSIGN";

export interface EscalationPayload {
  schemaVersion: 1;
  role: string;
  taskFingerprint: string;
  taskSnippet: string;
  blockingReasonClass: string;
  attempts: number;
  nextAction: string;
  summary: string;
  prUrl: string | null;
  resolved: boolean;
  createdAt: string;
}

// ─── Provider Reviewer Decision ─────────────────────────

/**
 * Indicates whether a reviewer provider decision was produced by the AI model
 * ("provider") or by the deterministic fallback path ("fallback").
 *
 * Carried as `_source` on every tagged decision. Callers should check this
 * field to distinguish AI-produced decisions from deterministic fallbacks.
 */
export type ReviewerDecisionSource = "provider" | "fallback";

// ─── Copilot Usage ─────────────────────────────────────────────────
export interface CopilotUsage {
  correlationId?: string;
  copilot?: {
    model: string;
    invocation: string;
    usedOpus?: boolean;
  };
}

