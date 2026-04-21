import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, spawnAsync, writeJson } from "./fs_utils.js";
import {
  getActiveTargetSessionPath,
  PLATFORM_MODE,
  updatePlatformModeState,
} from "./mode_state.js";

export const TARGET_SESSION_SCHEMA_VERSION = 1;
export const TARGET_INTENT_STATUS = Object.freeze({
  PENDING: "pending",
  CLARIFYING: "clarifying",
  READY_FOR_PLANNING: "ready_for_planning",
});

export const TARGET_FEEDBACK_CATEGORY = Object.freeze({
  PLANNING: "planning",
  RESEARCH: "research",
  INTENT: "intent",
});

export const TARGET_SESSION_STAGE = Object.freeze({
  ONBOARDING: "onboarding",
  AWAITING_CREDENTIALS: "awaiting_credentials",
  AWAITING_MANUAL_STEP: "awaiting_manual_step",
  AWAITING_INTENT_CLARIFICATION: "awaiting_intent_clarification",
  SHADOW: "shadow",
  ACTIVE: "active",
  COMPLETED: "completed",
  COMPLETED_WITH_HANDOFF: "completed_with_handoff",
  QUARANTINED: "quarantined",
});

const VALID_TARGET_SESSION_STAGES = new Set(Object.values(TARGET_SESSION_STAGE));

type TargetSessionStage = typeof TARGET_SESSION_STAGE[keyof typeof TARGET_SESSION_STAGE];
type TargetFeedbackCategory = typeof TARGET_FEEDBACK_CATEGORY[keyof typeof TARGET_FEEDBACK_CATEGORY];

const CLOSED_TARGET_SESSION_STAGES = new Set<string>([
  TARGET_SESSION_STAGE.COMPLETED,
  TARGET_SESSION_STAGE.COMPLETED_WITH_HANDOFF,
]);

const STAGE_DEFAULT_NEXT_ACTION = Object.freeze({
  [TARGET_SESSION_STAGE.ONBOARDING]: "run_onboarding",
  [TARGET_SESSION_STAGE.AWAITING_CREDENTIALS]: "await_required_credentials",
  [TARGET_SESSION_STAGE.AWAITING_MANUAL_STEP]: "await_manual_step",
  [TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION]: "run_onboarding_clarification",
  [TARGET_SESSION_STAGE.SHADOW]: "run_shadow_planning",
  [TARGET_SESSION_STAGE.ACTIVE]: "run_active_planning",
  [TARGET_SESSION_STAGE.COMPLETED]: "archive_completed_session",
  [TARGET_SESSION_STAGE.COMPLETED_WITH_HANDOFF]: "archive_completed_session",
  [TARGET_SESSION_STAGE.QUARANTINED]: "await_human_review",
});

const TARGET_SESSION_EPHEMERAL_STATE_FILES = Object.freeze([
  "approved_plan_set.json",
  "athena_plan_rejection.json",
  "athena_plan_review.json",
  "dispatch_checkpoint.json",
  "last_target_delivery_handoff.json",
  "pipeline_progress.json",
  "prometheus_analysis.json",
  "worker_cycle_artifacts.json",
  "worker_sessions.json",
]);

const TARGET_SESSION_EPHEMERAL_STATE_PATTERNS = Object.freeze([
  /^debug_worker_.+\.txt$/i,
  /^debug_agent_.+\.txt$/i,
]);

function buildTargetSessionIdentity(session: any): string {
  const projectId = String(session?.projectId || "").trim();
  const sessionId = String(session?.sessionId || "").trim();
  if (!projectId || !sessionId) return "";
  return `${projectId}:${sessionId}`;
}

function shouldResetTargetSessionEphemeralState(previousSession: any, nextSession: any): boolean {
  if (String(nextSession?.currentMode || "") !== PLATFORM_MODE.SINGLE_TARGET_DELIVERY) {
    return false;
  }

  const nextIdentity = buildTargetSessionIdentity(nextSession);
  if (!nextIdentity) return false;

  const previousIdentity = buildTargetSessionIdentity(previousSession);
  return !previousIdentity || previousIdentity !== nextIdentity;
}

async function clearTargetSessionEphemeralState(config: any): Promise<void> {
  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");
  await fs.mkdir(stateDir, { recursive: true });

  await Promise.all(
    TARGET_SESSION_EPHEMERAL_STATE_FILES.map((fileName) =>
      fs.rm(path.join(stateDir, fileName), { force: true }).catch(() => {})
    )
  );

  const entries = await fs.readdir(stateDir, { withFileTypes: true }).catch(() => [] as Array<{ isFile(): boolean; name: string }>);
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && TARGET_SESSION_EPHEMERAL_STATE_PATTERNS.some((pattern) => pattern.test(entry.name)))
      .map((entry) => fs.rm(path.join(stateDir, entry.name), { force: true }).catch(() => {}))
  );
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized ? normalized : null;
}

function normalizeRepoIdentityValue(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function buildSessionRepoIdentity(sessionOrManifest: any): string {
  return normalizeRepoIdentityValue(
    sessionOrManifest?.repo?.repoFullName
    || sessionOrManifest?.target?.repoFullName
    || sessionOrManifest?.repo?.repoUrl
    || sessionOrManifest?.target?.repoUrl
    || sessionOrManifest?.repoUrl,
  );
}

function sanitizePathSegment(value: unknown, fallback: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((entry) => String(entry || "").trim()).filter(Boolean);
}

async function pathExists(targetPath: string | null | undefined): Promise<boolean> {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeWorkspaceBootstrap(rawBootstrap: any, session: any) {
  return {
    strategy: normalizeNullableString(rawBootstrap?.strategy) || "pending",
    status: normalizeNullableString(rawBootstrap?.status) || "pending",
    remoteOrigin: normalizeNullableString(rawBootstrap?.remoteOrigin) || normalizeNullableString(session?.repo?.repoUrl),
    branch: normalizeNullableString(rawBootstrap?.branch) || normalizeNullableString(session?.repo?.defaultBranch) || "main",
    lastAttemptAt: normalizeNullableString(rawBootstrap?.lastAttemptAt),
    lastError: normalizeNullableString(rawBootstrap?.lastError),
  };
}

function buildGitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
}

async function runGitCommand(args: string[], cwd?: string) {
  const result = await spawnAsync("git", args, {
    cwd,
    env: buildGitEnv(),
    timeoutMs: 120000,
    autoConfirm: false,
  }) as { status?: number | null; stdout?: string; stderr?: string };
  return {
    status: Number(result.status ?? 1),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function resolveProviderAccessToken(provider: string | null, config: any): string | null {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider === "github") {
    return normalizeNullableString(
      config?.env?.githubToken
      || config?.env?.copilotGithubToken
      || process.env.GITHUB_TOKEN
      || process.env.COPILOT_GITHUB_TOKEN
    );
  }
  return null;
}

function buildAuthenticatedRepoUrl(repoUrl: string | null, provider: string | null, token: string | null): string | null {
  const normalizedRepoUrl = normalizeNullableString(repoUrl);
  if (!normalizedRepoUrl || !token) return normalizedRepoUrl;
  if (String(provider || "").trim().toLowerCase() !== "github") return normalizedRepoUrl;
  try {
    const url = new URL(normalizedRepoUrl);
    if (url.protocol !== "https:") return normalizedRepoUrl;
    url.username = "x-access-token";
    url.password = token;
    return url.toString();
  } catch {
    return normalizedRepoUrl;
  }
}

function sanitizeGitOutput(output: string, token: string | null, authenticatedRepoUrl: string | null, repoUrl: string | null) {
  let sanitized = String(output || "");
  if (token) {
    sanitized = sanitized.split(token).join("***");
  }
  if (authenticatedRepoUrl && repoUrl && authenticatedRepoUrl !== repoUrl) {
    sanitized = sanitized.split(authenticatedRepoUrl).join(repoUrl);
  }
  return sanitized.trim();
}

function isAuthFailure(stderr: string) {
  const message = String(stderr || "").toLowerCase();
  return [
    "authentication failed",
    "could not read username",
    "permission denied",
    "repository not found",
    "access denied",
    "authentication required",
    "http basic: access denied",
  ].some((entry) => message.includes(entry));
}

async function ensureEmptyWorkspaceDir(workspacePath: string) {
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(workspacePath, { recursive: true });
}

function getWorkspaceDir(config: any): string {
  const workspaceDir = normalizeNullableString(config?.paths?.workspaceDir);
  return workspaceDir || path.join(process.cwd(), ".atlas-work");
}

function getRootDir(config: any): string {
  const rootDir = normalizeNullableString(config?.rootDir);
  if (rootDir) return rootDir;
  return path.dirname(getWorkspaceDir(config));
}

function normalizeStage(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase() as TargetSessionStage;
  return VALID_TARGET_SESSION_STAGES.has(normalized) ? normalized : TARGET_SESSION_STAGE.ONBOARDING;
}

function extractRepoIdentity(manifest: any) {
  const repoUrl = normalizeNullableString(manifest?.target?.repoUrl || manifest?.repoUrl || manifest?.repo?.repoUrl || manifest?.repo?.url);
  const localPath = normalizeNullableString(manifest?.target?.localPathHint || manifest?.localPath || manifest?.repo?.localPath);
  const explicitName = normalizeNullableString(manifest?.repo?.name || manifest?.repoName);
  const source = repoUrl || localPath || explicitName || "target-project";
  const leaf = String(source).split(/[\\/]/).filter(Boolean).pop() || source;
  return {
    repoUrl,
    localPath,
    explicitName,
    displayName: leaf.replace(/\.git$/i, ""),
  };
}

function detectRepoProvider(repoUrl: string | null, explicitProvider: unknown): string {
  const normalizedExplicitProvider = normalizeNullableString(explicitProvider);
  if (normalizedExplicitProvider) return normalizedExplicitProvider;
  const source = String(repoUrl || "").toLowerCase();
  if (source.includes("github.com")) return "github";
  if (source.includes("gitlab")) return "gitlab";
  if (source.includes("bitbucket")) return "bitbucket";
  return "unknown";
}

function buildDefaultStageGates(stage: string) {
  switch (stage) {
    case TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION:
      return {
        allowPlanning: false,
        allowShadowExecution: false,
        allowActiveExecution: false,
        quarantine: false,
        quarantineReason: null,
      };
    case TARGET_SESSION_STAGE.SHADOW:
      return {
        allowPlanning: true,
        allowShadowExecution: true,
        allowActiveExecution: false,
        quarantine: false,
        quarantineReason: null,
      };
    case TARGET_SESSION_STAGE.ACTIVE:
      return {
        allowPlanning: true,
        allowShadowExecution: false,
        allowActiveExecution: true,
        quarantine: false,
        quarantineReason: null,
      };
    case TARGET_SESSION_STAGE.QUARANTINED:
      return {
        allowPlanning: false,
        allowShadowExecution: false,
        allowActiveExecution: false,
        quarantine: true,
        quarantineReason: null,
      };
    default:
      return {
        allowPlanning: false,
        allowShadowExecution: false,
        allowActiveExecution: false,
        quarantine: false,
        quarantineReason: null,
      };
  }
}

function resolveStageNextAction(stage: string): string {
  return STAGE_DEFAULT_NEXT_ACTION[stage as keyof typeof STAGE_DEFAULT_NEXT_ACTION] || "preserve_session_truth";
}

function normalizeBooleanOrFallback(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function buildTargetProjectId(manifest: any): string {
  const explicitProjectId = normalizeNullableString(manifest?.projectId);
  if (explicitProjectId) {
    return sanitizePathSegment(explicitProjectId, "target_project");
  }

  const repo = extractRepoIdentity(manifest);
  return sanitizePathSegment(`target_${repo.displayName}`, "target_project");
}

export function buildTargetSessionId(now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 6).toLowerCase();
  return `sess_${timestamp}_${suffix}`;
}

export function getProjectsRootPath(stateDir: string): string {
  return path.join(stateDir, "projects");
}

export function getArchiveRootPath(stateDir: string): string {
  return path.join(stateDir, "archive");
}

export function getTargetProjectPath(stateDir: string, projectId: string): string {
  return path.join(getProjectsRootPath(stateDir), projectId);
}

export function getTargetSessionPath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetProjectPath(stateDir, projectId), sessionId);
}

export function getTargetSessionStateFilePath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetSessionPath(stateDir, projectId, sessionId), "target_session.json");
}

export function getLastArchivedTargetSessionPath(stateDir: string): string {
  return path.join(stateDir, "last_archived_target_session.json");
}

export function getTargetIntakeManifestPath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetSessionPath(stateDir, projectId, sessionId), "intake_manifest.json");
}

export function getTargetOnboardingReportPath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetSessionPath(stateDir, projectId, sessionId), "onboarding_report.json");
}

export function getTargetPrerequisiteStatusPath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetSessionPath(stateDir, projectId, sessionId), "prerequisite_status.json");
}

export function getTargetBaselinePath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetSessionPath(stateDir, projectId, sessionId), "target_baseline.json");
}

export function getTargetRepoAnalysisPath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetSessionPath(stateDir, projectId, sessionId), "repo_analysis.json");
}

export function getTargetClarificationPacketPath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetSessionPath(stateDir, projectId, sessionId), "clarification_packet.json");
}

export function getTargetClarificationTranscriptPath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetSessionPath(stateDir, projectId, sessionId), "clarification_transcript.json");
}

export function getTargetIntentContractPath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetSessionPath(stateDir, projectId, sessionId), "target_intent_contract.json");
}

function normalizeTargetIntent(rawIntent: any, stateDir: string, projectId: string, sessionId: string) {
  return {
    status: normalizeNullableString(rawIntent?.status) || TARGET_INTENT_STATUS.PENDING,
    summary: normalizeNullableString(rawIntent?.summary),
    repoState: normalizeNullableString(rawIntent?.repoState) || "unknown",
    planningMode: normalizeNullableString(rawIntent?.planningMode),
    productType: normalizeNullableString(rawIntent?.productType),
    targetUsers: normalizeStringArray(rawIntent?.targetUsers),
    mustHaveFlows: normalizeStringArray(rawIntent?.mustHaveFlows),
    scopeIn: normalizeStringArray(rawIntent?.scopeIn),
    scopeOut: normalizeStringArray(rawIntent?.scopeOut),
    protectedAreas: normalizeStringArray(rawIntent?.protectedAreas),
    preferredQualityBar: normalizeNullableString(rawIntent?.preferredQualityBar),
    designDirection: normalizeNullableString(rawIntent?.designDirection),
    deploymentExpectations: normalizeStringArray(rawIntent?.deploymentExpectations),
    successCriteria: normalizeStringArray(rawIntent?.successCriteria),
    assumptions: normalizeStringArray(rawIntent?.assumptions),
    openQuestions: normalizeStringArray(rawIntent?.openQuestions),
    sourceIntentContractPath: normalizeNullableString(rawIntent?.sourceIntentContractPath) || getTargetIntentContractPath(stateDir, projectId, sessionId),
    updatedAt: normalizeNullableString(rawIntent?.updatedAt),
  };
}

function normalizeTargetFeedback(rawFeedback: any) {
  const review = rawFeedback?.lastAthenaReview && typeof rawFeedback.lastAthenaReview === "object"
    ? rawFeedback.lastAthenaReview
    : {};
  const category = normalizeNullableString(review?.category) as TargetFeedbackCategory | null;
  return {
    pendingResearchRefresh: rawFeedback?.pendingResearchRefresh === true,
    pendingIntentClarification: rawFeedback?.pendingIntentClarification === true,
    lastAthenaReview: {
      status: normalizeNullableString(review?.status) || "none",
      category: category && Object.values(TARGET_FEEDBACK_CATEGORY).includes(category)
        ? category
        : null,
      code: normalizeNullableString(review?.code),
      message: normalizeNullableString(review?.message),
      corrections: normalizeStringArray(review?.corrections),
      updatedAt: normalizeNullableString(review?.updatedAt),
    },
  };
}

export function getTargetCompletionPath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetSessionPath(stateDir, projectId, sessionId), "target_completion.json");
}

export function getTargetSessionProgressLogPath(stateDir: string, projectId: string, sessionId: string): string {
  return path.join(getTargetSessionPath(stateDir, projectId, sessionId), "session_progress.log");
}

export function getLegacyTargetWorkspaceRootPath(workspaceDir: string): string {
  return path.join(workspaceDir, "targets");
}

export function getLegacyTargetWorkspacePath(workspaceDir: string, projectId: string, sessionId: string): string {
  return path.join(getLegacyTargetWorkspaceRootPath(workspaceDir), projectId, sessionId);
}

export function getTargetWorkspaceRootPath(workspaceDir: string, rootDir?: string | null): string {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedRootDir = rootDir
    ? path.resolve(rootDir)
    : path.dirname(resolvedWorkspaceDir);
  const externalHostDir = path.dirname(resolvedRootDir);
  const repoKey = sanitizePathSegment(path.basename(resolvedRootDir), "atlas");
  return path.join(externalHostDir, ".atlas-target-workspaces", repoKey, "targets");
}

export function getTargetWorkspacePath(workspaceDir: string, projectId: string, sessionId: string, rootDir?: string | null): string {
  return path.join(getTargetWorkspaceRootPath(workspaceDir, rootDir), projectId, sessionId);
}

async function moveWorkspaceDirectory(sourcePath: string, targetPath: string) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.rename(sourcePath, targetPath);
    return;
  } catch {
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
    await fs.rm(sourcePath, { recursive: true, force: true }).catch(() => {});
  }
}

async function ensureTargetWorkspaceLocation(session: any, config: any) {
  if (!session || typeof session !== "object") return session;

  const workspaceDir = getWorkspaceDir(config);
  const rootDir = getRootDir(config);
  const expectedWorkspacePath = getTargetWorkspacePath(workspaceDir, session.projectId, session.sessionId, rootDir);
  const legacyWorkspacePath = getLegacyTargetWorkspacePath(workspaceDir, session.projectId, session.sessionId);

  if (expectedWorkspacePath !== legacyWorkspacePath) {
    const expectedExists = await pathExists(expectedWorkspacePath);
    const legacyExists = await pathExists(legacyWorkspacePath);
    if (!expectedExists && legacyExists) {
      await moveWorkspaceDirectory(legacyWorkspacePath, expectedWorkspacePath);
    }
  }

  const normalizedRepoLocalPath = normalizeNullableString(session?.repo?.localPath);
  const rebaseRepoLocalPath = normalizedRepoLocalPath === legacyWorkspacePath
    || normalizedRepoLocalPath === normalizeNullableString(session?.workspace?.path);

  return {
    ...session,
    repo: {
      ...session.repo,
      localPath: rebaseRepoLocalPath ? expectedWorkspacePath : normalizedRepoLocalPath,
    },
    workspace: {
      ...session.workspace,
      rootDir: getTargetWorkspaceRootPath(workspaceDir, rootDir),
      path: expectedWorkspacePath,
    },
  };
}

export async function prepareTargetWorkspaceForSession(session: any, config: any) {
  const sourcePath = normalizeNullableString(session?.repo?.localPath);
  const repoUrl = normalizeNullableString(session?.repo?.repoUrl);
  const provider = normalizeNullableString(session?.repo?.provider);
  const defaultBranch = normalizeNullableString(session?.repo?.defaultBranch) || "main";
  const workspacePath = normalizeNullableString(session?.workspace?.path);
  if (!workspacePath) {
    return session;
  }

  await fs.mkdir(workspacePath, { recursive: true });

  if (sourcePath && !(await pathExists(sourcePath))) {
    return session;
  }

  if (sourcePath && await pathExists(sourcePath)) {
    const sourceResolved = path.resolve(sourcePath);
    const workspaceResolved = path.resolve(workspacePath);
    if (sourceResolved !== workspaceResolved) {
      const existingEntries = await fs.readdir(workspacePath).catch(() => []);
      if (existingEntries.length === 0) {
        await fs.cp(sourcePath, workspacePath, {
          recursive: true,
          force: true,
          errorOnExist: false,
        });
      }
    }

    return {
      ...session,
      repo: {
        ...session.repo,
        localPath: workspacePath,
      },
      workspace: {
        ...session.workspace,
        path: workspacePath,
        prepared: true,
        preparedAt: normalizeNullableString(session?.workspace?.preparedAt) || new Date().toISOString(),
        bootstrap: {
          ...normalizeWorkspaceBootstrap(session?.workspace?.bootstrap, session),
          strategy: "local_copy",
          status: "ready",
          branch: defaultBranch,
          lastAttemptAt: new Date().toISOString(),
          lastError: null,
        },
      },
    };
  }

  const gitDir = path.join(workspacePath, ".git");
  if (await pathExists(gitDir)) {
    return {
      ...session,
      repo: {
        ...session.repo,
        localPath: workspacePath,
      },
      workspace: {
        ...session.workspace,
        path: workspacePath,
        prepared: true,
        preparedAt: normalizeNullableString(session?.workspace?.preparedAt) || new Date().toISOString(),
        bootstrap: {
          ...normalizeWorkspaceBootstrap(session?.workspace?.bootstrap, session),
          strategy: "existing_checkout",
          status: "ready",
          branch: defaultBranch,
          lastAttemptAt: new Date().toISOString(),
          lastError: null,
        },
      },
    };
  }

  if (!repoUrl) {
    return session;
  }

  const token = resolveProviderAccessToken(provider, config);
  if (provider === "github" && !token) {
    return {
      ...session,
      workspace: {
        ...session.workspace,
        bootstrap: {
          ...normalizeWorkspaceBootstrap(session?.workspace?.bootstrap, session),
          strategy: "git_clone",
          status: "awaiting_credentials",
          branch: defaultBranch,
          lastAttemptAt: new Date().toISOString(),
          lastError: "Missing repository access credential required for remote bootstrap.",
        },
      },
    };
  }

  const authenticatedRepoUrl = buildAuthenticatedRepoUrl(repoUrl, provider, token);
  const probeResult = await runGitCommand(["ls-remote", "--heads", authenticatedRepoUrl || repoUrl]);
  if (probeResult.status !== 0) {
    const sanitizedError = sanitizeGitOutput(`${probeResult.stderr}\n${probeResult.stdout}`, token, authenticatedRepoUrl, repoUrl);
    return {
      ...session,
      workspace: {
        ...session.workspace,
        bootstrap: {
          ...normalizeWorkspaceBootstrap(session?.workspace?.bootstrap, session),
          strategy: "git_clone",
          status: isAuthFailure(sanitizedError) ? "awaiting_credentials" : "failed",
          branch: defaultBranch,
          lastAttemptAt: new Date().toISOString(),
          lastError: sanitizedError || "git ls-remote failed during target bootstrap",
        },
      },
    };
  }

  await ensureEmptyWorkspaceDir(workspacePath);
  const branchProbeResult = await runGitCommand(["ls-remote", "--heads", authenticatedRepoUrl || repoUrl, defaultBranch]);
  const cloneArgs = ["clone", "--depth", "1"];
  if (branchProbeResult.status === 0 && String(branchProbeResult.stdout || "").trim()) {
    cloneArgs.push("--branch", defaultBranch);
  }
  cloneArgs.push(authenticatedRepoUrl || repoUrl, workspacePath);
  const cloneResult = await runGitCommand(cloneArgs);
  if (cloneResult.status !== 0) {
    const sanitizedError = sanitizeGitOutput(`${cloneResult.stderr}\n${cloneResult.stdout}`, token, authenticatedRepoUrl, repoUrl);
    return {
      ...session,
      workspace: {
        ...session.workspace,
        bootstrap: {
          ...normalizeWorkspaceBootstrap(session?.workspace?.bootstrap, session),
          strategy: "git_clone",
          status: isAuthFailure(sanitizedError) ? "awaiting_credentials" : "failed",
          branch: defaultBranch,
          lastAttemptAt: new Date().toISOString(),
          lastError: sanitizedError || "git clone failed during target bootstrap",
        },
      },
    };
  }

  return {
    ...session,
    repo: {
      ...session.repo,
      localPath: workspacePath,
    },
    workspace: {
      ...session.workspace,
      path: workspacePath,
      prepared: true,
      preparedAt: normalizeNullableString(session?.workspace?.preparedAt) || new Date().toISOString(),
      bootstrap: {
        ...normalizeWorkspaceBootstrap(session?.workspace?.bootstrap, session),
        strategy: "git_clone",
        status: "ready",
        branch: defaultBranch,
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
      },
    },
  };
}

export function validateTargetIntakeManifest(manifest: any) {
  const repo = extractRepoIdentity(manifest);
  const requestedMode = normalizeNullableString(manifest?.mode) || PLATFORM_MODE.SINGLE_TARGET_DELIVERY;
  const objectiveSummary = normalizeNullableString(manifest?.objective?.summary);

  if (requestedMode !== PLATFORM_MODE.SINGLE_TARGET_DELIVERY) {
    throw new Error("Target intake manifest mode must be single_target_delivery");
  }
  if (!repo.repoUrl) {
    throw new Error("Target intake manifest requires repoUrl");
  }
  if (!objectiveSummary) {
    throw new Error("Target intake manifest requires objective.summary");
  }

  return {
    schemaVersion: Number.isFinite(Number(manifest?.schemaVersion)) ? Number(manifest.schemaVersion) : 1,
    requestId: normalizeNullableString(manifest?.requestId),
    mode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
    projectId: buildTargetProjectId(manifest),
    target: {
      repoUrl: repo.repoUrl,
      localPathHint: repo.localPath,
      defaultBranch: normalizeNullableString(manifest?.target?.defaultBranch || manifest?.repo?.defaultBranch || manifest?.defaultBranch) || "main",
      provider: detectRepoProvider(repo.repoUrl, manifest?.target?.provider || manifest?.repo?.provider),
      repoFullName: normalizeNullableString(manifest?.target?.repoFullName),
      repoCreatedByAtlas: manifest?.target?.repoCreatedByAtlas === true,
      deleteOnCancel: manifest?.target?.deleteOnCancel === true,
    },
    objective: {
      summary: objectiveSummary,
      desiredOutcome: normalizeNullableString(manifest?.objective?.desiredOutcome),
      acceptanceCriteria: normalizeStringArray(manifest?.objective?.acceptanceCriteria),
    },
    constraints: {
      protectedPaths: normalizeStringArray(manifest?.constraints?.protectedPaths),
      forbiddenActions: normalizeStringArray(manifest?.constraints?.forbiddenActions),
    },
    operator: {
      requestedBy: normalizeNullableString(manifest?.operator?.requestedBy) || "user",
      approvalMode: normalizeNullableString(manifest?.operator?.approvalMode) || "human_required_for_high_risk",
    },
    hints: {
      stackHint: normalizeNullableString(manifest?.stackHint),
      knownBuildCommand: normalizeNullableString(manifest?.knownBuildCommand),
      knownTestCommand: normalizeNullableString(manifest?.knownTestCommand),
      knownRisks: normalizeStringArray(manifest?.knownRisks),
      expectedSecrets: normalizeStringArray(manifest?.expectedSecrets),
      notes: normalizeStringArray(manifest?.notes),
    },
  };
}

function buildTargetSessionRecord(manifest: any, config: any, opts: { projectId?: string; sessionId?: string; now?: string } = {}) {
  const normalizedManifest = validateTargetIntakeManifest(manifest);
  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");
  const workspaceDir = getWorkspaceDir(config);
  const rootDir = getRootDir(config);
  const projectId = opts.projectId || normalizedManifest.projectId;
  const sessionId = opts.sessionId || buildTargetSessionId(opts.now ? new Date(opts.now) : new Date());
  const now = opts.now || new Date().toISOString();

  return {
    schemaVersion: TARGET_SESSION_SCHEMA_VERSION,
    currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
    projectId,
    sessionId,
    currentStage: TARGET_SESSION_STAGE.ONBOARDING,
    repo: {
      repoUrl: normalizedManifest.target.repoUrl,
      localPath: normalizedManifest.target.localPathHint,
      name: extractRepoIdentity(manifest).displayName,
      defaultBranch: normalizedManifest.target.defaultBranch,
      provider: normalizedManifest.target.provider,
      repoFullName: normalizedManifest.target.repoFullName,
      repoCreatedByAtlas: normalizedManifest.target.repoCreatedByAtlas === true,
      deleteOnCancel: normalizedManifest.target.deleteOnCancel === true,
    },
    objective: normalizedManifest.objective,
    workspace: {
      rootDir: getTargetWorkspaceRootPath(workspaceDir, rootDir),
      path: getTargetWorkspacePath(workspaceDir, projectId, sessionId, rootDir),
      kind: "isolated_target_workspace",
      prepared: false,
      preparedAt: null,
      bootstrap: {
        strategy: "pending",
        status: "pending",
        remoteOrigin: normalizedManifest.target.repoUrl,
        branch: normalizedManifest.target.defaultBranch,
        lastAttemptAt: null,
        lastError: null,
      },
    },
    onboarding: {
      completed: false,
      reportPath: getTargetOnboardingReportPath(stateDir, projectId, sessionId),
      recommendedNextStage: null,
      readiness: "pending",
      readinessScore: 0,
      baselineCaptured: false,
    },
    repoProfile: {
      repoState: "unknown",
      repoStateReason: null,
      analysisPath: getTargetRepoAnalysisPath(stateDir, projectId, sessionId),
      analyzedAt: null,
      selectedOnboardingAgent: null,
      meaningfulEntryPoints: [],
      dominantSignals: [],
    },
    clarification: {
      status: "pending",
      mode: "unknown",
      selectedAgentSlug: null,
      packetPath: getTargetClarificationPacketPath(stateDir, projectId, sessionId),
      transcriptPath: getTargetClarificationTranscriptPath(stateDir, projectId, sessionId),
      intentContractPath: getTargetIntentContractPath(stateDir, projectId, sessionId),
      questionCount: 0,
      pendingQuestions: [],
      loopCount: 0,
      readyForPlanning: false,
      lastAskedAt: null,
      lastAnsweredAt: null,
      completedAt: null,
    },
    intent: {
      status: TARGET_INTENT_STATUS.PENDING,
      summary: null,
      repoState: "unknown",
      planningMode: null,
      productType: null,
      targetUsers: [],
      mustHaveFlows: [],
      scopeIn: [],
      scopeOut: [],
      protectedAreas: [],
      preferredQualityBar: null,
      designDirection: null,
      deploymentExpectations: [],
      successCriteria: [],
      assumptions: [],
      openQuestions: [],
      sourceIntentContractPath: getTargetIntentContractPath(stateDir, projectId, sessionId),
      updatedAt: null,
    },
    feedback: {
      pendingResearchRefresh: false,
      pendingIntentClarification: false,
      lastAthenaReview: {
        status: "none",
        category: null,
        code: null,
        message: null,
        corrections: [],
        updatedAt: null,
      },
    },
    prerequisites: {
      blockedReason: null,
      missing: [],
      requiredNow: [],
      requiredLater: [],
      optional: [],
      blockingNow: false,
      awaitingHumanInput: false,
    },
    gates: {
      allowPlanning: false,
      allowShadowExecution: false,
      allowActiveExecution: false,
      quarantine: false,
      quarantineReason: null,
    },
    lifecycle: {
      openedAt: now,
      updatedAt: now,
      closedAt: null,
      archivedAt: null,
      status: "open",
      completionReason: null,
    },
    handoff: {
      carriedContextSummary: null,
      requiredHumanInputs: [],
      lastAction: "session_opened",
      nextAction: "run_onboarding",
    },
    constraints: normalizedManifest.constraints,
    operator: normalizedManifest.operator,
    warnings: [],
  };
}

export function normalizeActiveTargetSession(rawSession: any, config: any) {
  if (!rawSession || typeof rawSession !== "object") {
    return { session: null, warnings: [] as string[] };
  }

  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");
  const workspaceDir = getWorkspaceDir(config);
  const rootDir = getRootDir(config);
  const projectId = normalizeNullableString(rawSession?.projectId);
  const sessionId = normalizeNullableString(rawSession?.sessionId);
  const warnings: string[] = [];

  if (!projectId || !sessionId) {
    return {
      session: null,
      warnings: ["active target session missing projectId or sessionId; ignoring invalid session file"],
    };
  }

  const currentStage = normalizeStage(rawSession?.currentStage);
  if (rawSession?.currentMode !== PLATFORM_MODE.SINGLE_TARGET_DELIVERY) {
    warnings.push("active target session currentMode was normalized to single_target_delivery");
  }
  if (currentStage !== rawSession?.currentStage) {
    warnings.push("active target session stage was invalid and normalized to onboarding");
  }
  if (normalizeNullableString(rawSession?.workspace?.path) !== getTargetWorkspacePath(workspaceDir, projectId, sessionId, rootDir)) {
    warnings.push("active target session workspace path was rebased to the isolated target workspace root");
  }

  const updatedAt = normalizeNullableString(rawSession?.lifecycle?.updatedAt) || new Date().toISOString();
  const session = {
    schemaVersion: TARGET_SESSION_SCHEMA_VERSION,
    currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
    projectId,
    sessionId,
    currentStage,
    repo: {
      repoUrl: normalizeNullableString(rawSession?.repo?.repoUrl),
      localPath: normalizeNullableString(rawSession?.repo?.localPath),
      name: normalizeNullableString(rawSession?.repo?.name) || projectId,
      defaultBranch: normalizeNullableString(rawSession?.repo?.defaultBranch) || "main",
      provider: normalizeNullableString(rawSession?.repo?.provider) || detectRepoProvider(normalizeNullableString(rawSession?.repo?.repoUrl), null),
      repoFullName: normalizeNullableString(rawSession?.repo?.repoFullName),
      repoCreatedByAtlas: rawSession?.repo?.repoCreatedByAtlas === true,
      deleteOnCancel: rawSession?.repo?.deleteOnCancel === true,
    },
    objective: {
      summary: normalizeNullableString(rawSession?.objective?.summary) || "Target objective pending",
      desiredOutcome: normalizeNullableString(rawSession?.objective?.desiredOutcome),
      acceptanceCriteria: normalizeStringArray(rawSession?.objective?.acceptanceCriteria),
    },
    workspace: {
      rootDir: getTargetWorkspaceRootPath(workspaceDir, rootDir),
      path: getTargetWorkspacePath(workspaceDir, projectId, sessionId, rootDir),
      kind: "isolated_target_workspace",
      prepared: rawSession?.workspace?.prepared === true,
      preparedAt: rawSession?.workspace?.prepared === true
        ? normalizeNullableString(rawSession?.workspace?.preparedAt) || updatedAt
        : null,
      bootstrap: normalizeWorkspaceBootstrap(rawSession?.workspace?.bootstrap, rawSession),
    },
    onboarding: {
      completed: rawSession?.onboarding?.completed === true,
      reportPath: normalizeNullableString(rawSession?.onboarding?.reportPath) || getTargetOnboardingReportPath(stateDir, projectId, sessionId),
      recommendedNextStage: normalizeNullableString(rawSession?.onboarding?.recommendedNextStage),
      readiness: normalizeNullableString(rawSession?.onboarding?.readiness) || "pending",
      readinessScore: Number.isFinite(Number(rawSession?.onboarding?.readinessScore)) ? Number(rawSession.onboarding.readinessScore) : 0,
      baselineCaptured: rawSession?.onboarding?.baselineCaptured === true,
    },
    repoProfile: {
      repoState: normalizeNullableString(rawSession?.repoProfile?.repoState) || "unknown",
      repoStateReason: normalizeNullableString(rawSession?.repoProfile?.repoStateReason),
      analysisPath: normalizeNullableString(rawSession?.repoProfile?.analysisPath) || getTargetRepoAnalysisPath(stateDir, projectId, sessionId),
      analyzedAt: normalizeNullableString(rawSession?.repoProfile?.analyzedAt),
      selectedOnboardingAgent: normalizeNullableString(rawSession?.repoProfile?.selectedOnboardingAgent),
      meaningfulEntryPoints: normalizeStringArray(rawSession?.repoProfile?.meaningfulEntryPoints),
      dominantSignals: normalizeStringArray(rawSession?.repoProfile?.dominantSignals),
    },
    clarification: {
      status: normalizeNullableString(rawSession?.clarification?.status) || "pending",
      mode: normalizeNullableString(rawSession?.clarification?.mode) || "unknown",
      selectedAgentSlug: normalizeNullableString(rawSession?.clarification?.selectedAgentSlug),
      packetPath: normalizeNullableString(rawSession?.clarification?.packetPath) || getTargetClarificationPacketPath(stateDir, projectId, sessionId),
      transcriptPath: normalizeNullableString(rawSession?.clarification?.transcriptPath) || getTargetClarificationTranscriptPath(stateDir, projectId, sessionId),
      intentContractPath: normalizeNullableString(rawSession?.clarification?.intentContractPath) || getTargetIntentContractPath(stateDir, projectId, sessionId),
      questionCount: Number.isFinite(Number(rawSession?.clarification?.questionCount)) ? Number(rawSession.clarification.questionCount) : 0,
      pendingQuestions: normalizeStringArray(rawSession?.clarification?.pendingQuestions),
      loopCount: Number.isFinite(Number(rawSession?.clarification?.loopCount)) ? Number(rawSession.clarification.loopCount) : 0,
      readyForPlanning: rawSession?.clarification?.readyForPlanning === true,
      lastAskedAt: normalizeNullableString(rawSession?.clarification?.lastAskedAt),
      lastAnsweredAt: normalizeNullableString(rawSession?.clarification?.lastAnsweredAt),
      completedAt: normalizeNullableString(rawSession?.clarification?.completedAt),
    },
    intent: normalizeTargetIntent(rawSession?.intent, stateDir, projectId, sessionId),
    feedback: normalizeTargetFeedback(rawSession?.feedback),
    prerequisites: {
      blockedReason: normalizeNullableString(rawSession?.prerequisites?.blockedReason),
      missing: normalizeStringArray(rawSession?.prerequisites?.missing),
      requiredNow: normalizeStringArray(rawSession?.prerequisites?.requiredNow),
      requiredLater: normalizeStringArray(rawSession?.prerequisites?.requiredLater),
      optional: normalizeStringArray(rawSession?.prerequisites?.optional),
      blockingNow: rawSession?.prerequisites?.blockingNow === true,
      awaitingHumanInput: rawSession?.prerequisites?.awaitingHumanInput === true,
    },
    gates: {
      allowPlanning: rawSession?.gates?.allowPlanning === true,
      allowShadowExecution: rawSession?.gates?.allowShadowExecution === true,
      allowActiveExecution: rawSession?.gates?.allowActiveExecution === true,
      quarantine: rawSession?.gates?.quarantine === true,
      quarantineReason: normalizeNullableString(rawSession?.gates?.quarantineReason),
    },
    lifecycle: {
      openedAt: normalizeNullableString(rawSession?.lifecycle?.openedAt) || updatedAt,
      updatedAt,
      closedAt: normalizeNullableString(rawSession?.lifecycle?.closedAt),
      archivedAt: normalizeNullableString(rawSession?.lifecycle?.archivedAt),
      status: CLOSED_TARGET_SESSION_STAGES.has(currentStage as TargetSessionStage)
        ? currentStage
        : currentStage === TARGET_SESSION_STAGE.QUARANTINED
          ? "quarantined"
          : "open",
      completionReason: normalizeNullableString(rawSession?.lifecycle?.completionReason),
    },
    handoff: {
      carriedContextSummary: normalizeNullableString(rawSession?.handoff?.carriedContextSummary),
      requiredHumanInputs: normalizeStringArray(rawSession?.handoff?.requiredHumanInputs),
      lastAction: normalizeNullableString(rawSession?.handoff?.lastAction) || "session_loaded",
      nextAction: normalizeNullableString(rawSession?.handoff?.nextAction) || "preserve_session_truth",
    },
    constraints: {
      protectedPaths: normalizeStringArray(rawSession?.constraints?.protectedPaths),
      forbiddenActions: normalizeStringArray(rawSession?.constraints?.forbiddenActions),
    },
    operator: {
      requestedBy: normalizeNullableString(rawSession?.operator?.requestedBy) || "user",
      approvalMode: normalizeNullableString(rawSession?.operator?.approvalMode) || "human_required_for_high_risk",
    },
    warnings,
  };

  return { session, warnings };
}

export async function persistTargetSessionSnapshot(session: any, config: any) {
  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");
  await Promise.all([
    writeJson(getActiveTargetSessionPath(stateDir), session),
    writeJson(getTargetSessionStateFilePath(stateDir, session.projectId, session.sessionId), session),
  ]);
}

export async function saveActiveTargetSession(config: any, session: any) {
  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");
  const previousRawSession = await readJson(getActiveTargetSessionPath(stateDir), null);
  const previousSession = normalizeActiveTargetSession(previousRawSession, config).session;
  const normalized = normalizeActiveTargetSession(session, config);
  if (!normalized.session) {
    throw new Error("Cannot save invalid active target session");
  }
  const relocatedSession = await ensureTargetWorkspaceLocation(normalized.session, config);
  if (shouldResetTargetSessionEphemeralState(previousSession, relocatedSession)) {
    await clearTargetSessionEphemeralState(config);
  }
  await persistTargetSessionSnapshot(relocatedSession, config);
  return relocatedSession;
}

export async function loadActiveTargetSession(config: any) {
  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");
  const rawSession = await readJson(getActiveTargetSessionPath(stateDir), null);
  const normalized = normalizeActiveTargetSession(rawSession, config);
  if (normalized.session) {
    const relocatedSession = await ensureTargetWorkspaceLocation(normalized.session, config);
    await persistTargetSessionSnapshot(relocatedSession, config);
    return relocatedSession;
  }
  return normalized.session;
}

export async function loadLastArchivedTargetSession(config: any) {
  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");
  const rawSession = await readJson(getLastArchivedTargetSessionPath(stateDir), null);
  const normalized = normalizeActiveTargetSession(rawSession, config);
  if (!normalized.session) return normalized.session;
  return ensureTargetWorkspaceLocation(normalized.session, config);
}

export async function clearLastArchivedTargetSession(config: any) {
  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");
  await fs.rm(getLastArchivedTargetSessionPath(stateDir), { force: true }).catch(() => {});
}

export async function createTargetSession(manifest: any, config: any) {
  const existingSession = await loadActiveTargetSession(config);
  const requestedRepoIdentity = buildSessionRepoIdentity(manifest);
  if (existingSession && !CLOSED_TARGET_SESSION_STAGES.has(String(existingSession.currentStage || "") as TargetSessionStage)) {
    const existingRepoIdentity = buildSessionRepoIdentity(existingSession);
    if (requestedRepoIdentity && existingRepoIdentity && requestedRepoIdentity === existingRepoIdentity) {
      throw new Error(`Active target session for this repo already exists: ${existingSession.sessionId}`);
    }
    throw new Error(`Active target session already exists: ${existingSession.sessionId}`);
  }

  let session = buildTargetSessionRecord(manifest, config);
  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");

  await clearTargetSessionEphemeralState(config);
  await fs.mkdir(getTargetSessionPath(stateDir, session.projectId, session.sessionId), { recursive: true });
  await fs.mkdir(session.workspace.path, { recursive: true });
  session = await prepareTargetWorkspaceForSession(session, config);
  await Promise.all([
    writeJson(
      getTargetIntakeManifestPath(stateDir, session.projectId, session.sessionId),
      validateTargetIntakeManifest(manifest)
    ),
    persistTargetSessionSnapshot(session, config),
  ]);
  await updatePlatformModeState(config, {
    currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
    activeTargetSessionId: session.sessionId,
    activeTargetProjectId: session.projectId,
    fallbackModeAfterCompletion: PLATFORM_MODE.IDLE,
    reason: `target_session_opened:${session.sessionId}`,
  }, session);

  return session;
}

export async function transitionActiveTargetSession(config: any, input: {
  nextStage: string;
  reason?: string | null;
  actor?: string | null;
  nextAction?: string | null;
  handoff?: Record<string, unknown>;
  prerequisites?: Record<string, unknown>;
  gates?: Record<string, unknown>;
}): Promise<any> {
  const activeSession = await loadActiveTargetSession(config);
  if (!activeSession) {
    throw new Error("No active target session to transition");
  }

  const nextStage = normalizeStage(input?.nextStage);
  const now = new Date().toISOString();
  const stageDefaultGates = buildDefaultStageGates(nextStage);
  const mergedPrerequisites = {
    ...activeSession.prerequisites,
    ...(input?.prerequisites && typeof input.prerequisites === "object" ? input.prerequisites : {}),
  };
  const mergedGates = {
    ...activeSession.gates,
    ...stageDefaultGates,
    ...(input?.gates && typeof input.gates === "object" ? input.gates : {}),
  };
  if (nextStage === TARGET_SESSION_STAGE.QUARANTINED) {
    mergedGates.quarantine = true;
    mergedGates.allowPlanning = false;
    mergedGates.allowShadowExecution = false;
    mergedGates.allowActiveExecution = false;
  }

  const transitionedSession = {
    ...activeSession,
    currentStage: nextStage,
    onboarding: {
      ...activeSession.onboarding,
      recommendedNextStage: nextStage,
    },
    prerequisites: {
      ...mergedPrerequisites,
      blockedReason: normalizeNullableString(mergedPrerequisites.blockedReason),
      missing: normalizeStringArray(mergedPrerequisites.missing),
      requiredNow: normalizeStringArray(mergedPrerequisites.requiredNow),
      requiredLater: normalizeStringArray(mergedPrerequisites.requiredLater),
      optional: normalizeStringArray(mergedPrerequisites.optional),
      blockingNow: normalizeBooleanOrFallback(mergedPrerequisites.blockingNow, activeSession.prerequisites?.blockingNow === true),
      awaitingHumanInput: normalizeBooleanOrFallback(mergedPrerequisites.awaitingHumanInput, activeSession.prerequisites?.awaitingHumanInput === true),
    },
    gates: {
      ...mergedGates,
      quarantineReason: normalizeNullableString(mergedGates.quarantineReason),
    },
    lifecycle: {
      ...activeSession.lifecycle,
      updatedAt: now,
      status: CLOSED_TARGET_SESSION_STAGES.has(nextStage as TargetSessionStage)
        ? nextStage
        : nextStage === TARGET_SESSION_STAGE.QUARANTINED
          ? "quarantined"
          : "open",
      completionReason: CLOSED_TARGET_SESSION_STAGES.has(nextStage as TargetSessionStage)
        ? normalizeNullableString(input?.reason) || activeSession.lifecycle?.completionReason || null
        : activeSession.lifecycle?.completionReason || null,
    },
    handoff: {
      ...activeSession.handoff,
      ...(input?.handoff && typeof input.handoff === "object" ? input.handoff : {}),
      requiredHumanInputs: normalizeStringArray((input?.handoff as any)?.requiredHumanInputs ?? activeSession.handoff?.requiredHumanInputs),
      lastAction: normalizeNullableString(input?.actor)
        ? `${String(input.actor).trim()}:${nextStage}`
        : `stage_transition:${nextStage}`,
      nextAction: normalizeNullableString(input?.nextAction)
        || normalizeNullableString((input?.handoff as any)?.nextAction)
        || resolveStageNextAction(nextStage),
    },
    warnings: [],
  };

  return saveActiveTargetSession(config, transitionedSession);
}

function resolveArchiveLogPath(stateDir: string, stage: string): string {
  if (stage === TARGET_SESSION_STAGE.QUARANTINED) {
    return path.join(getArchiveRootPath(stateDir), "quarantined_sessions.jsonl");
  }
  if (stage === TARGET_SESSION_STAGE.COMPLETED_WITH_HANDOFF) {
    return path.join(getArchiveRootPath(stateDir), "completed_with_handoff_sessions.jsonl");
  }
  return path.join(getArchiveRootPath(stateDir), "completed_sessions.jsonl");
}

export async function archiveTargetSession(config: any, input: { completionStage?: string; completionReason?: string | null; completionSummary?: string | null; unresolvedItems?: string[]; preserveWorkspace?: boolean } = {}) {
  const activeSession = await loadActiveTargetSession(config);
  if (!activeSession) {
    throw new Error("No active target session to archive");
  }

  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");
  const activePath = getActiveTargetSessionPath(stateDir);
  const completionStage = VALID_TARGET_SESSION_STAGES.has(String(input.completionStage || "").trim() as TargetSessionStage)
    ? String(input.completionStage)
    : TARGET_SESSION_STAGE.COMPLETED;
  const archivedAt = new Date().toISOString();
  const archivedSession = {
    ...activeSession,
    currentStage: completionStage,
    lifecycle: {
      ...activeSession.lifecycle,
      status: completionStage,
      closedAt: activeSession.lifecycle?.closedAt || archivedAt,
      archivedAt,
      updatedAt: archivedAt,
      completionReason: normalizeNullableString(input.completionReason) || activeSession.lifecycle?.completionReason || null,
    },
    handoff: {
      ...activeSession.handoff,
      lastAction: "session_archived",
      nextAction: "await_next_target",
    },
  };

  const completionRecord = {
    projectId: archivedSession.projectId,
    sessionId: archivedSession.sessionId,
    currentStage: archivedSession.currentStage,
    finalStatus: archivedSession.currentStage,
    repoUrl: archivedSession.repo?.repoUrl || null,
    objective: archivedSession.objective?.summary || null,
    workspacePath: archivedSession.workspace?.path || null,
    archivedAt,
    completionReason: archivedSession.lifecycle?.completionReason || null,
    completionSummary: normalizeNullableString(input.completionSummary)
      || normalizeNullableString(archivedSession.handoff?.carriedContextSummary)
      || normalizeNullableString(archivedSession.objective?.desiredOutcome)
      || normalizeNullableString(archivedSession.objective?.summary),
    unresolvedItems: normalizeStringArray(input.unresolvedItems).length > 0
      ? normalizeStringArray(input.unresolvedItems)
      : [
          ...normalizeStringArray(archivedSession.prerequisites?.requiredNow),
          ...normalizeStringArray(archivedSession.handoff?.requiredHumanInputs),
        ],
  };
  const archiveLogPath = resolveArchiveLogPath(stateDir, archivedSession.currentStage);
  const preserveWorkspace = input.preserveWorkspace === true;

  await fs.mkdir(path.dirname(archiveLogPath), { recursive: true });
  await Promise.all([
    writeJson(getTargetCompletionPath(stateDir, archivedSession.projectId, archivedSession.sessionId), completionRecord),
    writeJson(getTargetSessionStateFilePath(stateDir, archivedSession.projectId, archivedSession.sessionId), archivedSession),
    writeJson(getLastArchivedTargetSessionPath(stateDir), archivedSession),
    fs.appendFile(archiveLogPath, `${JSON.stringify(completionRecord)}\n`, "utf8"),
  ]);

  await fs.rm(activePath, { force: true });
  if (!preserveWorkspace) {
    await fs.rm(archivedSession.workspace.path, { recursive: true, force: true }).catch(() => {});
  }
  await updatePlatformModeState(config, {
    currentMode: PLATFORM_MODE.IDLE,
    activeTargetSessionId: null,
    activeTargetProjectId: null,
    fallbackModeAfterCompletion: PLATFORM_MODE.IDLE,
    reason: `target_session_closed:${archivedSession.sessionId}`,
  }, null);

  return archivedSession;
}

export async function purgeArchivedTargetSessionArtifacts(config: any, session: any) {
  const normalized = normalizeActiveTargetSession(session, config);
  const archivedSession = normalized.session;
  if (!archivedSession) {
    throw new Error("Cannot purge invalid archived target session");
  }

  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");
  const sessionPath = getTargetSessionPath(stateDir, archivedSession.projectId, archivedSession.sessionId);
  const archiveLogPath = resolveArchiveLogPath(stateDir, archivedSession.currentStage);
  const lastArchivedPath = getLastArchivedTargetSessionPath(stateDir);

  const archiveLogRaw = await fs.readFile(archiveLogPath, "utf8").catch(() => "");
  if (archiveLogRaw) {
    const filteredLines = archiveLogRaw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.includes(`"sessionId":"${archivedSession.sessionId}"`));
    const nextRaw = filteredLines.length > 0 ? `${filteredLines.join("\n")}\n` : "";
    await fs.writeFile(archiveLogPath, nextRaw, "utf8");
  }

  await fs.rm(sessionPath, { recursive: true, force: true }).catch(() => {});

  const lastArchivedRaw = await readJson(lastArchivedPath, null);
  if (String(lastArchivedRaw?.sessionId || "").trim() === archivedSession.sessionId) {
    await fs.rm(lastArchivedPath, { force: true }).catch(() => {});
  }
}

export function summarizeActiveTargetSession(session: any): string {
  if (!session) {
    return "status=none";
  }

  return [
    `projectId=${String(session.projectId || "unknown")}`,
    `sessionId=${String(session.sessionId || "unknown")}`,
    `stage=${String(session.currentStage || TARGET_SESSION_STAGE.ONBOARDING)}`,
    `clarification=${String(session.clarification?.status || "pending")}`,
    `intent=${String(session.intent?.status || TARGET_INTENT_STATUS.PENDING)}`,
    `feedback=${String(session.feedback?.lastAthenaReview?.category || "none")}`,
    `workspace=${String(session.workspace?.path || "none")}`,
    `allowPlanning=${session.gates?.allowPlanning === true}`,
    `allowShadowExecution=${session.gates?.allowShadowExecution === true}`,
    `allowActiveExecution=${session.gates?.allowActiveExecution === true}`,
  ].join(" | ");
}