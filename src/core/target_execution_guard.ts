import path from "node:path";
import { PLATFORM_MODE } from "./mode_state.js";
import { TARGET_SESSION_STAGE } from "./target_session_state.js";
import {
  buildShadowStageDisciplineLines,
  evaluateShadowPlanEntryContract,
} from "./target_stage_contract.js";

function normalizeString(value: unknown): string {
  return String(value || "").trim();
}

function normalizePath(value: unknown): string {
  return normalizeString(value).replace(/\\/g, "/").replace(/\/+$/g, "");
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizePath(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function pathOverlap(left: string, right: string): boolean {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  if (leftResolved === rightResolved) return true;
  const relLeftToRight = path.relative(leftResolved, rightResolved);
  const relRightToLeft = path.relative(rightResolved, leftResolved);
  const leftContainsRight = !!relLeftToRight && !relLeftToRight.startsWith("..") && !path.isAbsolute(relLeftToRight);
  const rightContainsLeft = !!relRightToLeft && !relRightToLeft.startsWith("..") && !path.isAbsolute(relRightToLeft);
  return leftContainsRight || rightContainsLeft;
}

function relativizeToWorkspace(filePath: unknown, workspacePath: string | null): string {
  const normalizedFile = normalizePath(filePath);
  if (!normalizedFile) return "";
  if (!workspacePath) return normalizedFile;
  const workspaceResolved = path.resolve(workspacePath).replace(/\\/g, "/");
  const fileResolved = path.resolve(normalizedFile).replace(/\\/g, "/");
  if (fileResolved === workspaceResolved) return "";
  if (fileResolved.startsWith(`${workspaceResolved}/`)) {
    return fileResolved.slice(workspaceResolved.length + 1);
  }
  return normalizedFile;
}

function matchProtectedPaths(changedFiles: unknown, protectedPaths: string[], workspacePath: string | null): string[] {
  if (!Array.isArray(changedFiles) || protectedPaths.length === 0) return [];
  const hits = new Set<string>();
  for (const filePath of changedFiles) {
    const candidate = relativizeToWorkspace(filePath, workspacePath).toLowerCase();
    if (!candidate) continue;
    for (const protectedPath of protectedPaths) {
      const normalizedProtectedPath = protectedPath.toLowerCase();
      if (candidate === normalizedProtectedPath || candidate.startsWith(`${normalizedProtectedPath}/`)) {
        hits.add(protectedPath);
      }
    }
  }
  return [...hits];
}

function detectForbiddenAction(input: { task?: unknown; context?: unknown; verification?: unknown }, forbiddenActions: string[]): string | null {
  if (forbiddenActions.length === 0) return null;
  const haystack = [input?.task, input?.context, input?.verification]
    .map((value) => normalizeString(value).toLowerCase())
    .filter(Boolean)
    .join("\n");
  if (!haystack) return null;
  for (const forbiddenAction of forbiddenActions) {
    if (haystack.includes(forbiddenAction.toLowerCase())) {
      return forbiddenAction;
    }
  }
  return null;
}

export function resolveTargetExecutionContext(config: any) {
  const rootDir = String(config?.rootDir || process.cwd());
  const currentMode = String(config?.platformModeState?.currentMode || "").trim();
  const futureModeFlags = config?.selfDev?.futureModeFlags && typeof config.selfDev.futureModeFlags === "object"
    ? config.selfDev.futureModeFlags
    : {};
  const singleTargetDeliveryEnabled = futureModeFlags.singleTargetDelivery !== false;
  const targetSessionStateEnabled = futureModeFlags.targetSessionState !== false;
  const targetWorkspaceLifecycleEnabled = futureModeFlags.targetWorkspaceLifecycle !== false;
  const modeRequested = currentMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY;
  const activeTargetSession = config?.activeTargetSession && typeof config.activeTargetSession === "object"
    ? config.activeTargetSession
    : null;
  const workspacePath = normalizeString(activeTargetSession?.workspace?.path) || null;
  const currentStage = normalizeString(activeTargetSession?.currentStage).toLowerCase();
  const executionMode = currentStage === TARGET_SESSION_STAGE.ACTIVE
    ? TARGET_SESSION_STAGE.ACTIVE
    : currentStage === TARGET_SESSION_STAGE.SHADOW
      ? TARGET_SESSION_STAGE.SHADOW
      : null;
  const stageAllowsExecution = executionMode != null;
  const gateAllowsExecution = executionMode === TARGET_SESSION_STAGE.ACTIVE
    ? activeTargetSession?.gates?.allowActiveExecution === true
    : executionMode === TARGET_SESSION_STAGE.SHADOW
      ? activeTargetSession?.gates?.allowShadowExecution === true
      : false;
  const isolatedWorkspace = workspacePath ? !pathOverlap(rootDir, workspacePath) : false;

  return {
    active: modeRequested,
    modeRequested,
    enabled: singleTargetDeliveryEnabled && targetSessionStateEnabled && targetWorkspaceLifecycleEnabled,
    rootDir,
    workspacePath,
    currentStage: currentStage || null,
    executionMode,
    stageAllowsExecution,
    gateAllowsExecution,
    isolatedWorkspace,
    activeTargetSession,
    projectId: normalizeString(activeTargetSession?.projectId) || null,
    sessionId: normalizeString(activeTargetSession?.sessionId) || null,
    targetRepo: normalizeString(activeTargetSession?.repo?.repoUrl) || null,
    targetBaseBranch: normalizeString(activeTargetSession?.repo?.defaultBranch) || "main",
    objectiveSummary: normalizeString(activeTargetSession?.objective?.summary) || null,
    protectedPaths: normalizeStringArray(activeTargetSession?.constraints?.protectedPaths),
    forbiddenActions: normalizeStringArray(activeTargetSession?.constraints?.forbiddenActions),
  };
}

export function resolveWorkerExecutionCwd(config: any): string {
  const context = resolveTargetExecutionContext(config);
  if (
    context.active
    && context.enabled
    && context.workspacePath
    && context.stageAllowsExecution
    && context.gateAllowsExecution
    && context.isolatedWorkspace
  ) {
    return context.workspacePath;
  }
  return context.rootDir;
}

export function evaluateTargetExecutionBoundary(input: any, config: any) {
  const context = resolveTargetExecutionContext(config);
  if (!context.active) {
    return {
      active: false,
      allowed: true,
      blocked: [],
      warnings: [],
      dispatchBlockReason: null,
      protectedPathMatches: [],
      forbiddenActionMatch: null,
      executionContext: context,
    };
  }

  const blockedCodes: string[] = [];
  const blocked: string[] = [];

  if (!context.enabled) {
    blockedCodes.push("feature_not_enabled");
    blocked.push("target workspace lifecycle flag is disabled");
  }
  if (!context.activeTargetSession) {
    blockedCodes.push("missing_active_session");
    blocked.push("single_target_delivery mode requires an active target session");
  }
  if (!context.workspacePath) {
    blockedCodes.push("missing_workspace_path");
    blocked.push("target execution requires an isolated workspace path");
  }
  if (context.workspacePath && !context.isolatedWorkspace) {
    blockedCodes.push("workspace_not_isolated");
    blocked.push("target workspace overlaps BOX workspace");
  }
  if (context.currentStage && !context.stageAllowsExecution) {
    blockedCodes.push("session_stage_not_executable");
    blocked.push(`target session stage ${context.currentStage} does not allow worker execution`);
  }
  if (context.stageAllowsExecution && !context.gateAllowsExecution) {
    blockedCodes.push("execution_gate_closed");
    blocked.push(`target session gate closed for ${context.executionMode} execution`);
  }

  const changedFiles = Array.isArray(input?.changedFiles) ? input.changedFiles : [];
  const taskKind = normalizeString(input?.taskKind).toLowerCase();

  if (context.executionMode === TARGET_SESSION_STAGE.SHADOW) {
    const shadowViolations = evaluateShadowPlanEntryContract({
      taskKind,
      changedFiles,
      task: input?.task,
      context: input?.context,
      verification: input?.verification,
    });
    for (const violation of shadowViolations) {
      if (!blockedCodes.includes(violation.code)) {
        blockedCodes.push(violation.code);
      }
      blocked.push(violation.message);
    }
  }

  const protectedPathMatches = matchProtectedPaths(changedFiles, context.protectedPaths, context.workspacePath);
  if (protectedPathMatches.length > 0) {
    blockedCodes.push("protected_path_scope");
    blocked.push(`target protected path change requested: ${protectedPathMatches.join(", ")}`);
  }

  const forbiddenActionMatch = detectForbiddenAction(input, context.forbiddenActions);
  if (forbiddenActionMatch) {
    blockedCodes.push("forbidden_action_requested");
    blocked.push(`target forbidden action requested: ${forbiddenActionMatch}`);
  }

  return {
    active: true,
    allowed: blocked.length === 0,
    blocked,
    warnings: [],
    dispatchBlockReason: blockedCodes.length > 0 ? `target_execution_guard:${blockedCodes[0]}` : null,
    protectedPathMatches,
    forbiddenActionMatch,
    executionContext: context,
  };
}

export function buildTargetExecutionWorkerContext(config: any): string {
  const boundary = evaluateTargetExecutionBoundary({}, config);
  if (!boundary.active) return "";

  const context = boundary.executionContext;
  const parts = [
    "## TARGET EXECUTION CONTEXT",
    `Execution mode: ${context.executionMode || "blocked"}`,
    `Target workspace: ${context.workspacePath || "missing"}`,
    `Target repo: ${context.targetRepo || "unknown"}`,
    `Target base branch: ${context.targetBaseBranch || "main"}`,
    `Objective: ${context.objectiveSummary || "not provided"}`,
    "Run repo commands, tests, and git operations inside the target workspace only.",
    "Do not read, edit, stage, commit, or verify target changes from the BOX repo.",
    "Never cross the workspace boundary between BOX and the target repo in the same task.",
    `Protected target paths: ${context.protectedPaths.join(", ") || "none"}`,
    `Forbidden target actions: ${context.forbiddenActions.join(", ") || "none"}`,
    "Verification evidence and clean-tree proof must come from the target workspace when target execution is active.",
  ];

  if (context.executionMode === TARGET_SESSION_STAGE.SHADOW) {
    parts.push("Shadow mode is verification-first: prefer planning, tests, CI fixes, docs, and observation work.");
    parts.push("Shadow mode blocks high-risk delivery intent, broad implementation packets, and large file spreads.");
    parts.push("Shadow mode also requires exact scope discipline: do not create extra files outside the planner-declared target file set.");
    parts.push("SHADOW MODE DELIVERY DISCIPLINE");
    parts.push(...buildShadowStageDisciplineLines());
  }

  if (!boundary.allowed && boundary.blocked.length > 0) {
    parts.push(`Blocked until resolved: ${boundary.blocked.join("; ")}`);
  }

  return parts.join("\n");
}