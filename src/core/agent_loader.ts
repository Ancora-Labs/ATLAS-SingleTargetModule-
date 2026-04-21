/**
 * Agent Loader ÔÇö Integrates .github/agents/*.agent.md with Copilot CLI
 *
 * Each AI role has a dedicated .agent.md file in .github/agents/.
 * These are standard VS Code Copilot custom agent files with YAML frontmatter.
 *
 * When calling the Copilot CLI, we pass --agent <slug> to load the agent's
 * persona, tools, and model preferences from that file.
 * The runtime data (GitHub state, sessions, etc.) is passed via -p <context>.
 *
 * Edit an agent's behavior by editing their .agent.md file ÔÇö no code changes needed.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isModelBanned } from "./model_policy.js";
import type { ModelCallSettingsOverlay } from "./model_policy.js";
import { getTargetSessionPath } from "./target_session_state.js";
import {
  buildPromptLineagePreamble,
  extractPromptLineageContractFromText,
  normalizePromptLineageContract,
  stripPromptLineageMarker,
} from "./prompt_compiler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENTS_DIR = path.join(__dirname, "..", "..", ".github", "agents");
const CRITICAL_AGENT_SLUGS = new Set(["prometheus", "athena"]);
const WRITER_TOOL_NAMES = new Set(["edit", "execute"]);
const SESSION_INPUT_POLICIES = new Set(["allow_all", "no_tools", "auto"]);
const HOOK_COVERAGE_MODES = new Set(["required", "not_required"]);

export type AgentSessionInputPolicy = "allow_all" | "no_tools" | "auto";
export type AgentHookCoverageMode = "required" | "not_required";

type AgentFrontmatterSnapshot = {
  filePath: string;
  raw: string | null;
  frontmatter: string | null;
};

function logBannedModelAttempt(model, reason) {
  try {
    const stateDir = path.join(__dirname, "..", "..", "state");
    const line = `[${new Date().toISOString()}] BANNED_MODEL_BLOCKED: model="${model}" reason="${reason}"\n`;
    appendFileSync(path.join(stateDir, "progress.txt"), line, "utf8");
  } catch { /* non-critical */ }
}

// ÔöÇÔöÇ Convert agent name to .agent.md file slug ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// "King David" ÔåÆ "king-david", "Trump" ÔåÆ "trump"

export function nameToSlug(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, "-");
}

// ÔöÇÔöÇ Check if .agent.md file exists for a slug ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

export function agentFileExists(slug) {
  return existsSync(path.join(AGENTS_DIR, `${slug}.agent.md`));
}

export function agentFileExistsForExecution(slug, executionCwd) {
  const normalizedSlug = String(slug || "").trim();
  if (!normalizedSlug) return false;
  const normalizedCwd = String(executionCwd || "").trim();
  if (!normalizedCwd) return agentFileExists(normalizedSlug);
  return existsSync(path.join(normalizedCwd, ".github", "agents", `${normalizedSlug}.agent.md`));
}

function readAgentFrontmatterSnapshot(slug: string): AgentFrontmatterSnapshot {
  const filePath = path.join(AGENTS_DIR, `${slug}.agent.md`);
  if (!existsSync(filePath)) {
    return { filePath, raw: null, frontmatter: null };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { filePath, raw: null, frontmatter: null };
  }

  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  return {
    filePath,
    raw,
    frontmatter: fmMatch ? fmMatch[1] : null,
  };
}

function extractFrontmatterField(frontmatter: string | null, key: string): string | undefined {
  if (!frontmatter) return undefined;
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function extractFrontmatterList(frontmatter: string | null, key: string): string[] | undefined {
  if (!frontmatter) return undefined;
  const inline = frontmatter.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
  if (inline) {
    return inline[1].split(",").map((item) => item.trim()).filter(Boolean);
  }
  const block = frontmatter.match(new RegExp(`^${key}:\\s*\\n((?:[ \\t]+-[ \\t]*.+\\n?)+)`, "m"));
  if (block) {
    return block[1].split("\n").map((line) => line.replace(/^[ \t]+-[ \t]*/, "").trim()).filter(Boolean);
  }
  return undefined;
}

function normalizeAgentToolNames(tools: string[] | undefined): string[] {
  return Array.from(new Set(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => String(tool || "").trim().toLowerCase())
      .filter(Boolean),
  ));
}

function normalizeSessionInputPolicy(value: unknown): AgentSessionInputPolicy | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (SESSION_INPUT_POLICIES.has(normalized)) {
    return normalized as AgentSessionInputPolicy;
  }
  return null;
}

function normalizeHookCoverageMode(value: unknown): AgentHookCoverageMode | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (HOOK_COVERAGE_MODES.has(normalized)) {
    return normalized as AgentHookCoverageMode;
  }
  return null;
}

function deriveSessionInputPolicyFromTools(tools: string[]): AgentSessionInputPolicy {
  return tools.some((tool) => WRITER_TOOL_NAMES.has(tool)) ? "allow_all" : "no_tools";
}

function deriveHookCoverageModeFromTools(tools: string[]): AgentHookCoverageMode {
  return tools.includes("execute") ? "required" : "not_required";
}

// ÔöÇÔöÇ Map model name to Copilot CLI model slug ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

export function toCopilotModelSlug(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key || key === "auto" || key === "default" || key === "system") {
    return "";
  }

  const map = {
    "claude sonnet 4.6": "claude-sonnet-4.6",
    "claude sonnet 4.5": "claude-sonnet-4.5",
    "claude sonnet 4": "claude-sonnet-4",
    "claude haiku 4.5": "claude-haiku-4.5",
    "claude opus 4.6": "claude-opus-4.6",
    // claude-opus-4.6-fast is BANNED ÔÇö 30x rate, never use
    "claude opus 4.5": "claude-opus-4.5",
    "gemini 3 pro preview": "gemini-3-pro-preview",
    "gpt-5.4": "gpt-5.4",
    "gpt 5.4": "gpt-5.4",
    "gpt-5.3-codex": "gpt-5.3-codex",
    "gpt 5.3 codex": "gpt-5.3-codex",
    "gpt-5.2-codex": "gpt-5.2-codex",
    "gpt 5.2 codex": "gpt-5.2-codex",
    "gpt-5.2": "gpt-5.2",
    "gpt 5.2": "gpt-5.2",
    "gpt 5.1 codex max": "gpt-5.1-codex-max",
    "gpt 5.1 codex": "gpt-5.1-codex",
    "gpt 5.1 codex mini": "gpt-5.1-codex-mini",
    "gpt 5.1": "gpt-5.1",
    "gpt 5 mini": "gpt-5-mini",
    "gpt 4.1": "gpt-4.1"
  };
  if (map[key]) return map[key];
  return key
    .replace(/[^a-z0-9.\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ÔöÇÔöÇ Build CLI args array for a Copilot agent call ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
//
// Usage:
//   const args = buildAgentArgs({ agentSlug: "janus", prompt: contextText, model: "claude-sonnet-4.6" });
//   spawnSync(copilotCommand, args, ...)
//
// If an .agent.md file exists for the slug, --agent <slug> is added and the
// agent's frontmatter model is used (unless overridden by model arg).
// If no agent file exists, falls back to plain --model + -p call.

// Windows limits total CLI argument length to ~32KB (CreateProcessW).
// For prompts >25KB, write to a temp file and pass a short -p telling the agent to read it.
const PROMPT_FILE_THRESHOLD = 25_000;
const STATE_DIR = path.join(__dirname, "..", "..", "state");

function normalizeAgentDebugSlug(value: unknown): string {
  return String(value || "agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "agent";
}

export function writeAgentDebugFile(config: any, input: {
  agentSlug: string;
  prompt?: unknown;
  result?: any;
  parsed?: any;
  session?: any;
  contextLabel?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const stateDir = config?.paths?.stateDir || STATE_DIR;
    const agentSlug = normalizeAgentDebugSlug(input?.agentSlug);
    const fileName = `debug_agent_${agentSlug}.txt`;
    const session = input?.session || null;
    const metadata = input?.metadata && typeof input.metadata === "object" ? input.metadata : {};
    const result = input?.result || {};
    const parsed = input?.parsed;
    const promptText = String(input?.prompt || "");
    const stdout = String(result?.stdout || "");
    const stderr = String(result?.stderr || "");
    const status = String(result?.status ?? "unknown");
    const contextLabel = String(input?.contextLabel || "agent_call").trim() || "agent_call";
    const targetHeader = session
      ? [
          `TARGET_PROJECT_ID: ${String(session?.projectId || "").trim()}`,
          `TARGET_SESSION_ID: ${String(session?.sessionId || "").trim()}`,
          `TARGET_REPO_URL: ${String(session?.repo?.repoUrl || "").trim()}`,
          `TARGET_REPO_FULL_NAME: ${String(session?.repo?.repoFullName || "").trim()}`,
          `TARGET_WORKSPACE_PATH: ${String(session?.workspace?.path || "").trim()}`,
        ].filter((line) => !/:\s*$/.test(line)).join("\n")
      : "";
    const metadataLines = Object.entries(metadata)
      .map(([key, value]) => `${String(key).toUpperCase()}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    const content = [
      `AGENT: ${agentSlug}`,
      `CONTEXT: ${contextLabel}`,
      `RECORDED_AT: ${new Date().toISOString()}`,
      `STATUS: ${status}`,
      ...metadataLines,
      targetHeader,
      "",
      "PROMPT:",
      promptText,
      "",
      "STDOUT:",
      stdout,
      "",
      "STDERR:",
      stderr,
      "",
      "PARSED:",
      parsed == null ? "null" : JSON.stringify(parsed, null, 2),
      "",
    ].join("\n");

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, fileName), content, "utf8");

    if (session?.projectId && session?.sessionId) {
      const evidenceDir = path.join(
        getTargetSessionPath(stateDir, String(session.projectId), String(session.sessionId)),
        "agent_evidence",
      );
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(path.join(evidenceDir, fileName), content, "utf8");
    }
  } catch {
    /* non-critical */
  }
}

function resolveAgentLiveModeLabel(config: any, session: any) {
  const fromConfig = String(config?.platformModeState?.currentMode || "").trim();
  if (fromConfig === "single_target_delivery") return "target";
  if (fromConfig === "self_dev") return "self";
  if (session?.projectId && session?.sessionId) return "target";
  return "self";
}

export function appendAgentLiveLog(config: any, input: {
  agentSlug: string;
  session?: any;
  contextLabel?: string;
  status?: unknown;
  message: unknown;
}) {
  try {
    const stateDir = config?.paths?.stateDir || STATE_DIR;
    const agentSlug = normalizeAgentDebugSlug(input?.agentSlug);
    const session = input?.session || null;
    const message = String(input?.message || "").trimEnd();
    if (!message.trim()) return;
    const mode = resolveAgentLiveModeLabel(config, session);
    const line = `${message} [mode=${mode}]\n`;

    mkdirSync(stateDir, { recursive: true });
    appendFileSync(path.join(stateDir, `live_agent_${agentSlug}.log`), line, "utf8");
    appendFileSync(path.join(stateDir, "live_agents.log"), `[${agentSlug}] ${message} [mode=${mode}]\n`, "utf8");

    if (session?.projectId && session?.sessionId) {
      const evidenceDir = path.join(
        getTargetSessionPath(stateDir, String(session.projectId), String(session.sessionId)),
        "agent_evidence",
      );
      mkdirSync(evidenceDir, { recursive: true });
      appendFileSync(path.join(evidenceDir, `live_agent_${agentSlug}.log`), line, "utf8");
    }
  } catch {
    /* non-critical */
  }
}

export function appendAgentLiveLogDetail(config: any, input: {
  agentSlug: string;
  session?: any;
  contextLabel?: string;
  stage?: unknown;
  title?: unknown;
  content?: unknown;
}) {
  try {
    const stateDir = config?.paths?.stateDir || STATE_DIR;
    const agentSlug = normalizeAgentDebugSlug(input?.agentSlug);
    const session = input?.session || null;
    const stage = String(input?.stage || "detail").trim() || "detail";
    const title = String(input?.title || stage).trim() || stage;
    const content = String(input?.content || "");
    if (!content.trim()) return;
    const mode = resolveAgentLiveModeLabel(config, session);

    const header = [
      "",
      `${"=".repeat(72)}`,
      `${title} [mode=${mode}]`,
      `${"=".repeat(72)}`,
      content.endsWith("\n") ? content.slice(0, -1) : content,
      "",
    ].join("\n");

    mkdirSync(stateDir, { recursive: true });
    appendFileSync(path.join(stateDir, `live_agent_${agentSlug}.log`), `${header}\n`, "utf8");
    appendFileSync(path.join(stateDir, "live_agents.log"), `[${agentSlug}] ${header}\n`, "utf8");

    if (session?.projectId && session?.sessionId) {
      const evidenceDir = path.join(
        getTargetSessionPath(stateDir, String(session.projectId), String(session.sessionId)),
        "agent_evidence",
      );
      mkdirSync(evidenceDir, { recursive: true });
      appendFileSync(path.join(evidenceDir, `live_agent_${agentSlug}.log`), `${header}\n`, "utf8");
    }
  } catch {
    /* non-critical */
  }
}

export function buildAgentArgs({
  agentSlug,
  prompt,
  model,
  allowAll = false,
  autopilot = false,
  noAskUser = false,
  silent = false,
  maxContinues = undefined,
  runContract = undefined,
  modelCallSettings = undefined,
}: any = {}) {
  const args = [];
  const normalizedModelCallSettings: ModelCallSettingsOverlay =
    modelCallSettings && typeof modelCallSettings === "object" ? modelCallSettings : {};
  const executionCwd = String(runContract?.executionCwd || "").trim();
  const agentAvailableForExecution = agentSlug
    ? agentFileExistsForExecution(agentSlug, executionCwd)
    : false;
  const agentProfile = agentSlug && agentFileExists(agentSlug)
    ? resolveAgentExecutionProfile(agentSlug)
    : null;
  const effectiveSessionInputPolicy = resolveAgentSessionInputPolicy(
    agentProfile,
    runContract?.sessionInputPolicy ?? (allowAll ? "allow_all" : "auto"),
  );
  const allowAllRequested = allowAll || effectiveSessionInputPolicy === "allow_all";
  const effectiveNoAskUser = noAskUser || normalizedModelCallSettings.noAskUser === true;
  const effectiveSilent = silent || normalizedModelCallSettings.silent === true;
  const effectiveModel = normalizedModelCallSettings.model || model;

  const pushResolvedModelArg = (requestedModel) => {
    if (!requestedModel) return;
    const banCheck = isModelBanned(requestedModel);
    if (banCheck.banned) {
      // HARD BLOCK: never pass a banned model to Copilot CLI
      const safe = toCopilotModelSlug("Claude Sonnet 4.6");
      if (safe) args.push("--model", safe);
      logBannedModelAttempt(requestedModel, banCheck.reason);
      return;
    }
    const slug = toCopilotModelSlug(requestedModel);
    if (slug) args.push("--model", slug);
  };

  if (effectiveSessionInputPolicy === "allow_all") args.push("--allow-all");
  if (effectiveNoAskUser || allowAllRequested) args.push("--no-ask-user");
  if (autopilot) {
    args.push("--autopilot");
    // runContract.maxTurns takes precedence over the legacy maxContinues arg.
    const effectiveMaxContinues = runContract?.maxTurns ?? maxContinues;
    if (effectiveMaxContinues != null) args.push("--max-autopilot-continues", String(effectiveMaxContinues));
  }
  if (effectiveSilent) args.push("--silent");

  if (agentSlug && agentAvailableForExecution) {
    args.push("--agent", agentSlug);
    // Force explicit model even with custom agent to avoid default-model fallback.
    pushResolvedModelArg(effectiveModel);
  } else if (effectiveModel) {
    // No agent file — explicit model only.
    pushResolvedModelArg(effectiveModel);
  }

  let promptText = String(prompt);
  const useDensePromptMode = String(process.env.BOX_PROMPT_DENSIFY_MODE || "").toLowerCase() === "true";
  if (useDensePromptMode) {
    promptText = `\n[DENSIFIED_PROMPT_MODE]\nPrioritize dense, high-leverage bundled work packets over thin micro-tasks.\n${promptText}`;
  }
  const embeddedPromptLineage = extractPromptLineageContractFromText(promptText);
  const runContractPromptLineage = runContract?.promptLineage && typeof runContract.promptLineage === "object"
    ? normalizePromptLineageContract(runContract.promptLineage)
    : null;
  const resolvedPromptLineage = runContractPromptLineage || embeddedPromptLineage;
  let lineagePreamble = "";
  if (resolvedPromptLineage && (resolvedPromptLineage.promptFamilyKey || resolvedPromptLineage.lineageId)) {
    lineagePreamble = buildPromptLineagePreamble(resolvedPromptLineage);
    promptText = `${lineagePreamble}\n\n${stripPromptLineageMarker(promptText)}`;
  }
  if (promptText.length > PROMPT_FILE_THRESHOLD) {
    const slug = agentSlug || "agent";
    const promptFile = path.join(STATE_DIR, `prompt_${slug}_${Date.now()}.md`);
    writeFileSync(promptFile, promptText, "utf8");
    pruneOldPromptFiles(slug);
    promptText = `${lineagePreamble ? `${lineagePreamble}\n\n` : ""}Your full instructions are in the file: ${promptFile}\nRead that file NOW with your read_file / view tool, then follow every instruction in it.`;
  }
  args.push("-p", promptText);
  return args;
}

// ÔöÇÔöÇ Read agent persona text from .agent.md (strips YAML frontmatter) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

export function readAgentPersona(slug) {
  const filePath = path.join(AGENTS_DIR, `${slug}.agent.md`);
  if (!existsSync(filePath)) return "";
  const raw = readFileSync(filePath, "utf8");
  // Strip YAML frontmatter (--- ... ---)
  const stripped = raw.replace(/^---[\s\S]*?---\s*/, "");
  return stripped.trim();
}

// ÔöÇÔöÇ Build CLI args for single-prompt worker calls (no autopilot/tools) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
//
// Workers get ONE request: --model + -p with persona embedded in prompt.
// No --agent, no --autopilot, no --allow-all, no tool calls.
// The worker must output everything in a single response.

export function buildWorkerPromptArgs({ agentSlug, prompt, model }) {
  const args = [];

  // Resolve model
  const banCheck = isModelBanned(model || "");
  if (banCheck.banned) {
    const safe = toCopilotModelSlug("Claude Sonnet 4.6");
    if (safe) args.push("--model", safe);
    logBannedModelAttempt(model, banCheck.reason);
  } else {
    const slug = toCopilotModelSlug(model || "Claude Sonnet 4.6");
    if (slug) args.push("--model", slug);
  }

  // Embed persona from .agent.md into prompt
  const persona = agentSlug ? readAgentPersona(agentSlug) : "";
  let fullPrompt = persona
    ? `## YOUR ROLE\n${persona}\n\n${String(prompt)}`
    : String(prompt);

  if (fullPrompt.length > PROMPT_FILE_THRESHOLD) {
    const slug = agentSlug || "worker";
    const promptFile = path.join(STATE_DIR, `prompt_${slug}_${Date.now()}.md`);
    writeFileSync(promptFile, fullPrompt, "utf8");
    pruneOldPromptFiles(slug);
    fullPrompt = `Your full instructions are in the file: ${promptFile}\nRead that file NOW, then follow every instruction in it.`;
  }
  args.push("-p", fullPrompt);
  return args;
}

// pruneOldPromptFiles — keep only the last `maxKeep` prompt files for a slug.
// Called immediately after writing each new prompt file so state/ stays clean.
function pruneOldPromptFiles(slug: string, maxKeep = 3): void {
  try {
    const prefix = `prompt_${slug}_`;
    const files = readdirSync(STATE_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith(".md"))
      .sort(); // timestamps embedded in name → lexicographic = chronological
    const toDelete = files.slice(0, Math.max(0, files.length - maxKeep));
    for (const f of toDelete) {
      try { unlinkSync(path.join(STATE_DIR, f)); } catch { /* best-effort */ }
    }
  } catch { /* non-fatal */ }
}

// cleanupPromptFile — deletes a specific prompt file after the agent has read it.
export function cleanupPromptFile(filePath: string): void {
  try { if (filePath && existsSync(filePath)) unlinkSync(filePath); } catch { /* best-effort */ }
}

// ÔöÇÔöÇ Parse agent output: extract thinking + structured JSON ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
//
// Agents write freely, then end with one of two marker formats:
//
//   English (preferred):      Legacy Turkish (backward compat):
//   ===DECISION===            ===KARAR===
//   { json }                  { json }
//   ===END===                 ===SON===
//
// The section BEFORE the marker is the agent's visible thinking.
// The section INSIDE is parsed as structured JSON.
// Falls back to finding any JSON anywhere in the output.

export function parseAgentOutput(raw) {
  const text = String(raw || "");

  // Try ===DECISION=== / ===END=== markers (English format)
  // Use lastIndexOf so that tool-output echoes of the marker (e.g. grep patterns
  // containing "===DECISION===") do not shadow the agent's actual final block.
  const decisionIdx = text.lastIndexOf("===DECISION===");
  if (decisionIdx >= 0) {
    const afterDecision = text.slice(decisionIdx + "===DECISION===".length);
    const endIdx = afterDecision.indexOf("===END===");
    if (endIdx >= 0) {
      const jsonStr = afterDecision.slice(0, endIdx).trim();
      const parsed = tryParseJson(jsonStr);
      if (parsed) {
        const thinking = text.slice(0, decisionIdx).trim();
        return { thinking, parsed, ok: true };
      }
    }
  }

  // Try ===KARAR=== / ===SON=== markers (legacy Turkish format — backward compat)
  const kararIdx = text.lastIndexOf("===KARAR===");
  if (kararIdx >= 0) {
    const afterKarar = text.slice(kararIdx + "===KARAR===".length);
    const sonIdx = afterKarar.indexOf("===SON===");
    if (sonIdx >= 0) {
      const jsonStr = afterKarar.slice(0, sonIdx).trim();
      const parsed = tryParseJson(jsonStr);
      if (parsed) {
        const thinking = text.slice(0, kararIdx).trim();
        return { thinking, parsed, ok: true };
      }
    }
  }

  // Try ```json fenced blocks
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const splitIdx = text.indexOf("```json");
    const thinking = text.slice(0, splitIdx).trim();
    const parsed = tryParseJson(fenceMatch[1].trim());
    return { thinking, parsed, ok: !!parsed };
  }

  // Fall back: find JSON object anywhere, everything before it is thinking
  const jsonStart = text.search(/\{/);
  const thinking = jsonStart > 20 ? text.slice(0, jsonStart).trim() : "";
  const parsed = tryParseJson(text);
  return { thinking, parsed, ok: !!parsed };
}

// ÔöÇÔöÇ Internal JSON parser (handles raw, fenced, deep-nested) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

function tryParseJson(text) {
  const s = String(text || "");
  try {
    return JSON.parse(s);
  } catch {
    // fall through to fenced/deep parse attempts
  }
  const fenceMatch = s.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // try additional extraction strategies below
    }
  }
  const anyFence = s.match(/```\s*([\s\S]*?)```/);
  if (anyFence) {
    try {
      return JSON.parse(anyFence[1].trim());
    } catch {
      // try additional extraction strategies below
    }
  }
  // Find last top-level JSON object
  let lastCandidate = null;
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "{") { i++; continue; }
    let depth = 0, inString = false, escape = false;
    const start = i;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { lastCandidate = s.slice(start, i + 1); i++; break; } }
    }
  }
  if (lastCandidate) {
    try {
      return JSON.parse(lastCandidate);
    } catch {
      // return null when all parse strategies fail
    }
  }
  return null;
}

// ─── Agent contract validation ────────────────────────────────────────────────
//
// Validates that every .agent.md file has the required YAML frontmatter fields.
// Used by doctor checks and the cloud-agent governance gate.

/**
 * YAML frontmatter fields required in every .agent.md file that BOX dispatches.
 * - description: mandatory per GitHub custom-agent spec
 * - model:       mandatory for deterministic model selection (no implicit fallback)
 * - tools:       mandatory so the governance gate can verify the tool surface
 */
export interface AgentContractValidation {
  slug: string;
  filePath: string;
  valid: boolean;
  violations: string[];
  fields: {
    name?: string;
    description?: string;
    model?: string;
    tools?: string[];
    boxSessionInputPolicy?: AgentSessionInputPolicy;
    boxHookCoverage?: AgentHookCoverageMode;
  };
}

export interface AgentExecutionProfile {
  slug: string;
  filePath: string;
  valid: boolean;
  violations: string[];
  tools: string[];
  sessionInputPolicy: AgentSessionInputPolicy;
  hookCoverage: AgentHookCoverageMode;
  source: "explicit" | "derived";
  allowsExecute: boolean;
  allowsWrites: boolean;
}

/**
 * Validate a single agent's .agent.md frontmatter contract.
 * Uses regex extraction (no YAML parser dep) for deterministic behavior.
 */
export function validateAgentContract(slug: string): AgentContractValidation {
  const frontmatterSnapshot = readAgentFrontmatterSnapshot(slug);
  const result: AgentContractValidation = {
    slug,
    filePath: frontmatterSnapshot.filePath,
    valid: false,
    violations: [],
    fields: {},
  };

  if (!existsSync(frontmatterSnapshot.filePath)) {
    result.violations.push("file_missing");
    return result;
  }

  if (frontmatterSnapshot.raw == null) {
    result.violations.push("file_unreadable");
    return result;
  }

  if (!frontmatterSnapshot.frontmatter) {
    result.violations.push("frontmatter_missing");
    return result;
  }

  const tools = normalizeAgentToolNames(extractFrontmatterList(frontmatterSnapshot.frontmatter, "tools"));
  const sessionInputPolicyRaw = extractFrontmatterField(frontmatterSnapshot.frontmatter, "box_session_input_policy");
  const hookCoverageRaw = extractFrontmatterField(frontmatterSnapshot.frontmatter, "box_hook_coverage");
  const sessionInputPolicy = normalizeSessionInputPolicy(sessionInputPolicyRaw);
  const hookCoverage = normalizeHookCoverageMode(hookCoverageRaw);

  result.fields.name = extractFrontmatterField(frontmatterSnapshot.frontmatter, "name");
  result.fields.description = extractFrontmatterField(frontmatterSnapshot.frontmatter, "description");
  result.fields.model = extractFrontmatterField(frontmatterSnapshot.frontmatter, "model");
  result.fields.tools = tools;
  result.fields.boxSessionInputPolicy = sessionInputPolicy ?? undefined;
  result.fields.boxHookCoverage = hookCoverage ?? undefined;

  if (!result.fields.description) result.violations.push("description_missing");
  if (!result.fields.model) result.violations.push("model_missing");
  if (tools.length === 0) result.violations.push("tools_missing");

  if (CRITICAL_AGENT_SLUGS.has(slug)) {
    if (!sessionInputPolicyRaw) result.violations.push("session_input_policy_missing");
    if (!hookCoverageRaw) result.violations.push("hook_coverage_missing");
  }

  if (sessionInputPolicyRaw && !sessionInputPolicy) {
    result.violations.push("session_input_policy_invalid");
  }
  if (hookCoverageRaw && !hookCoverage) {
    result.violations.push("hook_coverage_invalid");
  }
  if (sessionInputPolicy === "no_tools" && tools.some((tool) => WRITER_TOOL_NAMES.has(tool))) {
    result.violations.push("session_input_policy_mismatch");
  }
  if (hookCoverage === "not_required" && tools.includes("execute")) {
    result.violations.push("hook_coverage_mismatch");
  }

  result.valid = result.violations.length === 0;
  return result;
}

export function resolveAgentExecutionProfile(slug: string): AgentExecutionProfile {
  const validation = validateAgentContract(slug);
  const tools = normalizeAgentToolNames(validation.fields.tools);
  const explicitSessionInputPolicy = normalizeSessionInputPolicy(validation.fields.boxSessionInputPolicy);
  const explicitHookCoverage = normalizeHookCoverageMode(validation.fields.boxHookCoverage);
  const sessionInputPolicy = explicitSessionInputPolicy ?? deriveSessionInputPolicyFromTools(tools);
  const hookCoverage = explicitHookCoverage ?? deriveHookCoverageModeFromTools(tools);
  const usesExplicitProfile = Boolean(explicitSessionInputPolicy || explicitHookCoverage);

  return {
    slug,
    filePath: validation.filePath,
    valid: validation.valid,
    violations: [...validation.violations],
    tools,
    sessionInputPolicy,
    hookCoverage,
    source: usesExplicitProfile ? "explicit" : "derived",
    allowsExecute: tools.includes("execute"),
    allowsWrites: tools.some((tool) => WRITER_TOOL_NAMES.has(tool)),
  };
}

export function resolveAgentSessionInputPolicy(
  profile: Pick<AgentExecutionProfile, "sessionInputPolicy" | "tools" | "allowsWrites"> | null,
  requestedPolicy: unknown,
): AgentSessionInputPolicy {
  const requested = normalizeSessionInputPolicy(requestedPolicy) ?? "auto";
  if (!profile) {
    return requested === "auto" ? "no_tools" : requested;
  }
  if (requested === "no_tools") return "no_tools";
  if (profile.sessionInputPolicy === "no_tools") return "no_tools";
  if (requested === "allow_all") {
    return profile.sessionInputPolicy === "allow_all" || profile.allowsWrites ? "allow_all" : "no_tools";
  }
  if (profile.sessionInputPolicy !== "auto") return profile.sessionInputPolicy;
  return deriveSessionInputPolicyFromTools(normalizeAgentToolNames(profile.tools));
}

/**
 * Validate all .agent.md files found in the agents directory.
 * Returns per-agent results plus a summary.
 */
export function validateAllAgentContracts(): {
  allValid: boolean;
  results: AgentContractValidation[];
  violations: AgentContractValidation[];
} {
  let slugs: string[];
  try {
    slugs = readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith(".agent.md"))
      .map(f => f.replace(/\.agent\.md$/, ""));
  } catch {
    // Agents dir unreadable — treat as valid to avoid blocking on infra failures
    return { allValid: true, results: [], violations: [] };
  }
  const results = slugs.map(validateAgentContract);
  const violations = results.filter(r => !r.valid);
  return { allValid: violations.length === 0, results, violations };
}

export function validateRequiredAgentContracts(slugs: string[]): {
  allValid: boolean;
  results: AgentContractValidation[];
  violations: AgentContractValidation[];
} {
  const normalizedSlugs = Array.from(new Set(
    (Array.isArray(slugs) ? slugs : [])
      .map((slug) => String(slug || "").trim())
      .filter(Boolean),
  ));
  const results = normalizedSlugs.map(validateAgentContract);
  const violations = results.filter((result) => !result.valid);
  return { allValid: violations.length === 0, results, violations };
}

/**
 * Validate only the agents critical to the planning dispatch pipeline.
 * Prometheus and Athena are the minimum required; if either is invalid,
 * the governance gate should block dispatch.
 */
export function validateCriticalAgentContracts(): {
  allValid: boolean;
  results: AgentContractValidation[];
  violations: AgentContractValidation[];
} {
  const criticalSlugs = ["prometheus", "athena"];
  return validateRequiredAgentContracts(criticalSlugs);
}

// ─── Log agent thinking to a visible file ─────────────────────────────────────

export function logAgentThinking(stateDir, agentName, thinking) {
  if (!thinking || thinking.length < 10) return;
  try {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const separator = `\n${"ÔöÇ".repeat(60)}\n[${ts}] ${agentName} ÔÇö D├£┼Ş├£NCE\n${"ÔöÇ".repeat(60)}\n`;
    appendFileSync(
      path.join(stateDir, "leadership_thinking.txt"),
      `${separator}${thinking}\n`,
      "utf8"
    );
  } catch { /* non-critical */ }
}

