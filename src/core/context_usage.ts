import { estimateTokens } from "./prompt_compiler.js";
import { appendProgress } from "./state_tracker.js";

const DEFAULT_MODEL_CONTEXT_LIMIT = 128000;

const KNOWN_MODEL_LIMITS: Record<string, number> = {
  "claude-sonnet-4.6": 160000,
  "claude sonnet 4.6": 160000,
  "gpt-5.3-codex": 400000,
  "gpt 5.3 codex": 400000,
};

function normalizeModelKey(modelName: string): string {
  return String(modelName || "").trim().toLowerCase();
}

function getConfiguredModelLimit(config: any, modelName: string): number | null {
  const lower = normalizeModelKey(modelName);
  const configured = config?.runtime?.modelContextLimits;
  if (!configured || typeof configured !== "object") return null;

  for (const [key, value] of Object.entries(configured)) {
    if (normalizeModelKey(key) !== lower) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function getModelContextLimit(config: any, modelName: string): number {
  const configured = getConfiguredModelLimit(config, modelName);
  if (configured && configured > 0) return configured;

  const direct = KNOWN_MODEL_LIMITS[normalizeModelKey(modelName)];
  if (Number.isFinite(direct) && direct > 0) return direct;

  return DEFAULT_MODEL_CONTEXT_LIMIT;
}

export function resolveMaxPromptBudget(config: any, modelName: string, explicitBudget?: number): number {
  const direct = Number(explicitBudget);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);

  if (config?.runtime?.maxCapacityMode !== true) return 0;
  const limit = getModelContextLimit(config, modelName);
  return Math.max(1000, limit);
}

export function saturatePromptToBudget(
  promptText: string,
  targetTokens: number,
  label = "global",
): string {
  void label;
  const target = Number.isFinite(Number(targetTokens)) ? Math.floor(Number(targetTokens)) : 0;
  if (target <= 0) return String(promptText || "");

  const targetChars = target * 4;
  const out = String(promptText || "").trim();
  if (out.length <= targetChars) return out;
  return out.slice(0, targetChars);
}

type AgentContextLogInput = {
  agent: string;
  model: string;
  promptText: string;
  status: "success" | "failed";
  note?: string;
};

export async function appendAgentContextUsage(config: any, input: AgentContextLogInput): Promise<void> {
  const used = estimateTokens(input.promptText || "");
  const limit = getModelContextLimit(config, input.model);
  const pct = limit > 0 ? ((used / limit) * 100).toFixed(1) : "0.0";
  const suffix = input.note ? ` ${input.note}` : "";
  await appendProgress(
    config,
    `[CONTEXT_USAGE] agent=${input.agent} model=${input.model} used=${used}/${limit} (${pct}%) status=${input.status}${suffix}`
  );
}

// ── Cache-segment telemetry ────────────────────────────────────────────────────

/** Input for cache-segment utilisation logging. */
export type CacheSegmentLogInput = {
  agent: string;
  model: string;
  /** Number of sections marked cacheable in the assembled prompt. */
  cachedSegments: number;
  /** Total number of sections in the assembled prompt. */
  totalSegments: number;
  /** Estimated tokens saved by reusing cached prefix (0 when cache was cold). */
  estimatedSavedTokens: number;
};

/**
 * Append a cache-segment utilisation record to the pipeline progress log.
 * Used alongside markCacheableSegments() to track how much of each prompt
 * can be served from the provider's prompt cache.
 *
 * Never throws — callers rely on fire-and-forget semantics.
 *
 * @param config — BOX config object
 * @param input  — cache segment usage data
 */
export async function appendCacheSegmentUsage(config: any, input: CacheSegmentLogInput): Promise<void> {
  const cacheRatio = input.totalSegments > 0
    ? ((input.cachedSegments / input.totalSegments) * 100).toFixed(1)
    : "0.0";
  try {
    await appendProgress(
      config,
      `[CACHE_SEGMENTS] agent=${input.agent} model=${input.model} cached=${input.cachedSegments}/${input.totalSegments} (${cacheRatio}%) savedTokens=${input.estimatedSavedTokens}`
    );
  } catch (_err) {
    // Non-fatal: cache telemetry must never block the primary pipeline
  }
}
