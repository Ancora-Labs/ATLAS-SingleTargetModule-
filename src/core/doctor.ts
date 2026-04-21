import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { info, warn } from "./logger.js";
import { validateCriticalAgentContracts } from "./agent_loader.js";

function check(command: string): boolean {
  try {
    execSync(command, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export interface CopilotAuthInputs {
  copilotToken: string | null | undefined;
  ghAuthActive: boolean;
  ghActiveAccount: string | null;
}

export interface CopilotAuthClassification {
  ready: boolean;
  source: "env" | "gh_auth" | "none";
  tokenType: "github_pat" | "ghp" | "gh_auth" | "none";
}

export interface CopilotAuthProbeRecord {
  schemaVersion?: number;
  checkedAt: string;
  ok: boolean;
  fingerprint: string;
  cliPath: string;
  source?: string;
  tokenType?: string;
  message?: string;
}

/**
 * Classify copilot auth inputs to determine auth strategy and readiness.
 *
 * - github_pat_ tokens are natively supported by the Copilot API.
 * - ghp_ (classic PAT) tokens override gh auth but lack Copilot scope — not ready.
 * - When no token is set, gh CLI auth is used as fallback when active.
 */
export function classifyCopilotAuthInputs(inputs: CopilotAuthInputs): CopilotAuthClassification {
  const token = inputs.copilotToken || "";
  if (token.startsWith("github_pat_")) {
    return { ready: true, source: "env", tokenType: "github_pat" };
  }
  if (token.startsWith("ghp_")) {
    // Classic ghp tokens override gh auth but do not support the Copilot API.
    return { ready: false, source: "env", tokenType: "ghp" };
  }
  if (token) {
    return { ready: false, source: "env", tokenType: "none" };
  }
  if (inputs.ghAuthActive && inputs.ghActiveAccount) {
    return { ready: true, source: "gh_auth", tokenType: "gh_auth" };
  }
  return { ready: false, source: "none", tokenType: "none" };
}

/**
 * Build a deterministic fingerprint for copilot auth inputs.
 * Used to invalidate cached auth probe results when inputs change.
 */
export function buildCopilotAuthFingerprint(inputs: CopilotAuthInputs): string {
  const token = inputs.copilotToken || "";
  const ghAuth = inputs.ghAuthActive ? "1" : "0";
  const account = inputs.ghActiveAccount || "";
  return `${token}|${ghAuth}|${account}`;
}

/**
 * Determine whether a cached copilot auth probe result is still valid.
 * Returns true only when probe.ok is true, the fingerprint matches, and the CLI path matches.
 */
export function shouldReuseCopilotAuthProbe(
  probe: CopilotAuthProbeRecord,
  fingerprint: string,
  cliPath: string,
): boolean {
  return probe.ok === true && probe.fingerprint === fingerprint && probe.cliPath === cliPath;
}

/**
 * Run preflight capability checks before a cycle starts.
 * Returns a structured result so the orchestrator can decide whether to proceed.
 *
 * @param {object} config
 * @returns {Promise<{ ok: boolean, checks: Record<string, boolean>, warnings: string[] }>}
 */
export async function runDoctor(config: any) {
  const warnings: string[] = [];
  const stateDir = config?.paths?.stateDir || "state";
  const copilotCliCommand: string = config.env?.copilotCliCommand || "copilot";
  const copilotToken: string = config.env?.copilotGithubToken || "";

  const checks: Record<string, boolean> = {
    node: check("node --version"),
    docker: check("docker --version"),
    githubToken: Boolean(config.env?.githubToken),
    targetRepo: Boolean(config.env?.targetRepo),
    stateDir: existsSync(stateDir),
    copilotCli: check(`${copilotCliCommand} --version`),
    gitAvailable: check("git --version"),
    agentContracts: true, // initialised optimistic; set below
    copilotAuth: false,   // set below
  };

  // ── Copilot auth check ─────────────────────────────────────────────────────
  // When a token is provided, fingerprint based on token only (gh CLI state is
  // irrelevant — the token is the credential).  When no token, gh CLI auth is
  // the fallback credential, so its state is included in the fingerprint.
  try {
    const ghAuthActive = !copilotToken && check("gh auth status");
    const inputs: CopilotAuthInputs = {
      copilotToken,
      ghAuthActive: Boolean(ghAuthActive),
      ghActiveAccount: null,
    };
    const fingerprint = buildCopilotAuthFingerprint(inputs);
    const probePath = path.join(stateDir, "copilot_auth_probe.json");

    let probeUsed = false;
    if (existsSync(probePath)) {
      try {
        const probeRaw = await fs.readFile(probePath, "utf8");
        const probe = JSON.parse(probeRaw) as CopilotAuthProbeRecord;
        if (shouldReuseCopilotAuthProbe(probe, fingerprint, copilotCliCommand)) {
          checks.copilotAuth = probe.ok;
          probeUsed = true;
        }
      } catch {
        // Probe file is unreadable or malformed; fall through to classification.
      }
    }

    if (!probeUsed) {
      checks.copilotAuth = classifyCopilotAuthInputs(inputs).ready;
    }
  } catch (err) {
    checks.copilotAuth = false;
    warnings.push(`Copilot auth check failed: ${String((err as Error)?.message || err)}`);
  }

  // ── Agent contract validation ──────────────────────────────────────────────
  // Validate prometheus and athena have required frontmatter fields.
  // Non-fatal at doctor level: the governance gate enforces the hard block.
  try {
    const agentValidation = validateCriticalAgentContracts();
    checks.agentContracts = agentValidation.allValid;
    if (!agentValidation.allValid) {
      const details = agentValidation.violations
        .map((v: any) => `${v.slug}: [${v.violations.join(", ")}]`)
        .join("; ");
      warnings.push(`Agent contract violations detected: ${details}`);
    }
  } catch (err) {
    checks.agentContracts = false;
    warnings.push(`Agent contract check failed: ${String((err as Error)?.message || err)}`);
  }

  info("doctor checks", checks);

  if (!checks.githubToken || !checks.targetRepo) {
    warnings.push("GitHub integration not ready: set GITHUB_TOKEN and TARGET_REPO in .env");
  }
  if (!checks.stateDir) {
    warnings.push(`State directory "${stateDir}" does not exist`);
  }
  if (!checks.copilotCli) {
    warnings.push("Copilot CLI not found — AI agent calls will fail");
  }
  if (!checks.gitAvailable) {
    warnings.push("Git not available — source control operations will fail");
  }

  for (const w of warnings) warn(w);

  // ok is the conjunction of all critical checks. copilotCli, gitAvailable, and
  // copilotAuth are now included so that the preflight gate accurately reflects
  // the full capability surface required for a successful cycle.
  const ok = checks.node
    && checks.githubToken
    && checks.targetRepo
    && checks.stateDir
    && checks.agentContracts
    && checks.copilotCli
    && checks.gitAvailable
    && checks.copilotAuth;
  return { ok, checks, warnings };
}
