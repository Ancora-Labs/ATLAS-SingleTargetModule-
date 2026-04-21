import { loadPlatformModeState, PLATFORM_MODE } from "./mode_state.js";
import { loadActiveTargetSession } from "./target_session_state.js";

export async function evaluateSingleTargetStartupRequirements(config: any, options: { forceSingleTarget?: boolean } = {}) {
  const activeTargetSession = await loadActiveTargetSession(config).catch(() => null);
  const modeState = options.forceSingleTarget
    ? { currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY }
    : await loadPlatformModeState(config).catch(() => ({ currentMode: PLATFORM_MODE.SELF_DEV }));
  const singleTargetRequired = options.forceSingleTarget === true
    || String(modeState?.currentMode || "") === PLATFORM_MODE.SINGLE_TARGET_DELIVERY
    || Boolean(activeTargetSession);

  const githubClassicTokenPresent = Boolean(String(config?.env?.githubToken || "").trim());
  const githubFineGrainedTokenPresent = Boolean(String(config?.env?.copilotGithubToken || "").trim());
  const missing = [];

  if (singleTargetRequired && !githubClassicTokenPresent) {
    missing.push("GITHUB_TOKEN");
  }
  if (singleTargetRequired && !githubFineGrainedTokenPresent) {
    missing.push("COPILOT_GITHUB_TOKEN");
  }

  return {
    singleTargetRequired,
    ok: !singleTargetRequired || missing.length === 0,
    missing,
    githubClassicTokenPresent,
    githubFineGrainedTokenPresent,
    activeTargetSessionId: String(activeTargetSession?.sessionId || "").trim() || null,
    currentMode: String(modeState?.currentMode || PLATFORM_MODE.SELF_DEV),
  };
}

export function buildSingleTargetStartupGuardMessage(result: {
  singleTargetRequired: boolean;
  missing: string[];
}) {
  if (!result?.singleTargetRequired || !Array.isArray(result?.missing) || result.missing.length === 0) {
    return "single_target_delivery startup requirements satisfied.";
  }

  return [
    "[ATLAS][SINGLE_TARGET][BLOCKED] Single target mode requires GitHub credentials before startup can continue.",
    `Missing: ${result.missing.join(", ")}`,
    "Why this is required:",
    "- GITHUB_TOKEN is used for target-repo GitHub API operations and repository-scoped automation.",
    "- COPILOT_GITHUB_TOKEN is used for Copilot-powered target delivery and agent execution.",
    "How to fix:",
    "- Set GITHUB_TOKEN to your GitHub classic/repo-capable token.",
    "- Set COPILOT_GITHUB_TOKEN to your fine-grained/Copilot-capable GitHub token.",
    "- Then restart Atlas after the environment variables are available.",
    "Atlas will not auto-create or auto-fetch GitHub tokens, API keys, database credentials, or paid service secrets on your behalf.",
  ].join("\n");
}