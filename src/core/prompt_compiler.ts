/**
 * prompt_compiler.js — Assembles agent prompts from reusable sections.
 *
 * Instead of monolithic prompt strings scattered across modules, this compiler
 * builds prompts from named sections that can be shared, tested, and versioned.
 *
 * Usage:
 *   const prompt = compilePrompt([
 *     section("role", "You are Athena — BOX Quality Gate."),
 *     section("context", `TARGET REPO: ${repo}`),
 *     section("mission", missionText),
 *     section("format", outputFormat),
 *   ]);
 */

import { createHash } from "node:crypto";

/**
 * Budget partition labels for prompt sections.
 *
 * Partitions define how sections are treated under global token-budget pressure:
 *
 *   INVARIANT  — Always included in full. Never trimmed by section-level maxTokens
 *                or dropped by global budget. Use for core identity sections (role,
 *                output format, evolution directive) that must survive any token pressure.
 *
 *   REQUIRED   — Always included. Section-level maxTokens truncation applies, but the
 *                section is never dropped regardless of the global budget. Use for
 *                cycle-delta sections (carry-forward, behavior patterns, research)
 *                that must be present but whose token cost can be capped.
 *
 *   EXPANDABLE — Fill remaining budget after invariant + required sections have been
 *                allocated. Dropped in order when budget is exhausted. Use for large
 *                optional context (repo file listing, drift reports, repair feedback)
 *                that enrich the prompt but are not critical to correctness.
 *
 * Backward compatibility: sections with `required: true` and no explicit
 * `partitionBudget` are treated as REQUIRED. Sections without either field
 * are treated as EXPANDABLE.
 */
export const PROMPT_BUDGET_PARTITION = Object.freeze({
  INVARIANT:  "invariant"  as const,
  REQUIRED:   "required"   as const,
  EXPANDABLE: "expandable" as const,
});

/**
 * Minimum execution token floor per packet scope lane.
 *
 * System-learning: Prometheus consistently underestimates token budgets for
 * multi-file plans (~2 k declared for 7–8 file scopes).  The LARGE lane
 * enforces a hard 8 k floor to prevent under-resourced dispatch.
 *
 * These constants are the single authoritative source for lane token floors;
 * LANE_PACKET_SIZE_DEFAULTS in plan_contract_validator references the same values.
 */
export const LANE_MIN_EXECUTION_TOKENS = Object.freeze({
  /** 1–2 files */
  SMALL:   2000,
  /** 3–4 files */
  MEDIUM:  4000,
  /** 5+ files — guards against Prometheus underestimation on multi-file scopes */
  LARGE:   8000,
  /** Fallback when file count is unknown */
  DEFAULT: 2000,
} as const);

export type PromptBudgetPartition = "invariant" | "required" | "expandable";

/**
 * Resolve the effective budget partition for a section.
 * Checks `partitionBudget` first, then falls back to `required: true` → REQUIRED,
 * and the absence of either → EXPANDABLE.
 */
function resolvePartition(s: {
  partitionBudget?: string;
  required?: boolean;
}): PromptBudgetPartition {
  if (s.partitionBudget === PROMPT_BUDGET_PARTITION.INVARIANT)  return PROMPT_BUDGET_PARTITION.INVARIANT;
  if (s.partitionBudget === PROMPT_BUDGET_PARTITION.REQUIRED)   return PROMPT_BUDGET_PARTITION.REQUIRED;
  if (s.partitionBudget === PROMPT_BUDGET_PARTITION.EXPANDABLE) return PROMPT_BUDGET_PARTITION.EXPANDABLE;
  if (s.required === true) return PROMPT_BUDGET_PARTITION.REQUIRED;
  return PROMPT_BUDGET_PARTITION.EXPANDABLE;
}

/**
 * Create a named prompt section.
 *
 * @param {string} name — section identifier for debugging/tracing
 * @param {string} content — the text content of this section
 * @returns {{ name: string, content: string }}
 */
export function section(name, content) {
  return { name, content: String(content || "").trim() };
}

/**
 * Compile an array of prompt sections into a single prompt string.
 * Empty sections are omitted. Each section is separated by a double newline.
 *
 * With section-level caps: each section can have a maxTokens limit.
 * If a section exceeds its cap, it is truncated from the end.
 * Invariant sections bypass section-level caps and are never truncated.
 *
 * Three-pass budget trimming (when tokenBudget > 0):
 *   Pass 1 — INVARIANT: included in full, never trimmed.
 *   Pass 2 — REQUIRED:  included after per-section maxTokens truncation, never dropped.
 *   Pass 3 — EXPANDABLE: fill remaining budget in original order; dropped when exhausted.
 *
 * Backward compatibility: sections with `required: true` and no explicit
 * `partitionBudget` are treated as REQUIRED. Sections without either field
 * are treated as EXPANDABLE.
 *
 * @param {Array<{ name: string, content: string, maxTokens?: number, required?: boolean, partitionBudget?: PromptBudgetPartition }>} sections
 * @param {{ separator?: string, includeHeaders?: boolean, tokenBudget?: number }} opts
 * @returns {string}
 */
export function compilePrompt(sections, opts: any = {}) {
  const sep = opts.separator || "\n\n";
  const includeHeaders = opts.includeHeaders || false;
  const budget = opts.tokenBudget || 0;

  // Pair each non-empty section with its original index for stable ordering
  const tagged = sections
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => s && s.content && s.content.length > 0)
    .map(({ s, idx }) => {
      const partition = resolvePartition(s);
      let content = s.content;
      // Section-level cap: truncate if section exceeds its own maxTokens.
      // Invariant sections bypass this cap — their content is always used in full.
      if (partition !== PROMPT_BUDGET_PARTITION.INVARIANT && s.maxTokens && s.maxTokens > 0) {
        const sectionTokens = estimateTokens(content);
        if (sectionTokens > s.maxTokens) {
          const maxChars = s.maxTokens * 4;
          content = content.slice(0, maxChars) + "\n[...truncated to section budget]";
        }
      }
      const piece = includeHeaders ? `## ${s.name}\n${content}` : content;
      return { piece, idx, required: s.required === true, partition };
    });

  let pieces: string[];

  // If a global token budget is specified, enforce three-pass deterministic trimming.
  if (budget > 0) {
    const invariantItems  = tagged.filter(t => t.partition === PROMPT_BUDGET_PARTITION.INVARIANT);
    const requiredItems   = tagged.filter(t => t.partition === PROMPT_BUDGET_PARTITION.REQUIRED);
    const expandableItems = tagged.filter(t => t.partition === PROMPT_BUDGET_PARTITION.EXPANDABLE);

    // Deduct invariant + required token cost unconditionally
    const invariantTokens = invariantItems.reduce((sum, t) => sum + estimateTokens(t.piece), 0);
    const requiredTokens  = requiredItems.reduce((sum, t)  => sum + estimateTokens(t.piece), 0);
    let remainingBudget = budget - invariantTokens - requiredTokens;

    // Fill remaining budget with expandable sections in original order
    const keptExpandable: typeof tagged = [];
    for (const item of expandableItems) {
      const t = estimateTokens(item.piece);
      if (remainingBudget - t < 0) break;
      keptExpandable.push(item);
      remainingBudget -= t;
    }

    // Merge all three partitions, preserving original section order
    pieces = [...invariantItems, ...requiredItems, ...keptExpandable]
      .sort((a, b) => a.idx - b.idx)
      .map(t => t.piece);
  } else {
    pieces = tagged.map(t => t.piece);
  }

  return pieces.join(sep);
}

/**
 * Common reusable sections.
 */
export const COMMON_SECTIONS = Object.freeze({
  singlePromptMode: section(
    "single-prompt-mode",
    "EXECUTION MODE: Single-prompt, single-turn. You get ONE shot — no follow-ups, no continues. Make it count."
  ),
  jsonOutputMarkers: section(
    "json-output-markers",
    "Wrap your structured JSON output with:\n===DECISION===\n{ ... }\n===END==="
  ),
  noVagueGoals: section(
    "no-vague-goals",
    "Every goal must be measurable and specific. Do NOT use vague verbs like 'improve', 'optimize', or 'enhance' without a concrete metric."
  ),
  leverageRankedAlternatives: section(
    "leverage-ranked-alternatives",
    [
      "LEVERAGE-RANKED ALTERNATIVES (required for every proposed change):",
      "For each improvement you propose, provide at least 2 concrete alternatives ranked by leverage",
      "(capacity increase per unit effort). State which you recommend and why.",
      "Format each alternative as: [RANK N] <approach> — leverage: <high|medium|low> — rationale: <why>.",
      "Do NOT propose only a single approach. The highest-leverage option must address the system bottleneck directly.",
      "Alternatives that merely re-order existing behavior without measurable capacity gain are NOT valid."
    ].join("\n")
  ),
});

export function buildCandidateGenerationSection(opts: {
  minCandidates?: number;
  maxCandidates?: number;
  requireFallbackPlans?: boolean;
} = {}) {
  const rawMin = Number(opts.minCandidates);
  const rawMax = Number(opts.maxCandidates);
  const minCandidates = Number.isFinite(rawMin) ? Math.max(2, Math.floor(rawMin)) : 2;
  const maxCandidates = Number.isFinite(rawMax) ? Math.max(minCandidates, Math.floor(rawMax)) : 5;
  const requireFallbackPlans = opts.requireFallbackPlans !== false;

  return section(
    "candidate-generation",
    [
      "CANDIDATE PLAN GENERATION (bounded multi-draft mode):",
      `Generate between ${minCandidates} and ${maxCandidates} distinct candidate plan sets.`,
      "Each candidate set must be a self-contained, complete, and immediately executable plan array.",
      "Candidates must differ in decomposition strategy, wave ordering, or task granularity.",
      "Do NOT generate near-duplicate candidates that differ only in phrasing.",
      "Emit the JSON companion using this exact shape:",
      `"candidateSets": [`,
      `  { "label": "candidate-1", "plans": [ ... ] },`,
      `  { "label": "candidate-2", "plans": [ ... ] }`,
      `]`,
      "Each candidateSets[*].plans array must satisfy the full plan contract on its own.",
      "The orchestrator will score all candidates using critic, contract, and freshness gates, then select the best set deterministically.",
      "Do not rank the candidates yourself.",
      requireFallbackPlans
        ? "Also copy your strongest candidate into the top-level plans array for backward compatibility. The top-level plans must exactly match one candidate set."
        : "If you also emit top-level plans, they must exactly match one candidate set; otherwise omit top-level plans in multi-draft mode.",
      "Each candidate must satisfy measurable acceptance criteria, concrete verification, specific target files, positive capacityDelta, and requestROI > 1.",
    ].join("\n")
  );
}

/**
 * Prompt section instructing the planner to generate bounded candidate plan sets
 * rather than a single draft.  Each candidate should be a self-contained,
 * complete plan array that can be scored independently by the plan critic.
 *
 * Usage: include this section in the Prometheus planning prompt when multi-candidate
 * generation is enabled.  The orchestrator will pass all returned candidate sets to
 * selectBestCandidatePlans for rubric-based deterministic selection.
 *
 * Bounded to MAX_CANDIDATE_SETS (default 5) to control token spend.
 */
export const CANDIDATE_GENERATION_SECTION = buildCandidateGenerationSection();

/**
 * Estimate token count for a text string.
 * Uses the ~4 chars per token heuristic (accurate ±10% for English/code).
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * Estimate the USD cost for a given token count.
 *
 * Default rate: $3.00 per 1M tokens (Claude Sonnet 4 input pricing).
 * Callers may override via costPerMillionTokens.
 *
 * @param tokens - token count (output of estimateTokens / estimatePromptTokens.total)
 * @param costPerMillionTokens - cost rate override (default: 3.0)
 * @returns estimated cost in USD, rounded to 6 decimal places
 */
export function estimateTokenCost(tokens: number, costPerMillionTokens = 3.0): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  const rate = Number.isFinite(costPerMillionTokens) && costPerMillionTokens >= 0
    ? costPerMillionTokens
    : 3.0;
  return Math.round((tokens / 1_000_000) * rate * 1_000_000) / 1_000_000;
}

/**
 * Estimate per-section and total token usage for an array of sections.
 *
 * @param {Array<{ name: string, content: string }>} sections
 * @returns {{ total: number, sections: Array<{ name: string, tokens: number }> }}
 */
export function estimatePromptTokens(sections) {
  const result = [];
  let total = 0;
  for (const s of (sections || [])) {
    if (!s || !s.content) continue;
    const t = estimateTokens(s.content);
    result.push({ name: s.name, tokens: t });
    total += t;
  }
  return { total, sections: result };
}

/**
 * Normalize a structured list for prompt-safe injection.
 * Removes empty entries, de-duplicates case-insensitively, and bounds both
 * item count and per-item character length.
 */
export function boundStructuredList(
  values: unknown,
  opts: { maxItems?: number; maxItemChars?: number } = {}
): string[] {
  const maxItems = Math.max(1, Number(opts.maxItems ?? 20));
  const maxItemChars = Math.max(8, Number(opts.maxItemChars ?? 280));
  const list = Array.isArray(values) ? values : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of list) {
    const normalized = String(value || "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) continue;
    const bounded = normalized.length > maxItemChars
      ? `${normalized.slice(0, maxItemChars - 3)}...`
      : normalized;
    const key = bounded.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(bounded);
    if (output.length >= maxItems) break;
  }
  return output;
}

// ─── Packet 18 — Prompt Compiler Tiering by Task Complexity ────────────

/**
 * Complexity tiers matching model_policy.js classifications.
 * Each tier defines: max total tokens, section budgets, and anti-fluff strictness.
 */
export const PROMPT_TIERS = Object.freeze({
  T1: { label: "trivial", maxTokens: 800, antiFluff: false },
  T2: { label: "moderate", maxTokens: 2000, antiFluff: true },
  T3: { label: "complex", maxTokens: 4000, antiFluff: true },
});

/**
 * Vague verbs that add no measurable value to prompts.
 * Used by the anti-fluff filter in T2/T3 prompts.
 */
const FLUFF_PATTERNS = [
  /\b(significantly|drastically|greatly|massively)\s+(improve|enhance|optimize|boost)\b/gi,
  /\bstrive\s+to\b/gi,
  /\bas\s+(?:much|needed|appropriate)\s+as\s+possible\b/gi,
  /\btry\s+(?:to\s+)?(?:improve|enhance|optimize)\b/gi,
];

/**
 * Strip anti-fluff patterns from text.
 * Replaces vague verb phrases with empty string and collapses whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFluff(text) {
  if (!text) return "";
  let cleaned = text;
  for (const pat of FLUFF_PATTERNS) {
    cleaned = cleaned.replace(pat, "");
  }
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

/**
 * Compile a tiered prompt — applies complexity-based token budget and anti-fluff.
 *
 * @param {Array<{ name: string, content: string, maxTokens?: number }>} sections
 * @param {{ tier?: "T1"|"T2"|"T3", separator?: string, includeHeaders?: boolean }} opts
 * @returns {string}
 */
export function compileTieredPrompt(sections, opts: any = {}) {
  const tier = PROMPT_TIERS[opts.tier] || PROMPT_TIERS.T2;

  let processed = sections;
  if (tier.antiFluff) {
    // Preserve all section properties (including `required`) when stripping fluff
    processed = sections.map(s => ({
      ...s,
      content: stripFluff(s.content),
    }));
  }

  return compilePrompt(processed, {
    separator: opts.separator,
    includeHeaders: opts.includeHeaders,
    tokenBudget: tier.maxTokens,
  });
}

// ─── Actionable Packet Contract Validation ──────────────────────────────────

/**
 * Required output-contract terms for actionable packet prompts.
 *
 * Every prompt that instructs an AI to produce an actionable packet (a structured
 * response consumed by the dispatch pipeline) MUST reference these terms in the
 * output format section so the AI knows which fields to populate.
 *
 * Absence of any term from the compiled prompt is a completeness gap — the AI
 * may omit that field entirely, causing downstream failures in plan review,
 * normalization, and dispatch.
 *
 * Terms are checked case-insensitively against the full compiled section content.
 */
export const ACTIONABLE_PACKET_CONTRACT_TERMS = Object.freeze([
  "approved",
  "patchedPlans",
  "planReviews",
  "acceptance_criteria",
  "verification",
  "implementationStatus",
  "implementationEvidence",
  "capacityDelta",
  "requestROI",
  "leverage_rank",
]);

/**
 * Status codes returned by validateActionablePacketCompleteness.
 *
 * @enum {string}
 */
export const COMPLETENESS_STATUS = Object.freeze({
  /** All required contract terms are present in the sections. */
  COMPLETE: "complete",
  /** One or more required contract terms are absent from the sections. */
  INCOMPLETE: "incomplete",
});

/**
 * Validate that a compiled set of prompt sections provides adequate coverage for
 * an actionable packet response. Checks whether all required contract terms appear
 * in the combined section content so the AI knows which output fields to populate.
 *
 * Terms are checked case-insensitively. A section must have non-empty content to
 * contribute to coverage — empty sections are skipped.
 *
 * @param {Array<{ name: string, content: string }>} sections
 * @returns {{ status: string, complete: boolean, completenessScore: number, missingTerms: string[] }}
 */
export function validateActionablePacketCompleteness(sections) {
  const combinedContent = (sections || [])
    .filter(s => s && typeof s.content === "string" && s.content.trim().length > 0)
    .map(s => s.content)
    .join(" ")
    .toLowerCase();

  const missingTerms = (ACTIONABLE_PACKET_CONTRACT_TERMS as readonly string[]).filter(
    term => !combinedContent.includes(term.toLowerCase())
  );

  const presentCount = ACTIONABLE_PACKET_CONTRACT_TERMS.length - missingTerms.length;
  const completenessScore = ACTIONABLE_PACKET_CONTRACT_TERMS.length > 0
    ? Math.round((presentCount / ACTIONABLE_PACKET_CONTRACT_TERMS.length) * 10000) / 10000
    : 1.0;

  const complete = missingTerms.length === 0;
  return {
    status: complete ? COMPLETENESS_STATUS.COMPLETE : COMPLETENESS_STATUS.INCOMPLETE,
    complete,
    completenessScore,
    missingTerms,
  };
}

// ─── Packet — Cache-eligible segment marking ──────────────────────────────────

/**
 * Section names that are structurally stable across calls — suitable for
 * prompt-caching layers that avoid re-tokenising unchanged prefixes.
 *
 * Dynamic sections (task context, plan details, per-call data) must NOT appear
 * here; only content that is effectively constant for a given system/model build.
 */
export const CACHE_STABLE_SECTION_NAMES: ReadonlySet<string> = new Set([
  "role",
  "system",
  "instructions",
  "single-prompt-mode",
  "json-output-markers",
  "no-vague-goals",
  "leverage-ranked-alternatives",
]);

function normalizePromptSectionName(name: unknown): string {
  return String(name || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function isInvariantPromptSection(section: { partitionBudget?: string; required?: boolean } | null | undefined): boolean {
  return section?.partitionBudget === PROMPT_BUDGET_PARTITION.INVARIANT;
}

function isCacheablePromptSection(
  section: { name?: string; cacheable?: boolean; partitionBudget?: string; required?: boolean } | null | undefined,
  extraStableNames: ReadonlySet<string>,
): boolean {
  const name = normalizePromptSectionName(section?.name);
  return CACHE_STABLE_SECTION_NAMES.has(name)
    || extraStableNames.has(name)
    || section?.cacheable === true
    || isInvariantPromptSection(section);
}

function normalizePromptCacheContent(content: unknown): string {
  return stripPromptLineageMarker(content).replace(/\s+/g, " ").trim();
}

function hasPromptSectionContent(section: { content?: unknown } | null | undefined): boolean {
  return normalizePromptCacheContent(section?.content).length > 0;
}

function collectStablePrefixSections(
  sections: Array<{ name?: string; content?: string; cacheable?: boolean; partitionBudget?: string; required?: boolean; [key: string]: any }>,
  extraStableNames: ReadonlySet<string>,
): Array<{ name: string; content: string }> {
  const prefix: Array<{ name: string; content: string }> = [];
  let prefixOpen = true;
  for (const section of sections || []) {
    if (!section || !prefixOpen) {
      if (!prefixOpen) break;
      continue;
    }
    const content = normalizePromptCacheContent(section.content);
    if (!content) continue;
    if (!isCacheablePromptSection(section, extraStableNames)) {
      prefixOpen = false;
      continue;
    }
    prefix.push({
      name: normalizePromptSectionName(section.name),
      content,
    });
  }
  return prefix;
}

/**
 * Mark prompt sections as cache-eligible based on naming heuristics.
 *
 * A section is marked `cacheable: true` when:
 *   (a) its name is in CACHE_STABLE_SECTION_NAMES, or
 *   (b) `opts.stableNames` includes its name, or
 *   (c) the section already carries `cacheable: true`.
 *
 * Cacheability is enforced as a contiguous prefix. Once a dynamic section is
 * encountered, later sections remain non-cacheable even if they are otherwise
 * structurally stable — provider prompt caching only reuses a stable prefix.
 *
 * Original section objects are never mutated — a new array is returned.
 *
 * @param sections - prompt sections to process
 * @param opts     - optional additional stable names to treat as cacheable
 * @returns new array with `cacheable` field set on every element
 */
export function markCacheableSegments(
  sections: Array<{ name: string; content: string; cacheable?: boolean; [key: string]: any }>,
  opts: { stableNames?: string[] } = {}
): Array<{ name: string; content: string; cacheable: boolean; [key: string]: any }> {
  const extra = new Set((opts.stableNames || []).map(normalizePromptSectionName));
  let prefixOpen = true;
  return (sections || []).map((section) => {
    const hasContent = hasPromptSectionContent(section);
    const isStable = isCacheablePromptSection(section, extra);
    const cacheable = Boolean(prefixOpen && hasContent && isStable);
    if (prefixOpen && hasContent && !isStable) {
      prefixOpen = false;
    }
    return { ...section, cacheable };
  });
}

/**
 * Build a deterministic prompt-family key from cache-eligible sections.
 *
 * The key intentionally ignores dynamic sections unless `stableOnly=false` is
 * requested. This lets callers persist prompt-cache telemetry against a stable
 * family identifier that survives per-call payload changes.
 */
export function derivePromptFamilyKey(
  sections: Array<{ name: string; content: string; cacheable?: boolean; [key: string]: any }>,
  opts: { stableOnly?: boolean; salt?: string } = {}
): string {
  const stableOnly = opts.stableOnly !== false;
  const emptyStableNames = new Set<string>();
  const normalized = stableOnly
    ? collectStablePrefixSections(sections, emptyStableNames)
    : (sections || [])
      .filter((section) => hasPromptSectionContent(section))
      .map((section) => ({
        name: normalizePromptSectionName(section.name),
        content: normalizePromptCacheContent(section.content),
      }));
  const includeSalt = normalized.length === 0 || stableOnly === false;

  const payload = JSON.stringify({
    schema: stableOnly ? "stable-prefix-v2" : "full-prompt-v2",
    salt: includeSalt ? String(opts.salt || "prompt-family") : null,
    sections: normalized,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function buildPromptFamilyJoinKey(promptFamilyKey: unknown): string | null {
  const normalized = normalizePromptLineageScalar(promptFamilyKey, 160);
  return normalized ? `prompt-family:${normalized}` : null;
}

function normalizePromptJoinTaskKind(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

export function shouldUsePromptFamilyJoinKey(
  hints: { taskKind?: unknown; role?: unknown } = {},
): boolean {
  const taskKind = normalizePromptJoinTaskKind(hints.taskKind);
  const role = String(hints.role || "").trim().toLowerCase();
  return (
    taskKind === "planning"
    || taskKind === "plan-review"
    || taskKind === "review"
    || taskKind === "analysis"
    || role === "prometheus"
    || role === "athena"
    || role === "janus"
  );
}

export function resolvePromptFamilyLineageJoinKey(
  input: {
    promptFamilyKey?: unknown;
    taskKind?: unknown;
    role?: unknown;
    explicitJoinKey?: unknown;
    fallbackJoinKey?: unknown;
  } = {},
): string | null {
  const explicitJoinKey = normalizePromptLineageScalar(input.explicitJoinKey, 240);
  const fallbackJoinKey = normalizePromptLineageScalar(input.fallbackJoinKey, 240);
  const promptFamilyJoinKey = buildPromptFamilyJoinKey(input.promptFamilyKey);
  if (shouldUsePromptFamilyJoinKey({ taskKind: input.taskKind, role: input.role })) {
    return promptFamilyJoinKey || explicitJoinKey || fallbackJoinKey;
  }
  return explicitJoinKey || fallbackJoinKey || promptFamilyJoinKey;
}

export const PROMPT_LINEAGE_MARKER_PREFIX = "<!-- BOX_PROMPT_LINEAGE:";
export const PROMPT_LINEAGE_MARKER_SUFFIX = " -->";

export type PromptLineageContract = {
  lineageId: string | null;
  parentLineageId: string | null;
  promptFamilyKey: string | null;
  familyLabel: string | null;
  agent: string | null;
  stage: string | null;
  checkpointNs: string | null;
  checkpointId: string | null;
  resumeFromCheckpointId: string | null;
  stablePrefixHash: string | null;
  totalSegments: number;
  cacheableSegments: number;
  estimatedSavedTokens: number;
};

const PROMPT_LINEAGE_INVARIANT_FIELDS: ReadonlyArray<keyof PromptLineageContract> = Object.freeze([
  "promptFamilyKey",
  "familyLabel",
  "agent",
  "stage",
  "stablePrefixHash",
  "totalSegments",
  "cacheableSegments",
  "estimatedSavedTokens",
]);

const PROMPT_LINEAGE_RUNTIME_FIELDS: ReadonlyArray<keyof PromptLineageContract> = Object.freeze([
  "lineageId",
  "parentLineageId",
  "checkpointNs",
  "checkpointId",
  "resumeFromCheckpointId",
]);

function normalizePromptLineageScalar(value: unknown, maxChars = 120): string | null {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, maxChars) : null;
}

function normalizePromptLineageCount(value: unknown): number {
  return Math.max(0, Math.floor(Number(value) || 0));
}

export function normalizePromptLineageContract(
  value: unknown,
  defaults: Partial<PromptLineageContract> = {},
): PromptLineageContract {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const promptFamilyKey = normalizePromptLineageScalar(source.promptFamilyKey ?? defaults.promptFamilyKey);
  const stablePrefixHash = normalizePromptLineageScalar(
    source.stablePrefixHash
    ?? promptFamilyKey
    ?? defaults.stablePrefixHash
    ?? defaults.promptFamilyKey,
  );
  return {
    promptFamilyKey,
    familyLabel: normalizePromptLineageScalar(source.familyLabel ?? defaults.familyLabel),
    agent: normalizePromptLineageScalar(source.agent ?? defaults.agent),
    stage: normalizePromptLineageScalar(source.stage ?? defaults.stage),
    stablePrefixHash,
    totalSegments: normalizePromptLineageCount(source.totalSegments ?? defaults.totalSegments),
    cacheableSegments: normalizePromptLineageCount(source.cacheableSegments ?? defaults.cacheableSegments),
    estimatedSavedTokens: normalizePromptLineageCount(source.estimatedSavedTokens ?? defaults.estimatedSavedTokens),
    lineageId: normalizePromptLineageScalar(source.lineageId ?? defaults.lineageId),
    parentLineageId: normalizePromptLineageScalar(source.parentLineageId ?? defaults.parentLineageId),
    checkpointNs: normalizePromptLineageScalar(source.checkpointNs ?? defaults.checkpointNs),
    checkpointId: normalizePromptLineageScalar(source.checkpointId ?? defaults.checkpointId, 200),
    resumeFromCheckpointId: normalizePromptLineageScalar(
      source.resumeFromCheckpointId ?? defaults.resumeFromCheckpointId,
      200,
    ),
  };
}

function shouldIncludePromptLineageField(
  field: keyof PromptLineageContract,
  value: PromptLineageContract[keyof PromptLineageContract],
): boolean {
  if (typeof value === "number") {
    return value > 0 || field === "totalSegments" || field === "cacheableSegments";
  }
  return value != null;
}

function buildPromptLineagePayload(
  normalized: PromptLineageContract,
  opts: { includeRuntime?: boolean } = {},
): Partial<PromptLineageContract> {
  const includeRuntime = opts.includeRuntime !== false;
  const payload: Partial<PromptLineageContract> = {};
  const orderedFields = includeRuntime
    ? [...PROMPT_LINEAGE_INVARIANT_FIELDS, ...PROMPT_LINEAGE_RUNTIME_FIELDS]
    : [...PROMPT_LINEAGE_INVARIANT_FIELDS];
  for (const field of orderedFields) {
    const value = normalized[field];
    if (shouldIncludePromptLineageField(field, value)) {
      (payload as Record<string, unknown>)[field] = value;
    }
  }
  return payload;
}

export function buildPromptLineageMarker(
  value: unknown,
  defaults: Partial<PromptLineageContract> = {},
): string {
  const normalized = normalizePromptLineageContract(value, defaults);
  const payload = buildPromptLineagePayload(normalized);
  return `${PROMPT_LINEAGE_MARKER_PREFIX}${JSON.stringify(payload)}${PROMPT_LINEAGE_MARKER_SUFFIX}`;
}

export function extractPromptLineageMarker(text: unknown): PromptLineageContract | null {
  const raw = String(text || "");
  if (!raw.includes(PROMPT_LINEAGE_MARKER_PREFIX)) return null;
  const start = raw.indexOf(PROMPT_LINEAGE_MARKER_PREFIX);
  const payloadStart = start + PROMPT_LINEAGE_MARKER_PREFIX.length;
  const end = raw.indexOf(PROMPT_LINEAGE_MARKER_SUFFIX, payloadStart);
  if (end < 0) return null;
  const payload = raw.slice(payloadStart, end).trim();
  try {
    return normalizePromptLineageContract(JSON.parse(payload));
  } catch {
    return null;
  }
}

export function stripPromptLineageMarker(text: unknown): string {
  const raw = String(text || "");
  if (!raw.includes(PROMPT_LINEAGE_MARKER_PREFIX)) return raw;
  const markerPattern = /<!-- BOX_PROMPT_LINEAGE:\{.*?\} -->\s*/g;
  return raw.replace(markerPattern, "").trimStart();
}

function extractPromptLineageJsonObject(raw: string, fieldName: string): PromptLineageContract | null {
  const label = `"${fieldName}"`;
  const fieldIndex = raw.indexOf(label);
  if (fieldIndex < 0) return null;
  const colonIndex = raw.indexOf(":", fieldIndex + label.length);
  const objectStart = raw.indexOf("{", colonIndex + 1);
  if (colonIndex < 0 || objectStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return normalizePromptLineageContract(JSON.parse(raw.slice(objectStart, index + 1)));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function extractPromptLineageContractFromText(text: unknown): PromptLineageContract | null {
  const raw = String(text || "");
  return extractPromptLineageMarker(raw)
    || extractPromptLineageJsonObject(raw, "promptLineage")
    || extractPromptLineageJsonObject(raw, "reviewerPromptLineage");
}

export function buildPromptLineagePreamble(
  value: unknown,
  defaults: Partial<PromptLineageContract> = {},
): string {
  const normalized = normalizePromptLineageContract(value, defaults);
  const stableLines = ["## PROMPT LINEAGE"];
  if (normalized.promptFamilyKey) stableLines.push(`promptFamilyKey=${normalized.promptFamilyKey}`);
  if (normalized.familyLabel) stableLines.push(`familyLabel=${normalized.familyLabel}`);
  if (normalized.agent) stableLines.push(`agent=${normalized.agent}`);
  if (normalized.stage) stableLines.push(`stage=${normalized.stage}`);
  if (normalized.stablePrefixHash) stableLines.push(`stablePrefixHash=${normalized.stablePrefixHash}`);
  if (normalized.totalSegments > 0 || normalized.cacheableSegments > 0) {
    stableLines.push(`cacheableSegments=${normalized.cacheableSegments}/${normalized.totalSegments}`);
  }
  if (normalized.estimatedSavedTokens > 0) {
    stableLines.push(`estimatedSavedTokens=${normalized.estimatedSavedTokens}`);
  }

  const runtimeLines: string[] = [];
  if (normalized.lineageId) runtimeLines.push(`lineageId=${normalized.lineageId}`);
  if (normalized.parentLineageId) runtimeLines.push(`parentLineageId=${normalized.parentLineageId}`);
  if (normalized.checkpointNs) runtimeLines.push(`checkpointNs=${normalized.checkpointNs}`);
  if (normalized.checkpointId) runtimeLines.push(`checkpointId=${normalized.checkpointId}`);
  if (normalized.resumeFromCheckpointId) runtimeLines.push(`resumeFromCheckpointId=${normalized.resumeFromCheckpointId}`);

  if (runtimeLines.length === 0) {
    return stableLines.join("\n");
  }
  return [...stableLines, "## PROMPT LINEAGE RUNTIME", ...runtimeLines].join("\n");
}

/**
 * Mark sections whose names appear in a cycle-delta name set as `required: true`
 * and `partitionBudget: PROMPT_BUDGET_PARTITION.REQUIRED`, guaranteeing they
 * survive token-budget trimming in compilePrompt.
 *
 * Cycle-delta sections carry per-cycle reasoning context (research intelligence,
 * topic memory, carry-forward state) that must not be dropped under token pressure
 * — unlike large static context that can be safely truncated.
 *
 * Original section objects are never mutated — a new array is returned.
 * Sections not in the cycle-delta set retain their existing `required` field
 * and `partitionBudget` (defaulting to EXPANDABLE via resolvePartition).
 *
 * @param sections       - prompt sections to process
 * @param cycleDeltaNames - set of section names that must be marked required
 * @returns new array with `required: true` and `partitionBudget: "required"` on every cycle-delta section
 */
export function markCycleDeltaSectionsRequired<
  T extends { name: string; content: string; required?: boolean; partitionBudget?: PromptBudgetPartition; [key: string]: any }
>(
  sections: T[],
  cycleDeltaNames: ReadonlySet<string>
): Array<T & { required: boolean; partitionBudget: PromptBudgetPartition }> {
  return (sections || []).map(s => {
    const name = String(s?.name || "").toLowerCase();
    if (cycleDeltaNames.has(name)) {
      return { ...s, required: true, partitionBudget: PROMPT_BUDGET_PARTITION.REQUIRED };
    }
    return {
      ...s,
      required: s?.required === true,
      partitionBudget: (s?.partitionBudget as PromptBudgetPartition | undefined) ?? PROMPT_BUDGET_PARTITION.EXPANDABLE,
    };
  });
}

/**
 * Compile an actionable packet prompt with integrated completeness validation.
 *
 * Wraps compileTieredPrompt and runs validateActionablePacketCompleteness before
 * returning. The caller receives both the compiled prompt string and the completeness
 * result so it can decide whether to proceed or reject the prompt before submission.
 *
 * This is the preferred entry point when building prompts that expect structured
 * actionable packet responses (e.g., Athena plan review, governance decisions).
 *
 * @param {Array<{ name: string, content: string, maxTokens?: number, required?: boolean }>} sections
 * @param {{ tier?: "T1"|"T2"|"T3", separator?: string, includeHeaders?: boolean }} opts
 * @returns {{ prompt: string, completeness: { status, complete, completenessScore, missingTerms } }}
 */
export function compileActionablePacketPrompt(sections, opts: any = {}) {
  const completeness = validateActionablePacketCompleteness(sections);
  const prompt = compileTieredPrompt(sections, opts);
  return { prompt, completeness };
}

/**
 * Evaluate whether a planned packet set is dense enough to justify expensive
 * worker invocations.
 *
 * A packet is flagged as thin when it lacks sufficient breadth (target files /
 * acceptance criteria), depth (task text length), or estimated execution budget.
 */
export function analyzePacketDensification(
  plans: Array<{
    task?: string;
    target_files?: string[];
    acceptance_criteria?: string[];
    estimatedExecutionTokens?: number;
  }>,
  opts: {
    minTargetFiles?: number;
    minAcceptanceCriteria?: number;
    minTaskChars?: number;
    minExecutionTokens?: number;
  } = {}
) {
  const minTargetFiles = Number(opts.minTargetFiles ?? 2);
  const minAcceptanceCriteria = Number(opts.minAcceptanceCriteria ?? 2);
  const minTaskChars = Number(opts.minTaskChars ?? 120);
  const minExecutionTokens = Number(opts.minExecutionTokens ?? 8000);

  const normalizedPlans = Array.isArray(plans) ? plans : [];
  const thinIndexes: number[] = [];

  for (let i = 0; i < normalizedPlans.length; i++) {
    const p = normalizedPlans[i] || {};
    const taskChars = String(p.task || "").trim().length;
    const targetCount = Array.isArray(p.target_files) ? p.target_files.filter(Boolean).length : 0;
    const acCount = Array.isArray(p.acceptance_criteria) ? p.acceptance_criteria.filter(Boolean).length : 0;
    const estimatedTokens = Number(p.estimatedExecutionTokens || 0);

    const thin =
      taskChars < minTaskChars
      || targetCount < minTargetFiles
      || acCount < minAcceptanceCriteria
      || !Number.isFinite(estimatedTokens)
      || estimatedTokens < minExecutionTokens;

    if (thin) thinIndexes.push(i);
  }

  const total = normalizedPlans.length;
  const denseCount = Math.max(0, total - thinIndexes.length);
  const denseRatio = total > 0 ? Math.round((denseCount / total) * 1000) / 1000 : 1;

  return {
    total,
    denseCount,
    thinCount: thinIndexes.length,
    thinIndexes,
    denseRatio,
    isDenseEnough: thinIndexes.length === 0,
  };
}

export function compileRankedContextSection(
  title: string,
  entries: Array<{ path: string; score: number; preview?: string }>,
  opts: { tokenBudget?: number; maxEntries?: number } = {},
): string {
  const heading = String(title || "RANKED CONTEXT").trim();
  const tokenBudget = Math.max(80, Number(opts.tokenBudget || 500));
  const maxEntries = Math.max(1, Math.floor(Number(opts.maxEntries || 10)));
  const safeEntries = Array.isArray(entries) ? entries : [];
  const lines: string[] = [`## ${heading}`];
  let remaining = tokenBudget;
  let added = 0;
  for (const entry of safeEntries) {
    if (added >= maxEntries) break;
    const preview = String(entry?.preview || "").trim().replace(/\s+/g, " ").slice(0, 160);
    const line = `${added + 1}. ${String(entry?.path || "")} (score=${Number(entry?.score || 0).toFixed(3)})${preview ? ` — ${preview}` : ""}`;
    const lineTokens = estimateTokens(line);
    if (remaining - lineTokens < 0) break;
    lines.push(line);
    remaining -= lineTokens;
    added += 1;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

// ── Prometheus context shortlist compiler ─────────────────────────────────────

/**
 * Hard token partition limits for each Prometheus context category.
 *
 * These are enforced caps — no category can exceed its limit regardless of
 * how many items are available.  The limits are designed so that the total
 * across all categories fits within a typical Prometheus prompt budget while
 * leaving sufficient room for invariant sections (role, output format, etc.).
 *
 * Operators may override per-category by passing opts.tokenLimits to
 * compilePrometheusContextShortlist().
 */
export const TOKEN_PARTITION_LIMITS = Object.freeze({
  /** Carry-forward / unresolved follow-ups from prior postmortems. */
  carryForward:     2000,
  /** High-severity health-audit findings (critical + important only). */
  healthFindings:   1500,
  /** Diagnostics freshness status lines. */
  diagnostics:       400,
  /** Recent postmortem lessons and patterns. */
  behaviorPatterns: 1500,
  /** Research intelligence summaries. */
  research:         3000,
  /** Topic memory fragments. */
  topicMemory:      1800,
});

export type TokenPartitionCategory = keyof typeof TOKEN_PARTITION_LIMITS;

/**
 * A single item for the shortlist.  Callers supply one per candidate entry;
 * the compiler selects the highest-ranked subset that fits the token budget.
 */
export interface ShortlistItem {
  /** Stable identifier (finding ID, lesson fingerprint, topic key, etc.). */
  id: string;
  /** Rendered text shown in the prompt. */
  text: string;
  /**
   * Recency score: higher = more recent.  Computed by the caller as
   * `1 / (1 + ageMs / referenceMs)` or any monotone-decreasing function of age.
   */
  recencyScore: number;
  /**
   * Impact score: higher = more important.  Severity mapping:
   *   critical → 1.0, important → 0.75, warning → 0.5, low → 0.25
   */
  impactScore: number;
  /**
   * Resolution status.  Items marked `resolved` are excluded from the shortlist
   * unless `opts.includeResolved` is explicitly true.
   */
  resolved?: boolean;
}

/**
 * Select the highest-ranked unresolved items from a candidate list and enforce
 * the hard token partition limit for the given category.
 *
 * Ranking formula: `0.6 * impactScore + 0.4 * recencyScore`
 * Items are sorted descending and included until the token budget is exhausted.
 *
 * @param items        — candidate list
 * @param category     — partition category (used to look up the default limit)
 * @param opts.tokenLimit — override the default limit for this call
 * @param opts.maxItems   — maximum number of items regardless of token budget
 * @param opts.includeResolved — include resolved items (default: false)
 * @returns selected items in rank-descending order
 */
export function buildContextShortlist(
  items: ShortlistItem[],
  category: TokenPartitionCategory,
  opts: {
    tokenLimit?: number;
    maxItems?: number;
    includeResolved?: boolean;
  } = {},
): ShortlistItem[] {
  const safeItems = Array.isArray(items) ? items : [];
  const hardLimit = Number.isFinite(opts.tokenLimit) && (opts.tokenLimit as number) > 0
    ? (opts.tokenLimit as number)
    : TOKEN_PARTITION_LIMITS[category];
  const maxItems = Number.isFinite(opts.maxItems) && (opts.maxItems as number) > 0
    ? Math.floor(opts.maxItems as number)
    : Infinity;
  const includeResolved = opts.includeResolved === true;

  // Filter resolved items unless explicitly included
  const candidates = safeItems.filter(item => includeResolved || !item.resolved);

  // Rank: 60% impact, 40% recency (both normalised to [0, 1] by the caller)
  const ranked = [...candidates].sort((a, b) => {
    const scoreA = 0.6 * Math.max(0, Math.min(1, a.impactScore))
                 + 0.4 * Math.max(0, Math.min(1, a.recencyScore));
    const scoreB = 0.6 * Math.max(0, Math.min(1, b.impactScore))
                 + 0.4 * Math.max(0, Math.min(1, b.recencyScore));
    return scoreB - scoreA; // descending
  });

  const selected: ShortlistItem[] = [];
  let usedTokens = 0;
  for (const item of ranked) {
    if (selected.length >= maxItems) break;
    const itemTokens = estimateTokens(item.text);
    if (usedTokens + itemTokens > hardLimit) break;
    selected.push(item);
    usedTokens += itemTokens;
  }
  return selected;
}

/**
 * Compile a formatted prompt section from a shortlist of items.
 *
 * Applies `buildContextShortlist` internally to enforce the token partition limit,
 * then renders the selected items as a numbered list under the given heading.
 *
 * @param title    — section heading
 * @param items    — candidate list (see ShortlistItem)
 * @param category — partition category for hard limit lookup
 * @param opts     — forwarded to buildContextShortlist + optional staleness label
 * @returns formatted section string, or empty string when no items are selected
 */
export function compilePrometheusContextShortlist(
  title: string,
  items: ShortlistItem[],
  category: TokenPartitionCategory,
  opts: {
    tokenLimit?: number;
    maxItems?: number;
    includeResolved?: boolean;
    /** When true, append a staleness warning footer to the section. */
    staleWarning?: boolean;
  } = {},
): string {
  const selected = buildContextShortlist(items, category, opts);
  if (selected.length === 0) return "";

  const heading = String(title || "CONTEXT").trim();
  const lines: string[] = [`## ${heading}`];
  selected.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${item.text.trim()}`);
  });

  if (opts.staleWarning) {
    lines.push(
      "\n⚠️ STALE: Some items above are from diagnostics older than the freshness threshold. " +
      "Do NOT treat these as current priorities without independent verification.",
    );
  }

  return lines.join("\n");
}

