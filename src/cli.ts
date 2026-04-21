import type { Config } from "./types/index.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "./config.js";
import { runOnce, runDaemon, runResumeDispatch } from "./core/orchestrator.js";
import { runDoctor } from "./core/doctor.js";
import { loadPlatformModeState, PLATFORM_MODE, summarizePlatformModeState, updatePlatformModeState } from "./core/mode_state.js";
import {
  archiveTargetSession,
  clearLastArchivedTargetSession,
  createTargetSession,
  loadActiveTargetSession,
  loadLastArchivedTargetSession,
  purgeArchivedTargetSessionArtifacts,
  saveActiveTargetSession,
  summarizeActiveTargetSession,
  TARGET_SESSION_STAGE,
  transitionActiveTargetSession,
} from "./core/target_session_state.js";
import { getTargetClarificationRuntimeState, submitTargetClarificationAnswer } from "./core/clarification_runtime.js";
import { buildSingleTargetStartupGuardMessage, evaluateSingleTargetStartupRequirements } from "./core/single_target_startup_guard.js";
import { runTargetOnboarding } from "./core/onboarding_runner.js";
import {
  readDaemonPid,
  readStopRequest,
  isDaemonProcess,
  isProcessAlive,
  requestDaemonStop,
  requestDaemonReload,
  clearDaemonPid,
  clearStopRequest,
  clearAllAIState,
  killAllDaemonProcesses
} from "./core/daemon_control.js";

// ── box on: start dashboard + daemon in one command ──────────────────────────
// ── atlas on: start dashboard + daemon in one command ────────────────────────

function killByPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const ps = spawn("powershell", [
        "-NoProfile", "-Command",
        `$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; $c.OwningProcess}else{''}`
      ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let out = "";
      ps.stdout.on("data", (d) => { out += d; });
      ps.on("close", () => {
        const pid = parseInt(out.trim(), 10);
        resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
      });
      ps.on("error", () => resolve(null));
    } else {
      const fuser = spawn("fuser", [`${port}/tcp`], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      fuser.stdout.on("data", (d) => { out += d; });
      fuser.on("close", () => {
        const pid = parseInt(out.trim(), 10);
        if (Number.isFinite(pid) && pid > 0) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
          resolve(pid);
        } else {
          resolve(null);
        }
      });
      fuser.on("error", () => resolve(null));
    }
  });
}

function spawnDetached(command: string, args: string[], cwd: string): number | undefined {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child.pid;
}

function savePid(stateDir: string, name: string, pid: number | undefined): void {
  const filePath = path.join(stateDir, `${name}.pid`);
  writeFileSync(filePath, String(pid), "utf8");
}

function readPid(stateDir: string, name: string): number | null {
  const filePath = path.join(stateDir, `${name}.pid`);
  try {
    if (existsSync(filePath)) {
      const pid = parseInt(readFileSync(filePath, "utf8").trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
  } catch { /* ignore */ }
  return null;
}

function removePidFile(stateDir: string, name: string): void {
  const filePath = path.join(stateDir, `${name}.pid`);
  try { unlinkSync(filePath); } catch { /* ignore */ }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getArgValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function hasArgFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function printTargetStatus(modeSummary: string, sessionSummary: string, readinessSummary?: string | null): void {
  console.log(`[atlas target] mode=${modeSummary}`);
  console.log(`[atlas target] session=${sessionSummary}`);
  if (readinessSummary) {
    console.log(`[atlas target] readiness=${readinessSummary}`);
  }
}

async function summarizeTargetReadinessState(config: Config): Promise<string | null> {
  const filePath = path.join(config.paths.stateDir, "last_target_project_readiness.json");
  try {
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    const status = String(raw?.status || "unknown");
    const projectReadiness = String(raw?.dimensions?.projectReadiness?.status || "unknown");
    const researchSaturation = String(raw?.dimensions?.researchSaturation?.status || "unknown");
    const blockers = Array.isArray(raw?.blockers) ? raw.blockers.join(",") : "none";
    return `status=${status} | projectReadiness=${projectReadiness} | researchSaturation=${researchSaturation} | blockers=${blockers || "none"}`;
  } catch {
    return null;
  }
}

function printProductHeader(title: string, subtitle?: string | null): void {
  console.log("");
  console.log(`=== ${title} ===`);
  if (subtitle) {
    console.log(subtitle);
  }
}

function printProductField(label: string, value: unknown): void {
  console.log(`${label}: ${String(value ?? "-")}`);
}

function humanizeMode(mode: unknown): string {
  return String(mode || "unknown").replace(/_/g, " ");
}

function resolveModeAlias(value: unknown): string | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "status") return null;
  if (["target", "single-target", "single_target", "single_target_delivery"].includes(normalized)) {
    return PLATFORM_MODE.SINGLE_TARGET_DELIVERY;
  }
  if (["idle"].includes(normalized)) {
    return PLATFORM_MODE.IDLE;
  }
  return "invalid";
}

async function printModeScreen(config: Config): Promise<void> {
  const modeState = await loadPlatformModeState(config);
  const session = await loadActiveTargetSession(config);
  printProductHeader("Atlas Mode", "Simple mode switch surface");
  printProductField("current", humanizeMode(modeState.currentMode));
  printProductField("fallback", humanizeMode(modeState.fallbackModeAfterCompletion));
  printProductField("single target enabled", modeState.singleTargetDeliveryEnabled === true ? "yes" : "no");
  printProductField("active target session", session?.sessionId || "none");
  if (session?.objective?.summary) {
    printProductField("target objective", session.objective.summary);
  }
  if (Array.isArray(modeState.warnings) && modeState.warnings.length > 0) {
    printProductField("warnings", modeState.warnings.join(" | "));
  }
}

async function setPlatformModeFromCli(config: Config, modeValue: string): Promise<void> {
  const requestedMode = resolveModeAlias(modeValue);
  if (requestedMode === "invalid") {
    throw new Error(`unknown mode: ${modeValue}`);
  }
  if (!requestedMode) {
    await printModeScreen(config);
    return;
  }

  if (requestedMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY) {
    if (!(await ensureSingleTargetStartupReady(config, { forceSingleTarget: true }))) {
      return;
    }
    const activeSession = await loadActiveTargetSession(config);
    if (!activeSession) {
      console.error("[atlas mode] no active target session. Use: node --import tsx src/cli.ts activate --manifest <path>");
      return;
    }
    await updatePlatformModeState(config, {
      currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
      activeTargetSessionId: activeSession.sessionId,
      activeTargetProjectId: activeSession.projectId,
      fallbackModeAfterCompletion: PLATFORM_MODE.IDLE,
      reason: "cli_mode_switch:single_target_delivery",
    }, activeSession);
  } else {
    await updatePlatformModeState(config, {
      currentMode: requestedMode,
      reason: `cli_mode_switch:${requestedMode}`,
    });
  }

  await printModeScreen(config);
}

async function printActivationScreen(config: Config, session?: any | null): Promise<void> {
  const activeSession = session || await loadActiveTargetSession(config);
  const modeState = await loadPlatformModeState(config);
  printProductHeader("Atlas Activate", "Single-target activation flow");
  printProductField("mode", humanizeMode(modeState.currentMode));
  if (!activeSession) {
    printProductField("status", "no active target session");
    console.log("next: node --import tsx src/cli.ts activate --manifest <path>");
    return;
  }

  printProductField("session", activeSession.sessionId);
  printProductField("stage", humanizeMode(activeSession.currentStage));
  printProductField("repo", activeSession.repo?.repoUrl || activeSession.repo?.localPath || "unknown");
  printProductField("objective", activeSession.objective?.summary || "unknown");
  printProductField("repo state", activeSession.intent?.repoState || activeSession.repoProfile?.repoState || "unknown");

  if (activeSession.currentStage === TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION) {
    const runtime = await getTargetClarificationRuntimeState(config, { persistPrompt: true });
    const currentQuestion = runtime?.currentQuestion;
    printProductField("activation", "clarification required");
    if (currentQuestion) {
      printProductField("question", currentQuestion.title || currentQuestion.id);
      printProductField("prompt", currentQuestion.prompt || "-");
      if (Array.isArray(currentQuestion.options) && currentQuestion.options.length > 0) {
        printProductField("options", currentQuestion.options.join(" | "));
      }
      console.log("answer: interactive terminalde dogrudan cevap verebilir veya node --import tsx src/cli.ts activate --answer \"...\" [--options \"A,B\"] kullanabilirsiniz");
    }
    return;
  }

  if (activeSession.currentStage === TARGET_SESSION_STAGE.SHADOW || activeSession.currentStage === TARGET_SESSION_STAGE.ACTIVE) {
    printProductField("activation", "planning ready");
    printProductField("next", activeSession.handoff?.nextAction || "run planning");
    return;
  }

  printProductField("activation", activeSession.handoff?.nextAction || "waiting");
}

async function handleActivationCommand(config: Config): Promise<void> {
  if (!(await ensureSingleTargetStartupReady(config, { forceSingleTarget: true }))) {
    return;
  }

  const manifestPath = getArgValue("--manifest");
  const answerText = getArgValue("--answer");
  const questionId = getArgValue("--question-id");
  const selectedOptions = getArgValue("--options");
  const interactiveEnabled = !process.argv.includes("--no-interactive");
  const deleteRepoOnRestart = hasArgFlag("--delete-repo");

  if (hasArgFlag("--restart") && (answerText || selectedOptions || manifestPath)) {
    throw new Error("--restart cannot be combined with --manifest, --answer, or --options");
  }
  if (deleteRepoOnRestart && !hasArgFlag("--restart")) {
    throw new Error("--delete-repo can only be used with --restart");
  }

  if (manifestPath) {
    const resolvedManifestPath = path.resolve(manifestPath);
    const manifest = JSON.parse(readFileSync(resolvedManifestPath, "utf8"));
    const session = await createTargetSession(manifest, config);
    const onboardingResult = await runTargetOnboarding(config, session);
    const finalSession = interactiveEnabled && isInteractiveTerminal()
      ? await runInteractiveClarificationSession(config, onboardingResult.session)
      : onboardingResult.session;
    await printActivationScreen(config, finalSession);
    return;
  }

  if (answerText || selectedOptions) {
    const result = await submitTargetClarificationAnswer(config, {
      questionId,
      answerText,
      selectedOptions,
      answeredBy: "user",
    });
    const finalSession = interactiveEnabled && isInteractiveTerminal()
      ? await runInteractiveClarificationSession(config, result.session)
      : result.session;
    await printActivationScreen(config, finalSession);
    return;
  }

  const activeSession = await resolveActivationEntrySession(config, interactiveEnabled);
  if (!activeSession && interactiveEnabled && isInteractiveTerminal()) {
    const wizardResult = await runInteractiveActivationWizard(config);
    const session = await createTargetSession(wizardResult.manifest, config);
    const onboardingResult = await runTargetOnboarding(config, session);
    const finalSession = await runInteractiveClarificationSession(config, onboardingResult.session);
    if (wizardResult.createdRepo?.full_name) {
      printProductField("created repo", String(wizardResult.createdRepo.full_name));
    }
    await printActivationScreen(config, finalSession);
    return;
  }

  if (!activeSession && hasArgFlag("--restart")) {
    await printActivationScreen(config);
    return;
  }

  if (
    activeSession
    && interactiveEnabled
    && isInteractiveTerminal()
    && activeSession.currentStage === TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION
  ) {
    const finalSession = await runInteractiveClarificationSession(config, activeSession);
    await printActivationScreen(config, finalSession);
    return;
  }

  await printActivationScreen(config);
}

function printClarificationState(runtime: any): void {
  const currentQuestion = runtime?.currentQuestion;
  const intentSummary = runtime?.intentSummary || runtime?.session?.intent || {};
  console.log(`[atlas clarify] stage=${runtime?.session?.currentStage || "unknown"} status=${runtime?.session?.clarification?.status || "pending"} intent=${intentSummary?.status || "pending"}`);
  if (intentSummary?.summary) {
    console.log(`[atlas clarify] summary=${intentSummary.summary}`);
  }
  if (!currentQuestion) {
    console.log("[atlas clarify] no pending clarification question");
    return;
  }
  console.log(`[atlas clarify] questionId=${currentQuestion.id}`);
  console.log(`[atlas clarify] title=${currentQuestion.title || currentQuestion.id}`);
  console.log(`[atlas clarify] prompt=${currentQuestion.prompt || "(none)"}`);
  if (Array.isArray(currentQuestion.options) && currentQuestion.options.length > 0) {
    console.log(`[atlas clarify] options=${currentQuestion.options.join(" | ")}`);
  }
}

async function ensureSingleTargetStartupReady(config: Config, options: { forceSingleTarget?: boolean } = {}): Promise<boolean> {
  const result = await evaluateSingleTargetStartupRequirements(config, options);
  if (result.ok) return true;
  console.error(buildSingleTargetStartupGuardMessage(result));
  return false;
}

function isInteractiveTerminal(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

async function promptInput(promptText: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return String(await rl.question(promptText)).trim();
  } finally {
    rl.close();
  }
}

async function promptRequired(promptText: string): Promise<string> {
  while (true) {
    const answer = await promptInput(promptText);
    if (answer) return answer;
  }
}

async function promptChoice(promptText: string, allowed: string[], fallback?: string): Promise<string> {
  const normalizedAllowed = allowed.map((entry) => String(entry || "").trim().toLowerCase());
  while (true) {
    const answer = String(await promptInput(promptText) || fallback || "").trim().toLowerCase();
    if (normalizedAllowed.includes(answer)) {
      return answer;
    }
  }
}

function isOtherClarificationOption(value: string): boolean {
  return /^(other|custom|something else|başka|diger|diğer)(\b|\s|$)/i.test(String(value || "").trim());
}

function parseClarificationOptionSelection(rawAnswer: string, options: string[]): { answerText: string; selectedOptions: string[] } {
  const trimmedAnswer = String(rawAnswer || "").trim();
  if (!trimmedAnswer || !Array.isArray(options) || options.length === 0) {
    return { answerText: trimmedAnswer, selectedOptions: [] };
  }

  const normalizedOptions = options.map((option) => String(option || "").trim()).filter(Boolean);
  const optionMap = new Map<string, string>();
  normalizedOptions.forEach((option, index) => {
    optionMap.set(option.toLowerCase(), option);
    optionMap.set(String(index + 1), option);
  });

  const tokens = trimmedAnswer.split(/[|,]/).map((entry) => entry.trim()).filter(Boolean);
  if (tokens.length === 0) {
    return { answerText: trimmedAnswer, selectedOptions: [] };
  }

  const matchedOptions = tokens
    .map((token) => optionMap.get(token.toLowerCase()) || null)
    .filter((value): value is string => Boolean(value));

  if (matchedOptions.length === tokens.length) {
    return {
      answerText: "",
      selectedOptions: [...new Set(matchedOptions)],
    };
  }

  return { answerText: trimmedAnswer, selectedOptions: [] };
}

async function runInteractiveClarificationSession(config: Config, session?: any | null): Promise<any> {
  let currentSession = session || await loadActiveTargetSession(config);
  while (currentSession?.currentStage === TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION) {
    const runtime = await getTargetClarificationRuntimeState(config, { persistPrompt: true });
    const currentQuestion = runtime?.currentQuestion;
    if (!currentQuestion) {
      return runtime?.session || currentSession;
    }

    printProductHeader("BOX Activate", "Clarification required");
      printProductHeader("Atlas Activate", "Clarification required");
    printProductField("session", runtime.session?.sessionId || currentSession?.sessionId || "unknown");
    printProductField("question", currentQuestion.title || currentQuestion.id || "question");
    printProductField("prompt", currentQuestion.prompt || "-");
    const options = Array.isArray(currentQuestion.options)
      ? currentQuestion.options.map((entry: unknown) => String(entry || "").trim()).filter(Boolean)
      : [];
    if (options.length > 0) {
      printProductField("options", options.map((option, index) => `${index + 1}. ${option}`).join(" | "));
    }

    const rawAnswer = await promptRequired("your answer: ");
    const parsedAnswer = parseClarificationOptionSelection(rawAnswer, options);
    if (parsedAnswer.selectedOptions.some((option) => isOtherClarificationOption(option)) && !parsedAnswer.answerText) {
      parsedAnswer.answerText = await promptRequired('describe "Other": ');
    }
    const result = await submitTargetClarificationAnswer(config, {
      questionId: currentQuestion.id,
      answerText: parsedAnswer.answerText,
      selectedOptions: parsedAnswer.selectedOptions,
      answeredBy: "user",
    });
    currentSession = result.session;
  }

  return currentSession;
}

async function restartActiveTargetSession(
  config: Config,
  options: {
    reason?: string;
    deleteRemoteRepo?: boolean;
    completionSummary?: string;
  } = {},
): Promise<void> {
  const activeSession = await loadActiveTargetSession(config);
  if (!activeSession) {
    return;
  }

  const reason = options.reason || "restart_requested_from_activate";
  const deleteRemoteRepo = options.deleteRemoteRepo === true;

  if (deleteRemoteRepo) {
    const repoFullName = String(activeSession?.repo?.repoFullName || "").trim();
    if (!canDeleteSessionRepo(activeSession)) {
      throw new Error("Active target session does not have an Atlas-created repo that can be deleted");
    }
    await deleteGithubRepo(config, repoFullName);
    console.log(`[atlas activate] deleted created repo=${repoFullName}`);
  }

  const archived = await archiveTargetSession(config, {
    completionStage: TARGET_SESSION_STAGE.COMPLETED,
    completionReason: reason,
    completionSummary: options.completionSummary
      || (deleteRemoteRepo
        ? "Target session intentionally closed from the activation flow and the Atlas-created repo was deleted."
        : "Target session intentionally closed from the activation flow while preserving the repository."),
    unresolvedItems: [],
  });
  console.log(`[atlas activate] previous session archived=${archived.sessionId} reason=${reason}`);
}

async function resolveActivationEntrySession(config: Config, interactiveEnabled: boolean): Promise<any | null> {
  const activeSession = await loadActiveTargetSession(config);
  if (!activeSession) {
    return null;
  }

  if (hasArgFlag("--restart")) {
    await restartActiveTargetSession(config, {
      reason: hasArgFlag("--delete-repo") ? "restart_flag_requested_delete_repo" : "restart_flag_requested",
      deleteRemoteRepo: hasArgFlag("--delete-repo"),
    });
    return null;
  }

  if (!interactiveEnabled || !isInteractiveTerminal()) {
    return activeSession;
  }

  printProductHeader("BOX Activate", "Existing target session detected");
  printProductField("session", activeSession.sessionId);
  printProductField("stage", humanizeMode(activeSession.currentStage));
  printProductField("repo", activeSession.repo?.repoUrl || activeSession.repo?.localPath || "unknown");
  printProductField("objective", activeSession.objective?.summary || "unknown");
  const canDeleteCreatedRepo = canDeleteSessionRepo(activeSession);
  console.log("1. Continue current target session");
  console.log("2. Start over and keep current repo");
  console.log("3. Cancel current session");
  console.log(canDeleteCreatedRepo ? "4. Cancel current session and delete created repo" : "4. Keep everything and exit");
  const decision = await promptChoice("select [1/2/3/4]: ", ["1", "2", "3", "4"], "1");
  if (decision === "1") {
    return activeSession;
  }
  if (decision === "2") {
    await restartActiveTargetSession(config, {
      reason: "restart_selected_in_activation_wizard_keep_repo",
    });
    return null;
  }

  if (decision === "3") {
    await restartActiveTargetSession(config, {
      reason: "cancel_selected_keep_existing_repo",
    });
    return null;
  }

  if (decision === "4" && canDeleteCreatedRepo) {
    await restartActiveTargetSession(config, {
      reason: "cancel_selected_delete_created_repo",
      deleteRemoteRepo: true,
    });
    return null;
  }

  console.log("[box activate] cancelled by user");
  process.exit(0);
}

async function githubApiRequest(config: Config, pathname: string, init: RequestInit = {}): Promise<any> {
  const token = String(config?.env?.githubToken || "").trim();
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for GitHub activation wizard");
  }

  const response = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "BOX/1.0",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function deleteGithubRepo(config: Config, repoFullName: string): Promise<void> {
  const normalizedRepoFullName = String(repoFullName || "").trim();
  if (!normalizedRepoFullName) {
    throw new Error("deleteGithubRepo requires repoFullName");
  }
  await githubApiRequest(config, `/repos/${normalizedRepoFullName}`, {
    method: "DELETE",
  });
}

function canDeleteSessionRepo(session: any): boolean {
  return session?.repo?.repoCreatedByBox === true
    && session?.repo?.deleteOnCancel === true
    && String(session?.repo?.repoFullName || "").trim().length > 0;
}

async function promptLastArchivedSessionCleanup(config: Config, interactiveEnabled: boolean): Promise<void> {
  if (!interactiveEnabled || !isInteractiveTerminal()) {
    return;
  }

  const archivedSession = await loadLastArchivedTargetSession(config);
  if (!archivedSession) {
    return;
  }

  printProductHeader("BOX Activate", "Last target session found");
  printProductField("last session", archivedSession.sessionId);
  printProductField("repo", archivedSession.repo?.repoUrl || archivedSession.repo?.localPath || "unknown");
  printProductField("objective", archivedSession.objective?.summary || "unknown");
  console.log("1. Keep last session archive and continue");
  console.log("2. Delete last session archive");
  console.log(canDeleteSessionRepo(archivedSession)
    ? "3. Delete last session archive and created repo"
    : "3. Clear last session reminder only");
  const decision = await promptChoice("select [1/2/3]: ", ["1", "2", "3"], "1");
  if (decision === "1") {
    return;
  }
  if (decision === "2") {
    await purgeArchivedTargetSessionArtifacts(config, archivedSession);
    console.log(`[box activate] deleted archived session=${archivedSession.sessionId}`);
    return;
  }

  if (canDeleteSessionRepo(archivedSession)) {
    await deleteGithubRepo(config, String(archivedSession.repo.repoFullName));
    console.log(`[atlas activate] deleted created repo=${String(archivedSession.repo.repoFullName)}`);
    await purgeArchivedTargetSessionArtifacts(config, archivedSession);
    console.log(`[atlas activate] deleted archived session=${archivedSession.sessionId}`);
    return;
  }

  await clearLastArchivedTargetSession(config);
  console.log("[atlas activate] cleared last session reminder");
}

async function listGithubRepos(config: Config): Promise<Array<Record<string, unknown>>> {
  const repos = await githubApiRequest(config, "/user/repos?per_page=30&sort=updated&affiliation=owner,collaborator");
  return Array.isArray(repos) ? repos : [];
}

async function createGithubRepo(config: Config, repoInput: {
  name: string;
  description?: string;
  visibility: "public" | "private";
}): Promise<Record<string, unknown>> {
  return githubApiRequest(config, "/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name: repoInput.name,
      description: repoInput.description || "",
      private: repoInput.visibility === "private",
      auto_init: false,
    }),
  });
}

function buildInteractiveManifest(
  repoUrl: string,
  objectiveSummary: string,
  repoName?: string | null,
  repoOptions: { repoFullName?: string | null; repoCreatedByBox?: boolean; deleteOnCancel?: boolean } = {},
): Record<string, unknown> {
  return {
    mode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
    requestId: `req_target_${Date.now()}`,
    target: {
      repoUrl,
      defaultBranch: "main",
      provider: "github",
      repoFullName: String(repoOptions.repoFullName || "").trim() || null,
      repoCreatedByBox: repoOptions.repoCreatedByBox === true,
      deleteOnCancel: repoOptions.deleteOnCancel === true,
    },
    objective: {
      summary: objectiveSummary,
      desiredOutcome: `${repoName || repoUrl} reaches single_target_project_readiness for delivery`,
      acceptanceCriteria: ["clarified", "single_target_project_readiness"],
    },
    constraints: {
      protectedPaths: [],
      forbiddenActions: [],
    },
    operator: {
      requestedBy: "user",
      approvalMode: "human_required_for_high_risk",
    },
  };
}

async function runInteractiveActivationWizard(config: Config): Promise<{ manifest: Record<string, unknown>; createdRepo?: Record<string, unknown> }> {
  printProductHeader("BOX Activate", "Choose repo source");
  console.log("1. Existing GitHub repo");
  console.log("2. New GitHub repo");
  console.log("3. Manual repo URL");
  const sourceChoice = await promptChoice("select [1/2/3]: ", ["1", "2", "3"]);

  if (sourceChoice === "1") {
    const repos = await listGithubRepos(config);
    if (repos.length === 0) {
      console.log("No repos found. Falling back to manual URL.");
      const repoUrl = await promptRequired("repo url: ");
      const objectiveSummary = await promptRequired("what should BOX build or change? ");
      return { manifest: buildInteractiveManifest(repoUrl, objectiveSummary) };
    }

    const shownRepos = repos.slice(0, 12);
    shownRepos.forEach((repo, index) => {
      const fullName = String(repo.full_name || repo.name || `repo-${index + 1}`);
      const description = String(repo.description || "").trim();
      console.log(`${index + 1}. ${fullName}${description ? ` - ${description}` : ""}`);
    });
    console.log("m. Manual repo URL");
    const selection = await promptRequired("pick repo number: ");
    if (selection.toLowerCase() === "m") {
      const repoUrl = await promptRequired("repo url: ");
      const objectiveSummary = await promptRequired("what should BOX build or change? ");
      return { manifest: buildInteractiveManifest(repoUrl, objectiveSummary) };
    }

    const selectedRepo = shownRepos[Number(selection) - 1];
    if (!selectedRepo) {
      throw new Error("Invalid repo selection");
    }

    const objectiveSummary = await promptRequired("what should BOX build or change? ");
    return {
      manifest: buildInteractiveManifest(
        String(selectedRepo.clone_url || selectedRepo.html_url || "").trim(),
        objectiveSummary,
        String(selectedRepo.full_name || selectedRepo.name || "").trim(),
      ),
    };
  }

  if (sourceChoice === "2") {
    const repoName = await promptRequired("new repo name: ");
    const visibility = await promptChoice("visibility [public/private] (default: private): ", ["public", "private"], "private");
    const description = await promptInput("description (optional): ");
    const objectiveSummary = await promptRequired("what should Atlas build in this new repo? ");
    const createdRepo = await createGithubRepo(config, {
      name: repoName,
      description,
      visibility: visibility as "public" | "private",
    });
    return {
      manifest: buildInteractiveManifest(
        String(createdRepo.clone_url || createdRepo.html_url || "").trim(),
        objectiveSummary,
        String(createdRepo.full_name || createdRepo.name || repoName).trim(),
        {
          repoFullName: String(createdRepo.full_name || createdRepo.name || repoName).trim(),
          repoCreatedByBox: true,
          deleteOnCancel: true,
        },
      ),
      createdRepo,
    };
  }

  const repoUrl = await promptRequired("repo url: ");
  const objectiveSummary = await promptRequired("what should BOX build or change? ");
  return { manifest: buildInteractiveManifest(repoUrl, objectiveSummary) };
}

async function boxOn(config: Config): Promise<void> {
  const stateDir = config.paths?.stateDir || "state";
  const root = path.resolve(stateDir, "..");

  const dashboardEnabled = config?.runtime?.dashboardEnabled !== false;

  // 1. Kill stale dashboard on port 8787
  const killed = await killByPort(8787);
  if (killed) console.log(`[box on] killed stale dashboard on port 8787 (pid=${killed})`);

  // 2. Kill any orphan daemon processes before starting fresh
  const orphans = killAllDaemonProcesses();
  if (orphans.length > 0) {
    console.log(`[box on] killed ${orphans.length} orphan daemon(s): ${orphans.join(", ")}`);
  }

  // 3. Check if daemon is already running
  const daemonPidState = await readDaemonPid(config);
  const daemonPid = Number(daemonPidState?.pid || 0);
  if (daemonPid && isDaemonProcess(daemonPid)) {
    console.log(`[box on] daemon already running pid=${daemonPid}`);
  } else {
    // Clear stale stop requests
    await clearStopRequest(config);

    // 4. Start daemon (detached)
    const dPid = spawnDetached("node", ["--import", "tsx", "src/cli.ts", "start"], root);
    savePid(stateDir, "daemon_bg", dPid);
    console.log(`[box on] daemon started pid=${dPid}`);
  }

  // 5. Start dashboard (detached) only when enabled
  if (dashboardEnabled) {
    const dashPid = spawnDetached("node", ["--import", "tsx", "src/dashboard/live_dashboard.ts"], root);
    savePid(stateDir, "dashboard_bg", dashPid);
    console.log(`[box on] dashboard started pid=${dashPid} → http://localhost:8787`);
  } else {
    removePidFile(stateDir, "dashboard_bg");
    console.log("[box on] dashboard auto-start disabled (runtime.dashboardEnabled=false)");
  }

  console.log("");
  if (dashboardEnabled) {
    console.log("Atlas is running. Dashboard: http://localhost:8787");
  } else {
    console.log("Atlas is running. Dashboard is disabled.");
  }
  console.log("To stop: node --import tsx src/cli.ts off");
}

async function boxOff(config: Config): Promise<void> {
  const stateDir = config.paths?.stateDir || "state";

  // 1. Graceful daemon stop via stop request
  const daemonPidState = await readDaemonPid(config);
  const daemonPid = Number(daemonPidState?.pid || 0);
  if (daemonPid && isDaemonProcess(daemonPid)) {
    await requestDaemonStop(config, "cli-off");
    console.log(`[box off] stop requested for daemon pid=${daemonPid}`);

    // Wait up to 8s for daemon to exit
    for (let waited = 0; waited < 8000; waited += 500) {
      await waitMs(500);
      if (!isProcessAlive(daemonPid)) break;
    }
    if (isProcessAlive(daemonPid)) {
      try { process.kill(daemonPid, "SIGKILL"); } catch { /* already gone */ }
      console.log(`[box off] daemon force-killed pid=${daemonPid}`);
      console.log(`[atlas off] daemon force-killed pid=${daemonPid}`);
    } else {
      console.log("[atlas off] daemon stopped cleanly");
    }
  } else {
    await clearDaemonPid(config);
    await clearStopRequest(config);
    console.log("[atlas off] daemon was not running");
  }
  removePidFile(stateDir, "daemon_bg");

  // 1b. Sweep orphan daemon processes that escaped PID-file tracking
  const orphans = killAllDaemonProcesses();
  if (orphans.length > 0) {
    console.log(`[atlas off] killed ${orphans.length} orphan daemon(s): ${orphans.join(", ")}`);
  }

  // 2. Kill dashboard by saved PID
  const dashPid = readPid(stateDir, "dashboard_bg");
  if (dashPid && isProcessAlive(dashPid)) {
    try { process.kill(dashPid, "SIGKILL"); } catch { /* already gone */ }
    console.log(`[atlas off] dashboard stopped pid=${dashPid}`);
  }
  removePidFile(stateDir, "dashboard_bg");

  // 3. Fallback: kill by port 8787
  const killedByPort = await killByPort(8787);
  if (killedByPort) console.log(`[atlas off] dashboard killed by port 8787 (pid=${killedByPort})`);

  console.log("");
  console.log("Atlas is down.");
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "once";
  const config = await loadConfig();

  if (command === "doctor") {
    await runDoctor(config);
    return;
  }

  if (command === "mode") {
    await setPlatformModeFromCli(config, process.argv[3] || "status");
    return;
  }

  if (command === "activate") {
    await handleActivationCommand(config);
    return;
  }

  if (command === "target") {
    const subCommand = process.argv[3] || "status";

    if (subCommand === "start") {
      if (!(await ensureSingleTargetStartupReady(config, { forceSingleTarget: true }))) {
        return;
      }
      const manifestPath = getArgValue("--manifest") || process.argv[4] || null;
      if (!manifestPath) {
        throw new Error("target start requires --manifest <path>");
      }
      const resolvedManifestPath = path.resolve(manifestPath);
      const manifest = JSON.parse(readFileSync(resolvedManifestPath, "utf8"));
      const session = await createTargetSession(manifest, config);
      printTargetStatus(
        summarizePlatformModeState(await loadPlatformModeState(config)),
        summarizeActiveTargetSession(session),
        await summarizeTargetReadinessState(config),
      );
      return;
    }

    if (subCommand === "status") {
      printTargetStatus(
        summarizePlatformModeState(await loadPlatformModeState(config)),
        summarizeActiveTargetSession(await loadActiveTargetSession(config)),
        await summarizeTargetReadinessState(config),
      );
      return;
    }

    if (subCommand === "stage") {
      const nextStage = getArgValue("--to") || process.argv[4] || null;
      if (!nextStage) {
        throw new Error("target stage requires --to <stage>");
      }
      const session = await transitionActiveTargetSession(config, {
        nextStage,
        actor: "cli",
        reason: getArgValue("--reason"),
        nextAction: getArgValue("--next-action"),
      });
      printTargetStatus(
        summarizePlatformModeState(await loadPlatformModeState(config)),
        summarizeActiveTargetSession(session),
        await summarizeTargetReadinessState(config),
      );
      return;
    }

    if (subCommand === "close") {
      const deleteRemoteRepo = hasArgFlag("--delete-repo");
      if (deleteRemoteRepo) {
        const activeSession = await loadActiveTargetSession(config);
        if (!canDeleteSessionRepo(activeSession)) {
          throw new Error("Active target session does not have a BOX-created repo that can be deleted");
        }
        await deleteGithubRepo(config, String(activeSession.repo.repoFullName));
        console.log(`[box target] deleted created repo=${String(activeSession.repo.repoFullName)}`);
      }
      const completionStage = getArgValue("--status") || TARGET_SESSION_STAGE.COMPLETED;
      const archived = await archiveTargetSession(config, {
        completionStage,
        completionReason: getArgValue("--reason"),
        completionSummary: getArgValue("--summary"),
      });
      console.log(`[box target] archived=${archived.sessionId} stage=${archived.currentStage}`);
      printTargetStatus(
        summarizePlatformModeState(await loadPlatformModeState(config)),
        summarizeActiveTargetSession(await loadActiveTargetSession(config)),
        await summarizeTargetReadinessState(config),
      );
      return;
    }

    if (subCommand === "clarify") {
      const answerText = getArgValue("--answer");
      const questionId = getArgValue("--question-id");
      const selectedOptions = getArgValue("--options");
      if (!answerText && !selectedOptions) {
        const runtime = await getTargetClarificationRuntimeState(config, { persistPrompt: true });
        printClarificationState(runtime);
        return;
      }

      const result = await submitTargetClarificationAnswer(config, {
        questionId,
        answerText,
        selectedOptions,
        answeredBy: "user",
      });
      printTargetStatus(
        summarizePlatformModeState(await loadPlatformModeState(config)),
        summarizeActiveTargetSession(result.session),
        await summarizeTargetReadinessState(config),
      );
      printClarificationState({
        session: result.session,
        currentQuestion: result.currentQuestion,
        intentSummary: result.session.intent,
      });
      return;
    }

    throw new Error(`unknown target subcommand: ${subCommand}`);
  }

  if (command === "start") {
    if (!(await ensureSingleTargetStartupReady(config))) {
      return;
    }
    // Kill orphan daemons before starting — prevents multiple instances
    const orphans = killAllDaemonProcesses();
    if (orphans.length > 0) {
      console.log(`[box] killed ${orphans.length} orphan daemon(s): ${orphans.join(", ")}`);
    }

    const daemonPidState = await readDaemonPid(config);
    const daemonPid = Number(daemonPidState?.pid || 0);
    if (daemonPid && isDaemonProcess(daemonPid)) {
      console.log(`[box] daemon already running pid=${daemonPid}`);
      return;
    }

    // Starting should always clear any previously persisted stop request.
    await clearStopRequest(config);

    await runDaemon(config);
    return;
  }

  if (command === "rebase") {
    console.log("[atlas] rebase is not exposed in Atlas.");
    return;
  }

  if (command === "resume") {
    await runResumeDispatch(config);
    console.log("[box] resume completed from dispatch checkpoint");
    return;
  }

  if (command === "reload") {
    const daemonPidState = await readDaemonPid(config);
    const daemonPid = Number(daemonPidState?.pid || 0);
    if (!daemonPid || !isDaemonProcess(daemonPid)) {
      console.log("[box] daemon not running — nothing to reload");
      return;
    }
    await requestDaemonReload(config, "cli-reload");
    console.log(`[box] reload requested for daemon pid=${daemonPid} — config will refresh on next loop iteration`);
    return;
  }

  if (command === "stop") {
    const daemonPidState = await readDaemonPid(config);
    const daemonPid = Number(daemonPidState?.pid || 0);
    if (!daemonPid) {
      await clearDaemonPid(config);
      await clearStopRequest(config);
      console.log("[atlas] cleared stale daemon control files");
      console.log("[atlas] daemon not running");
      return;
    }

    if (!isDaemonProcess(daemonPid)) {
      await clearDaemonPid(config);
      await clearStopRequest(config);
      console.log("[box] cleared stale daemon control files");
      console.log("[box] daemon not running");
      return;
    }

    const existingStopRequest = await readStopRequest(config);
    if (existingStopRequest?.requestedAt) {
      const requestedAtMs = new Date(existingStopRequest.requestedAt).getTime();
      const ageMs = Number.isFinite(requestedAtMs) ? (Date.now() - requestedAtMs) : Number.MAX_SAFE_INTEGER;
      const staleMs = Math.max(120000, Number(config.loopIntervalMs || 0) * 2);
      if (ageMs > staleMs) {
        await clearDaemonPid(config);
        await clearStopRequest(config);
        console.log("[box] cleared stale daemon control files");
        console.log("[atlas] cleared stale daemon control files");
        console.log("[atlas] daemon not running");
          console.log(`[atlas] stop requested for daemon pid=${daemonPid}`);
          // Next "atlas on" or "atlas start" will run fresh Janus cycle.
          console.log(`[atlas shutdown] stop requested for daemon pid=${daemonPid}`);
        return;
      }
    }

    await requestDaemonStop(config, "cli-stop");
    console.log(`[box] stop requested for daemon pid=${daemonPid}`);
    return;
  }

  if (command === "on") {
    if (!(await ensureSingleTargetStartupReady(config))) {
      return;
    }
    await boxOn(config);
    return;
  }

  if (command === "off") {
    await boxOff(config);
    return;
  }

  if (command === "shutdown") {
    // SHUTDOWN = full reset. Kills daemon, clears all AI state.
    // Next "box on" or "box start" will run fresh Janus cycle.
    const daemonPidState = await readDaemonPid(config);
    const daemonPid = Number(daemonPidState?.pid || 0);
    if (daemonPid && isDaemonProcess(daemonPid)) {
      await requestDaemonStop(config, "cli-shutdown");
      console.log(`[box shutdown] stop requested for daemon pid=${daemonPid}`);
      for (let waited = 0; waited < 8000; waited += 500) {
        await waitMs(500);
        if (!isProcessAlive(daemonPid)) break;
      }
      if (isProcessAlive(daemonPid)) {
        try { process.kill(daemonPid, "SIGKILL"); } catch { /* already gone */ }
        console.log(`[atlas shutdown] daemon force-killed pid=${daemonPid}`);
      } else {
        console.log("[atlas shutdown] daemon stopped");
      }
    } else {
      console.log("[atlas shutdown] daemon was not running");
    }

    // Kill dashboard too
    const stateDir = config.paths?.stateDir || "state";
    const dashPid = readPid(stateDir, "dashboard_bg");
    if (dashPid && isProcessAlive(dashPid)) {
      try { process.kill(dashPid, "SIGKILL"); } catch { /* already gone */ }
      console.log(`[atlas shutdown] dashboard stopped pid=${dashPid}`);
    }
    removePidFile(stateDir, "dashboard_bg");
    removePidFile(stateDir, "daemon_bg");
    await killByPort(8787);

    // Clear all AI state for fresh start
    const cleared = await clearAllAIState(config);
    console.log(`[atlas shutdown] cleared ${cleared.length} state files`);
    console.log("");
    console.log("Atlas fully shutdown. All AI state cleared.");
    console.log("Next 'atlas:start' or 'start' run will boot from fresh state.");
    return;
  }

  if (command === "si") {
    console.log("[atlas] self-improvement controls are not exposed in Atlas.");
    return;
  }

  if (command === "once") {
    if (!(await ensureSingleTargetStartupReady(config))) {
      return;
    }
    const existingStopRequest = await readStopRequest(config);
    if (existingStopRequest?.requestedAt) {
      await clearStopRequest(config);
      console.log("[box once] cleared stale stop request before one-shot run");
    }
    await runOnce(config);
    return;
  }

  await runOnce(config);
}

main().catch((error) => {
  console.error("[atlas] fatal:", error?.message ?? error);
  process.exit(1);
});

