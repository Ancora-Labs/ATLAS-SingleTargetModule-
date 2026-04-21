import { execSync, spawnSync } from "node:child_process";
import { toCopilotModelSlug } from "../../core/agent_loader.js";

const COPILOT_CLI_TIMEOUT_MS = (() => {
  const raw = Number(process.env.BOX_COPILOT_CLI_TIMEOUT_MS || "0");
  // 0 means no timeout — workers must be free to think as long as needed.
  // Set BOX_COPILOT_CLI_TIMEOUT_MS to a positive integer (ms) to enforce a cap.
  if (!Number.isFinite(raw) || raw < 0) {
    return 0;
  }
  return Math.floor(raw);
})();

function normalizeModelName(name: string | null | undefined): string {
  return String(name || "").trim();
}

function parseCsv(csv: string | null | undefined): string[] {
  return String(csv || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMultipliers(jsonText: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(jsonText || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parsePreferenceValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeModelName(item)).filter(Boolean);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return [];
    }
    if (text.includes(",")) {
      return text.split(",").map((item) => normalizeModelName(item)).filter(Boolean);
    }
    return [normalizeModelName(text)].filter(Boolean);
  }
  return [];
}

function modelCapabilityScore(modelName: string | null | undefined): number {
  const key = String(modelName || "").toLowerCase();
  const scored: [RegExp, number][] = [
    [/claude\s+opus/, 5.0],
    [/claude\s+sonnet/, 4.4],
    [/gpt-?5\.3\s*codex|gpt\s*5\.3\s*codex/, 4.1],
    [/gpt-?5\.2\s*codex|gpt\s*5\.2\s*codex/, 3.8],
    [/gpt-?5/, 3.6],
    [/claude\s+haiku/, 3.0],
    [/gpt-?4\.1|gpt\s*4\.1/, 3.0]
  ];
  for (const [pattern, score] of scored) {
    if (pattern.test(key)) {
      return score;
    }
  }
  return 3.4;
}

function estimateComplexityBand(taskTitle: string | null | undefined, taskKind: string | null | undefined): "high" | "medium" | "low" {
  const text = `${String(taskTitle || "")} ${String(taskKind || "")}`.toLowerCase();
  const highSignals = [
    "security", "incident", "critical", "architecture", "migration", "production", "outage", "auth", "data loss", "race condition"
  ];
  const lowSignals = [
    "docs", "readme", "format", "typo", "small", "lint", "rename", "comment"
  ];

  if (highSignals.some((signal) => text.includes(signal))) {
    return "high";
  }
  if (lowSignals.some((signal) => text.includes(signal))) {
    return "low";
  }
  return "medium";
}

function targetCapabilityForBand(band: "high" | "medium" | "low"): number {
  if (band === "high") {
    return 4.3;
  }
  if (band === "low") {
    return 3.6;
  }
  return 4.0;
}

function chooseDynamicCandidate(candidates: string[], targetCapability: number): string | null {
  if (candidates.length === 0) {
    return null;
  }

  const rankedAsc = candidates
    .map((model) => ({ model, score: modelCapabilityScore(model) }))
    .sort((a, b) => a.score - b.score);

  const atOrAbove = rankedAsc.filter((item) => item.score >= targetCapability);
  if (atOrAbove.length > 0) {
    // Pick the lightest model that still meets target capability.
    return atOrAbove[0].model;
  }

  return rankedAsc[rankedAsc.length - 1].model;
}

function shouldEscalateToOpus(taskTitle: string | null | undefined, taskKind: string | null | undefined, allowOpusEscalation: boolean, escalationKeywords: string[]): boolean {
  if (!allowOpusEscalation) {
    return false;
  }

  if (String(taskKind || "").toLowerCase() === "production") {
    return true;
  }

  const haystack = `${taskTitle || ""} ${taskKind || ""}`.toLowerCase();
  return escalationKeywords.some((keyword) => haystack.includes(String(keyword).toLowerCase()));
}

function commandSupportsModelFlag(command: string): boolean {
  try {
    const output = execSync(`${command} --help`, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).toString("utf8").toLowerCase();
    return output.includes("--model");
  } catch {
    return false;
  }
}

function commandUsesPromptMode(command: string): boolean {
  try {
    const output = execSync(`${command} --help`, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).toString("utf8").toLowerCase();
    return output.includes("--prompt") || output.includes("-p, --prompt");
  } catch {
    return false;
  }
}

interface GuardOptions {
  neverUseModels: string[];
  allowedModels: string[];
  multipliers: Record<string, unknown>;
  maxMultiplier: number | string;
  defaultModel: string;
  opusModel: string;
  allowOpusEscalation: boolean;
}

function enforceGuards(candidate: string, { neverUseModels, allowedModels, multipliers, maxMultiplier, defaultModel, opusModel, allowOpusEscalation }: GuardOptions): { model: string; forcedFallback: string | null } {
  const forbidden = neverUseModels.includes(candidate);
  if (forbidden) {
    return { model: defaultModel, forcedFallback: "never-use-list" };
  }

  const allowedByPolicy = allowedModels.length === 0 || allowedModels.includes(candidate);
  if (!allowedByPolicy) {
    return { model: defaultModel, forcedFallback: "policy-allowlist" };
  }

  const multiplier = Number(multipliers[candidate]);
  const exceeds = Number.isFinite(multiplier) && multiplier > Number(maxMultiplier || 1);
  if (exceeds) {
    // Opus is allowed to exceed max multiplier only during explicit escalation.
    const opusException = candidate === opusModel && allowOpusEscalation;
    if (!opusException) {
      return { model: defaultModel, forcedFallback: "multiplier-cap" };
    }
  }

  return { model: candidate, forcedFallback: null };
}

export function chooseCopilotModel({
  strategy,
  taskTitle,
  taskKind,
  roleName,
  defaultModel,
  preferredModelsByTaskKindJson,
  preferredModelsByRoleJson,
  opusModel,
  allowOpusEscalation,
  teamLeadAllowOpus,
  teamLeadReason,
  opusEscalationKeywordsCsv,
  neverUseModelsCsv,
  allowedModelsCsv,
  maxMultiplier,
  multipliersJson
}: {
  strategy?: string;
  taskTitle?: string;
  taskKind?: string;
  roleName?: string;
  defaultModel?: string;
  preferredModelsByTaskKindJson?: string;
  preferredModelsByRoleJson?: string;
  opusModel?: string;
  allowOpusEscalation?: boolean;
  teamLeadAllowOpus?: boolean;
  teamLeadReason?: string;
  opusEscalationKeywordsCsv?: string;
  neverUseModelsCsv?: string;
  allowedModelsCsv?: string;
  maxMultiplier?: number | string;
  multipliersJson?: string;
}): Record<string, unknown> {
  const targetStrategy = String(strategy || "task-best").toLowerCase();
  const preferredModels = parseMultipliers(preferredModelsByTaskKindJson);
  const preferredByRole = parseMultipliers(preferredModelsByRoleJson);
  const neverUseModels = parseCsv(neverUseModelsCsv);
  const allowedModels = parseCsv(allowedModelsCsv);
  const escalationKeywords = parseCsv(opusEscalationKeywordsCsv);
  const multipliers = parseMultipliers(multipliersJson);

  const normalizedDefault = normalizeModelName(defaultModel) || "gpt-5.3-codex";
  const normalizedTaskKind = String(taskKind || "general").toLowerCase();

  let selected = normalizedDefault;
  let escalationSource = null;
  if (targetStrategy === "task-best") {
    const normalizedRoleName = String(roleName || "").trim();
    const roleCandidates = parsePreferenceValue(preferredByRole[normalizedRoleName]);
    const kindCandidates = parsePreferenceValue(preferredModels[normalizedTaskKind]);
    const candidatePool = [...new Set([...roleCandidates, ...kindCandidates, normalizedDefault])];
    const complexityBand = estimateComplexityBand(taskTitle, normalizedTaskKind);
    const targetCapability = targetCapabilityForBand(complexityBand);
    const dynamicSelected = chooseDynamicCandidate(candidatePool, targetCapability);
    if (dynamicSelected) {
      selected = dynamicSelected;
    }

    if (teamLeadAllowOpus) {
      selected = normalizeModelName(opusModel) || "gpt-5.3-codex";
      escalationSource = "team-lead";
    }

    if (shouldEscalateToOpus(taskTitle, normalizedTaskKind, allowOpusEscalation, escalationKeywords)) {
      selected = normalizeModelName(opusModel) || "gpt-5.3-codex";
      escalationSource = escalationSource || "keyword";
    }
  }

  const guarded = enforceGuards(selected, {
    neverUseModels,
    allowedModels,
    multipliers,
    maxMultiplier,
    defaultModel: normalizedDefault,
    opusModel: normalizeModelName(opusModel) || "gpt-5.3-codex",
    allowOpusEscalation
  });

  return {
    mode: "task-best",
    strategy: targetStrategy,
    model: guarded.model,
    taskKind: normalizedTaskKind,
    forcedFallback: guarded.forcedFallback,
    usedOpus: String(guarded.model).toLowerCase().includes("opus"),
    escalationSource,
    escalationReason: escalationSource === "team-lead" ? String(teamLeadReason || "") : ""
  };
}

function runCopilotCli(command: string, args: string[]): { ok: boolean; status: number | null; stdout: string; stderr: string; error: string; timedOut: boolean } {
  const timeoutOption: any = COPILOT_CLI_TIMEOUT_MS > 0 ? { timeout: COPILOT_CLI_TIMEOUT_MS, killSignal: "SIGKILL" } : {};
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...timeoutOption,
    maxBuffer: 100 * 1024 * 1024,
    windowsHide: true
  });
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");

  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }

  return {
    ok: result.status === 0,
    status: result.status,
    stdout,
    stderr,
    error: result.error ? String((result.error as any).message || result.error) : "",
    timedOut: Boolean(result.error && String((result.error as any).code || "") === "ETIMEDOUT")
  };
}

function clipText(value: unknown, max = 1200): string {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildResponsePreview(result: { stdout?: string; stderr?: string; error?: string }): string {
  const stdout = String(result?.stdout || "").trim();
  const stderr = String(result?.stderr || "").trim();
  const error = String(result?.error || "").trim();
  const merged = [stdout, stderr, error].filter(Boolean).join("\n");
  return clipText(merged, 1800);
}

export function buildTaskPrompt({ taskTitle, taskKind }: { taskTitle: string; taskKind?: string }): string {
  return [
    "<role>",
    "You are a senior software engineer with 10+ years of professional experience, working inside an autonomous delivery runtime.",
    "You write production-quality code: correct, minimal, testable, and aligned with the existing codebase conventions.",
    "You think before you act — read the relevant code first, form a precise plan, then apply the smallest diff that satisfies the requirement.",
    "</role>",
    "<task>",
    `Task: ${taskTitle}.`,
    `Kind: ${taskKind || "general"}.`,
    "Deliver a concrete, working implementation. Do not stop at analysis or suggestions — apply the actual changes.",
    "</task>",
    "<engineering_standards>",
    "1. Correctness first: the change must be semantically correct and not break existing behavior.",
    "2. Minimal diff: touch only the files and lines required by this task.",
    "3. Preserve architecture: match the existing patterns, naming conventions, and module boundaries.",
    "4. No speculative changes: do not improve unrelated code, add unasked-for abstractions, or future-proof unnecessarily.",
    "5. Deterministic: avoid randomness, timing dependencies, or environment-specific assumptions.",
    "6. Reversible: prefer changes that can be safely reverted without cascading side effects.",
    "7. If the task is genuinely ambiguous or impossible given the codebase state, fail explicitly with a clear reason — do not guess.",
    "</engineering_standards>",
    "<allowed_actions>",
    "- Read and edit task-related source files.",
    "- Add or adjust targeted tests covering the changed behavior.",
    "- Run build, test, lint, and security checks as required by the repository.",
    "</allowed_actions>",
    "<forbidden_actions>",
    "- Do not modify CI, infrastructure, or deployment configuration unless this task explicitly requires it.",
    "- Do not perform broad refactors or cleanups unrelated to this task.",
    "- Do not introduce new dependencies without a clear necessity.",
    "- Do not invent new architectural patterns or abstractions beyond task scope.",
    "</forbidden_actions>",
    "<acceptance_criteria>",
    "1. Only task-related files are modified — no collateral changes.",
    "2. All required gates (build, tests, lint, security) pass for this repository.",
    "3. The implementation is production-safe, policy-compliant, and consistent with codebase conventions.",
    "4. No secrets, credentials, or environment-specific values are hardcoded.",
    "</acceptance_criteria>",
    "<output_format>",
    "Apply code edits directly. Provide concise implementation notes explaining non-obvious decisions only.",
    "</output_format>"
  ].join("\n");
}

export function runCopilotPrompt(command: string, prompt: string, modelDecision: Record<string, unknown>): Record<string, unknown> {
  const supportsModel = commandSupportsModelFlag(command);
  const usesPromptMode = commandUsesPromptMode(command);
  const requestedModel = toCopilotModelSlug(modelDecision.model);
  const baseArgs = usesPromptMode
    ? ["--allow-all-tools", "--prompt", String(prompt || "")]
    : ["code", "--prompt", String(prompt || "")];

  function throwFailure(result, mode) {
    const details = [
      `copilot invocation failed (${mode})`,
      `status=${result.status}`,
      `timedOut=${result.timedOut ? "true" : "false"}`,
      `stdout=${result.stdout || ""}`,
      `stderr=${result.stderr || ""}`,
      `error=${result.error || ""}`
    ].join("\n");
    throw new Error(details);
  }

  if (requestedModel && supportsModel) {
    const manual = runCopilotCli(command, [...baseArgs, "--model", requestedModel]);
    if (manual.ok) {
      return {
        ...modelDecision,
        invocation: "task-best-manual",
        responsePreview: buildResponsePreview(manual)
      };
    }

    const fallback = runCopilotCli(command, baseArgs);
    if (fallback.ok) {
      return {
        ...modelDecision,
        invocation: "auto-fallback",
        responsePreview: buildResponsePreview(fallback)
      };
    }

    throwFailure(fallback, "manual-then-auto-fallback");
  }

  if (modelDecision.model && !supportsModel) {
    const result = runCopilotCli(command, baseArgs);
    if (!result.ok) {
      throwFailure(result, "no-model-flag-fallback");
    }
    return {
      ...modelDecision,
      invocation: "no-model-flag-fallback",
      responsePreview: buildResponsePreview(result)
    };
  }

  const result = runCopilotCli(command, baseArgs);
  if (!result.ok) {
    throwFailure(result, "auto");
  }
  return {
    ...modelDecision,
    invocation: "auto",
    responsePreview: buildResponsePreview(result)
  };
}
