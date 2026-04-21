/**
 * Research Scout — Internet Knowledge Acquisition Engine
 *
 * Searches the open internet for the most valuable technical knowledge
 * to advance the BOX autonomous agent system. Uses 1 premium request.
 *
 * Output: raw research package in state/research_scout_output.json
 * Live log: state/live_worker_research-scout.log
 */

import path from "node:path";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { readJson, writeJson, spawnAsync } from "./fs_utils.js";
import { appendProgress } from "./state_tracker.js";
import { buildAgentArgs } from "./agent_loader.js";
import { section, compilePrompt, estimateTokens } from "./prompt_compiler.js";
import { appendAgentContextUsage, resolveMaxPromptBudget } from "./context_usage.js";
import { appendAggregateLiveLogSync } from "./live_log.js";
import { buildPromptAssemblySections, resolvePromptRuntimeContext } from "./prompt_overlay.js";

const SCOUT_SEEN_URLS_FILE = "research_scout_seen_urls.json";
const SCOUT_TOPIC_SITE_STATUS_FILE = "research_scout_topic_site_status.json";

type TopicSiteEntry = {
  site: string;
  topic: string;
  status: "in_progress" | "completed";
  uniqueSourceCount: number;
  lastSeenAt: string;
  completedAt?: string;
};

type TopicSiteState = {
  updatedAt: string;
  entries: TopicSiteEntry[];
};

export interface TargetResearchCoveragePlan {
  adaptive: boolean;
  repoState: string;
  obligations: string[];
  recommendedSourceTypes: string[];
  targetSourceCount: number;
  rationale: string[];
}

const COVERAGE_SIGNAL_RULES = Object.freeze({
  visual_design: [/\blanding\b/i, /\bhero\b/i, /\bvisual\b/i, /\bbrand(?:ed|ing)?\b/i, /\bshowcase\b/i, /\bpremium\b/i, /\bmarketing\b/i, /\bportfolio\b/i],
  media_surfaces: [/\bimage\b/i, /\bimages\b/i, /\bphoto(?:graphy)?\b/i, /\bgallery\b/i, /\bvideo\b/i, /\billustration\b/i, /\basset\b/i],
  responsive_experience: [/\bresponsive\b/i, /\bmobile\b/i, /\bbreakpoint\b/i, /\bviewport\b/i, /\badaptive\b/i, /\bdesktop\b/i],
  trust_signals: [/\btrust\b/i, /\btestimonial\b/i, /\breview\b/i, /\brating\b/i, /\bfaq\b/i, /\bsocial\s+proof\b/i, /\breservation\b/i, /\bbooking\b/i, /\bcheckout\b/i, /\bpricing\b/i],
  user_flow_clarity: [/\bflow\b/i, /\bcta\b/i, /\bjourney\b/i, /\bnavigation\b/i, /\bform\b/i, /\bbooking\b/i, /\bcheckout\b/i, /\breservation\b/i, /\bdashboard\b/i, /\bworkflow\b/i],
  accessibility_clarity: [/\baccessibility\b/i, /\ba11y\b/i, /\bkeyboard\b/i, /\bcontrast\b/i, /\bsemantic\b/i, /\baria\b/i],
});

function pushUnique(list: string[], value: string): void {
  if (!value || list.includes(value)) return;
  list.push(value);
}

function textMatchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function collectTargetIntentText(activeTargetSession: any): string {
  const intent = activeTargetSession?.intent || {};
  const parts = [
    intent.summary,
    intent.productType,
    ...(Array.isArray(intent.targetUsers) ? intent.targetUsers : []),
    ...(Array.isArray(intent.mustHaveFlows) ? intent.mustHaveFlows : []),
    ...(Array.isArray(intent.scopeIn) ? intent.scopeIn : []),
    ...(Array.isArray(intent.successCriteria) ? intent.successCriteria : []),
  ];
  return parts
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function deriveTargetResearchCoveragePlan(activeTargetSession: any): TargetResearchCoveragePlan {
  const repoState = String(activeTargetSession?.intent?.repoState || activeTargetSession?.repoProfile?.repoState || "unknown").trim() || "unknown";
  const text = collectTargetIntentText(activeTargetSession);
  const obligations: string[] = [];
  const recommendedSourceTypes: string[] = [];
  const rationale: string[] = [];

  pushUnique(obligations, "implementation_patterns");
  pushUnique(obligations, "user_flow_clarity");
  pushUnique(recommendedSourceTypes, "implementation docs");
  pushUnique(recommendedSourceTypes, "reference implementations");
  pushUnique(recommendedSourceTypes, "failure-mode notes");

  if (repoState === "empty") {
    pushUnique(obligations, "architecture_foundation");
    pushUnique(recommendedSourceTypes, "stack selection references");
    rationale.push("repo is empty so initial build-direction evidence matters");
  }

  if (textMatchesAny(text, COVERAGE_SIGNAL_RULES.visual_design)) {
    pushUnique(obligations, "visual_design");
    pushUnique(recommendedSourceTypes, "visual exemplars");
    rationale.push("intent suggests a visual-first or brand-sensitive surface");
  }

  if (textMatchesAny(text, COVERAGE_SIGNAL_RULES.media_surfaces) || textMatchesAny(text, COVERAGE_SIGNAL_RULES.visual_design)) {
    pushUnique(obligations, "media_surfaces");
    pushUnique(recommendedSourceTypes, "asset and media patterns");
    rationale.push("delivery likely depends on imagery or media presentation");
  }

  if (textMatchesAny(text, COVERAGE_SIGNAL_RULES.responsive_experience) || textMatchesAny(text, COVERAGE_SIGNAL_RULES.visual_design)) {
    pushUnique(obligations, "responsive_experience");
    pushUnique(recommendedSourceTypes, "responsive UX guidance");
    rationale.push("the experience needs to hold across mobile and desktop");
  }

  if (textMatchesAny(text, COVERAGE_SIGNAL_RULES.trust_signals) || /\bpremium\b|\bconversion\b|\blanding\b/i.test(text)) {
    pushUnique(obligations, "trust_signals");
    pushUnique(recommendedSourceTypes, "trust/conversion UX examples");
    rationale.push("user confidence and conversion clarity are part of success");
  }

  if (textMatchesAny(text, COVERAGE_SIGNAL_RULES.accessibility_clarity) || /\buser\b|\bcustomer\b|\bpublic\b|\blanding\b|\bdashboard\b/i.test(text)) {
    pushUnique(obligations, "accessibility_clarity");
    pushUnique(recommendedSourceTypes, "accessibility and usability guidance");
    rationale.push("user-facing delivery benefits from usability evidence");
  }

  const targetSourceCount = Math.max(8, Math.min(24, 6 + (obligations.length * 2) + (repoState === "empty" ? 2 : 0)));

  return {
    adaptive: true,
    repoState,
    obligations,
    recommendedSourceTypes,
    targetSourceCount,
    rationale,
  };
}

export function buildTargetResearchCoverageSection(activeTargetSession: any): string {
  const plan = deriveTargetResearchCoveragePlan(activeTargetSession);
  return `## TARGET RESEARCH COVERAGE PLAN
Adaptive coverage: enabled
Coverage obligations: ${plan.obligations.join(", ") || "implementation_patterns"}
Preferred source mix: ${plan.recommendedSourceTypes.join(", ") || "implementation docs"}
Adaptive source target: ${plan.targetSourceCount}
Stop condition: do not stop once only stack docs are found; continue until the obligation list is materially represented in the evidence set.
Why these obligations: ${plan.rationale.join("; ") || "keep the research aligned to the declared target intent"}`;
}

function normalizeUrl(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    u.hash = "";
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return s.replace(/\/$/, "").toLowerCase();
  }
}

async function loadSeenScoutUrls(stateDir: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const [memoryRaw, prevScout] = await Promise.all([
    readJson(path.join(stateDir, SCOUT_SEEN_URLS_FILE), { urls: [] }),
    readJson(path.join(stateDir, "research_scout_output.json"), null),
  ]);

  const memoryUrls = Array.isArray(memoryRaw?.urls) ? memoryRaw.urls : [];
  for (const item of memoryUrls) {
    const n = normalizeUrl(String(item || ""));
    if (n) seen.add(n);
  }

  const prevSources = Array.isArray(prevScout?.sources) ? prevScout.sources : [];
  for (const source of prevSources) {
    const n = normalizeUrl(String((source as any)?.url || ""));
    if (n) seen.add(n);
  }

  return seen;
}

async function saveSeenScoutUrls(stateDir: string, seenUrls: Set<string>): Promise<void> {
  const cap = 5000;
  const urls = Array.from(seenUrls).slice(-cap);
  await writeJson(path.join(stateDir, SCOUT_SEEN_URLS_FILE), {
    updatedAt: new Date().toISOString(),
    count: urls.length,
    urls,
  });
}

function normalizeTopic(raw: string): string {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "general";
  return s
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "general";
}

function inferSourceTopics(source: Record<string, unknown>): string[] {
  const raw = (source as any)?.topicTags;
  if (Array.isArray(raw)) {
    const out = raw.map((t: unknown) => normalizeTopic(String(t || ""))).filter(Boolean);
    return out.length > 0 ? Array.from(new Set(out)).slice(0, 4) : ["general"];
  }
  if (typeof raw === "string") {
    const out = raw.split(/,\s*/).map(t => normalizeTopic(t)).filter(Boolean);
    return out.length > 0 ? Array.from(new Set(out)).slice(0, 4) : ["general"];
  }
  return ["general"];
}

function getSourceHost(source: Record<string, unknown>): string {
  const url = String((source as any)?.url || "").trim();
  if (!url) return "unknown";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

function topicSiteKey(site: string, topic: string): string {
  return `${site}::${topic}`;
}

function indexTopicSiteState(state: TopicSiteState): Map<string, TopicSiteEntry> {
  const map = new Map<string, TopicSiteEntry>();
  for (const e of Array.isArray(state.entries) ? state.entries : []) {
    const site = String(e?.site || "").toLowerCase() || "unknown";
    const topic = normalizeTopic(String(e?.topic || "general"));
    const key = topicSiteKey(site, topic);
    map.set(key, {
      site,
      topic,
      status: e?.status === "completed" ? "completed" : "in_progress",
      uniqueSourceCount: Math.max(0, Number(e?.uniqueSourceCount || 0)),
      lastSeenAt: String(e?.lastSeenAt || new Date(0).toISOString()),
      completedAt: e?.completedAt ? String(e.completedAt) : undefined,
    });
  }
  return map;
}

async function loadTopicSiteState(stateDir: string): Promise<TopicSiteState> {
  const raw = await readJson(path.join(stateDir, SCOUT_TOPIC_SITE_STATUS_FILE), {
    updatedAt: new Date(0).toISOString(),
    entries: [],
  });
  return {
    updatedAt: String(raw?.updatedAt || new Date(0).toISOString()),
    entries: Array.isArray(raw?.entries) ? raw.entries : [],
  };
}

async function saveTopicSiteState(stateDir: string, map: Map<string, TopicSiteEntry>): Promise<void> {
  const entries = Array.from(map.values())
    .sort((a, b) => (a.site + a.topic).localeCompare(b.site + b.topic));
  await writeJson(path.join(stateDir, SCOUT_TOPIC_SITE_STATUS_FILE), {
    updatedAt: new Date().toISOString(),
    entries,
  });
}

function buildBlockedSourcesSection(
  seenUrls: Set<string>,
  topicSiteState: TopicSiteState,
  maxUrls = 150,
): string {
  const entries = Array.isArray(topicSiteState.entries) ? topicSiteState.entries : [];
  const completed = entries.filter(e => e.status === "completed");

  const exhaustedLines = completed
    .sort((a, b) => b.uniqueSourceCount - a.uniqueSourceCount)
    .map(e => `  - ${e.site} [topic: ${e.topic}] - ${e.uniqueSourceCount} pages read (exhausted)`)
    .join("\n");

  const recent = Array.from(seenUrls).slice(-maxUrls);

  return [
    "## BLOCKED SOURCES - READ BEFORE ANY FETCH/SEARCH",
    "",
    "You MUST check this section before calling any web tool.",
    "Do NOT re-fetch URLs listed below.",
    "Do NOT search any exhausted site+topic pair listed below.",
    "Skip blocked items and focus only on NEW sources.",
    "",
    "### Exhausted topic+site pairs (do not search)",
    exhaustedLines || "  - none",
    "",
    `### Already fetched URLs (do not re-fetch) - ${seenUrls.size} total, showing last ${recent.length}`,
    recent.join("\n") || "  - none",
  ].join("\n");
}

function buildInProgressTopicsSection(state: TopicSiteState, maxEntries = 25): string {
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const active = entries
    .filter(e => e.status !== "completed")
    .sort((a, b) => b.uniqueSourceCount - a.uniqueSourceCount)
    .slice(0, maxEntries);

  const activeLines = active
    .map(e => `  - ${e.site} | topic: ${e.topic} - ${e.uniqueSourceCount} pages read`) 
    .join("\n");

  return [
    "## PARTIALLY EXPLORED TOPIC-SITE PAIRS",
    "These pairs are not exhausted yet. Continue only if high-value and still novel.",
    "",
    activeLines || "  - none",
  ].join("\n");
}

function liveLogPath(stateDir: string): string {
  return path.join(stateDir, "live_worker_research-scout.log");
}

function appendLiveLogSync(stateDir: string, text: string): void {
  try {
    appendFileSync(liveLogPath(stateDir), text, "utf8");
    appendAggregateLiveLogSync(stateDir, "research-scout", text);
  } catch { /* best-effort */ }
}

/**
 * Build the context prompt for the Research Scout.
 * Includes: system purpose, current bottlenecks, recent plans, recent improvements.
 */
async function buildScoutContext(config: any): Promise<string> {
  const stateDir = config.paths?.stateDir || "state";
  const scoutModel = config?.roleRegistry?.researchScout?.model || "gpt-5.3-codex";
  const promptTokenBudget = resolveMaxPromptBudget(
    config,
    String(scoutModel),
    Number(config?.runtime?.researchScoutPromptTokenBudget)
  );

  // Read system state to give Scout awareness of what BOX needs
  const [
    _prometheusAnalysis,
    janusDirective,
    capacityScoreboard,
    previousResearch,
    seenUrls,
    topicSiteState,
  ] = await Promise.all([
    readJson(path.join(stateDir, "prometheus_analysis.json"), null),
    readJson(path.join(stateDir, "janus_directive.json"), null),
    readJson(path.join(stateDir, "capacity_scoreboard.json"), null),
    readJson(path.join(stateDir, "research_scout_output.json"), null),
    loadSeenScoutUrls(stateDir),
    loadTopicSiteState(stateDir),
  ]);

  const sections: Array<{ name: string; content: string }> = [];
  const promptRuntime = resolvePromptRuntimeContext(config);
  const activeTargetSession = promptRuntime.activeTargetSession;

  if (seenUrls.size > 0 || topicSiteState.entries.length > 0) {
    sections.push(section("blocked-sources", buildBlockedSourcesSection(seenUrls, topicSiteState)));
  }
  if (topicSiteState.entries.some(e => e.status !== "completed")) {
    sections.push(section("in-progress-topics", buildInProgressTopicsSection(topicSiteState)));
  }

  // System identity and purpose
  if (promptRuntime.mode.effectiveMode === "single_target_delivery" && activeTargetSession) {
    sections.push(section("system-identity", `## SYSTEM CONTEXT
You are searching for knowledge for the active target repo while BOX remains the control plane.
BOX still runs the same loop: Janus (strategy) → Prometheus (planning) → Athena (review) → Workers (execution) → postmortem → repeat.
Your job is to find external knowledge that helps BOX deliver against the current target objective without rediscovering facts already held in session state.
Do NOT spend tokens producing repository file inventories; focus on external research evidence for the target repo's stack, integrations, blockers, and objective.`));

    sections.push(section("repo-goals-static", `## TARGET DELIVERY GOALS (CURRENT SESSION)
Active target repo: ${promptRuntime.targetRepo}
Objective: ${String(activeTargetSession.objective?.summary || "unknown")}
Current stage: ${String(activeTargetSession.currentStage || "unknown")}
Readiness: ${String(activeTargetSession.onboarding?.readiness || "pending")} (score=${String(activeTargetSession.onboarding?.readinessScore ?? 0)})
Recommended next stage: ${String(activeTargetSession.onboarding?.recommendedNextStage || "unknown")}
Required human inputs: ${(Array.isArray(activeTargetSession.handoff?.requiredHumanInputs) ? activeTargetSession.handoff.requiredHumanInputs : []).join(", ") || "none"}
Carried context: ${String(activeTargetSession.handoff?.carriedContextSummary || "none")}
Research should improve target delivery readiness and planning quality for this session, not BOX self-improvement in general.`));

    sections.push(section("target-intent-contract", buildTargetIntentResearchSection(activeTargetSession)));
    sections.push(section("target-research-mode", buildTargetResearchModeSection(activeTargetSession)));
    sections.push(section("target-research-coverage", buildTargetResearchCoverageSection(activeTargetSession)));
  } else {
    sections.push(section("system-identity", `## SYSTEM CONTEXT
You are searching for knowledge to improve BOX — an autonomous software delivery system.
BOX runs a continuous loop: Janus (strategy) → Prometheus (planning) → Athena (review) → Workers (execution) → postmortem → repeat.
The system evolves itself: it reads its own code, plans improvements, executes them, and measures results.
Your job is finding external knowledge that makes this system significantly better.
Do NOT spend tokens producing repository file inventories; focus on external research evidence.`));

    sections.push(section("repo-goals-static", `## REPOSITORY GOALS (STATIC)
This repository is the BOX orchestrator and worker runtime for autonomous software delivery.
Primary goal: increase end-to-end autonomous delivery capacity with production-oriented, minimal, reversible changes.
Key behavior targets for research relevance:
- Better planning quality and deeper reasoning under real constraints.
- Better worker execution reliability, verification quality, and recovery behavior.
- Better model utilization (quality-per-request, token efficiency, context strategy).
- Better governance and deterministic control loops without slowing delivery.
Treat these goals as fixed context. Do not generate file lists or repository inventories.`));
  }

  sections.push(...buildPromptAssemblySections({ agentName: "research-scout", config }));

  // Current system health and direction (lightweight — don't overload Scout)
  if (janusDirective?.thinking) {
    const thinking = String(janusDirective.thinking).slice(0, 500);
    sections.push(section("current-direction", `## CURRENT SYSTEM DIRECTION
Janus's latest strategic assessment (summary):
${thinking}`));
  }

  // Capacity dimensions — where the system is weak
  if (capacityScoreboard?.entries?.length > 0) {
    const latest = capacityScoreboard.entries[capacityScoreboard.entries.length - 1];
    if (latest?.dimensions) {
      const dims = Object.entries(latest.dimensions)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n");
      sections.push(section("capacity-state", `## CURRENT CAPACITY STATE
Latest capacity scores across dimensions:
${dims}
Focus your research on dimensions with the LOWEST scores — that's where knowledge has the most impact.`));
    }
  }

  // Previous research gap hints — what the Synthesizer said was missing
  if (previousResearch?.researchGaps) {
    sections.push(section("previous-gaps", `## PREVIOUS RESEARCH GAPS
The last Research Synthesizer identified these as missing topics. Consider searching for these:
${String(previousResearch.researchGaps).slice(0, 1000)}`));
  }

  return compilePrompt(sections, {
    tokenBudget: promptTokenBudget > 0 ? promptTokenBudget : undefined,
  });
}

export function buildTargetResearchSessionStamp(activeTargetSession: any): Record<string, unknown> | null {
  if (!activeTargetSession || typeof activeTargetSession !== "object") {
    return null;
  }

  const repoState = String(activeTargetSession?.intent?.repoState || activeTargetSession?.repoProfile?.repoState || "unknown").trim() || "unknown";
  const researchMode = repoState === "empty"
    ? "empty_repo_discovery"
    : repoState === "existing"
      ? "existing_repo_support"
      : "generic_target_research";

  return {
    projectId: activeTargetSession.projectId || null,
    sessionId: activeTargetSession.sessionId || null,
    currentStage: activeTargetSession.currentStage || null,
    repoState,
    intentStatus: activeTargetSession?.intent?.status || null,
    planningMode: activeTargetSession?.intent?.planningMode || null,
    researchMode,
  };
}

function buildTargetResearchModeSection(activeTargetSession: any): string {
  const stamp = buildTargetResearchSessionStamp(activeTargetSession);
  const researchMode = String(stamp?.researchMode || "generic_target_research");
  if (researchMode === "empty_repo_discovery") {
    return `## TARGET RESEARCH MODE
Mode: empty_repo_discovery
The target repository is effectively empty. Do NOT waste effort inferring a current stack from the repo.
Your job is to reduce build-direction uncertainty from the clarified product intent.
Prioritize a balanced evidence mix across:
- best-fit stack choices for this product type
- initial architecture shape and hosting/deployment for v1
- implementation and integration patterns that reduce delivery risk
- product-facing UX references, exemplars, and flow patterns when the target is user-visible
- media, responsive, trust, or accessibility evidence when those obligations are implied by the target intent
After research, BOX must move forward into planning in the same cycle. Do not behave as if research itself is the final stop.`;
  }

  if (researchMode === "existing_repo_support") {
    return `## TARGET RESEARCH MODE
Mode: existing_repo_support
The target repository already contains product material.
Prioritize:
- current stack constraints
- known integration behavior
- safe change patterns
- migration or extension risks
- evidence that helps BOX modify the repo without breaking protected areas`;
  }

  return `## TARGET RESEARCH MODE
Mode: generic_target_research
Use the target intent contract as the boundary. Reduce planning uncertainty directly and avoid unrelated exploration.`;
}

export function buildTargetIntentResearchSection(activeTargetSession: any): string {
  return `## TARGET INTENT CONTRACT
Intent status: ${String(activeTargetSession?.intent?.status || "pending")}
Intent summary: ${String(activeTargetSession?.intent?.summary || "none")}
Planning mode: ${String(activeTargetSession?.intent?.planningMode || "none")}
Product type: ${String(activeTargetSession?.intent?.productType || "none")}
Target users: ${(Array.isArray(activeTargetSession?.intent?.targetUsers) ? activeTargetSession.intent.targetUsers : []).join(", ") || "none"}
Must-have flows: ${(Array.isArray(activeTargetSession?.intent?.mustHaveFlows) ? activeTargetSession.intent.mustHaveFlows : []).join(", ") || "none"}
Scope in: ${(Array.isArray(activeTargetSession?.intent?.scopeIn) ? activeTargetSession.intent.scopeIn : []).join(", ") || "none"}
Scope out: ${(Array.isArray(activeTargetSession?.intent?.scopeOut) ? activeTargetSession.intent.scopeOut : []).join(", ") || "none"}
Protected areas: ${(Array.isArray(activeTargetSession?.intent?.protectedAreas) ? activeTargetSession.intent.protectedAreas : []).join(", ") || "none"}
Success criteria: ${(Array.isArray(activeTargetSession?.intent?.successCriteria) ? activeTargetSession.intent.successCriteria : []).join(", ") || "none"}
Open questions: ${(Array.isArray(activeTargetSession?.intent?.openQuestions) ? activeTargetSession.intent.openQuestions : []).join(", ") || "none"}
Research should directly reduce uncertainty around this contract. Do not broaden scope beyond the declared target intent.`;
}

/**
 * Parse structured sources from the Scout's raw text output.
 * Extracts source blocks with their metadata fields.
 */
function parseScoutSources(rawText: string): Array<Record<string, unknown>> {
  const sources: Array<Record<string, unknown>> = [];
  // Match source blocks: ### [Source N] or ### Source N
  const blocks = rawText.split(/###\s*\[?Source\s*\d+\]?\s*/i).filter(b => b.trim());

  for (const block of blocks) {
    const source: Record<string, unknown> = {};

    // Extract title from first line
    const firstLine = block.split("\n")[0]?.trim();
    if (firstLine) source.title = firstLine;

    // Extract fields
    const urlMatch = block.match(/\*?\*?URL\*?\*?:\s*(.+)/i);
    if (urlMatch) source.url = urlMatch[1].trim();

    const typeMatch = block.match(/\*?\*?Source\s*Type\*?\*?:\s*(.+)/i);
    if (typeMatch) source.sourceType = typeMatch[1].trim();

    const dateMatch = block.match(/\*?\*?Date\*?\*?:\s*(.+)/i);
    if (dateMatch) source.date = dateMatch[1].trim();

    const tagsMatch = block.match(/\*?\*?Topic\s*Tags\*?\*?:\s*(.+)/i);
    if (tagsMatch) source.topicTags = tagsMatch[1].trim().split(/,\s*/);

    const confMatch = block.match(/\*?\*?Confidence\s*Score\*?\*?:\s*([\d.]+)/i);
    if (confMatch) source.confidenceScore = parseFloat(confMatch[1]);

    const whyMatch = block.match(/\*?\*?Why\s*Important\*?\*?:\s*(.+)/i);
    if (whyMatch) source.whyImportant = whyMatch[1].trim();

    const knowledgeTypeMatch = block.match(/\*?\*?Knowledge\s*Type\*?\*?:\s*(.+)/i);
    if (knowledgeTypeMatch) source.knowledgeType = knowledgeTypeMatch[1].trim().toLowerCase();

    // Extract key findings (legacy format: bullet points after "Key Findings:")
    const findingsMatch = block.match(/\*?\*?Key\s*Findings\*?\*?:\s*\n([\s\S]*?)(?=\n###|\n\*\*|$)/i);
    if (findingsMatch) {
      source.keyFindings = findingsMatch[1]
        .split("\n")
        .map(l => l.replace(/^[\s-*•]+/, "").trim())
        .filter(l => l.length > 0);
    }

    // Extract learning note (new format: structured knowledge note after "Learning Note:")
    const lnMatch = block.match(/\*?\*?Learning\s*Note\*?\*?:\s*\n([\s\S]*?)(?=\n-\s*\*\*Extracted|\n\*\*Extracted|\n###|\n\*\*\s*URL|\n-\s*\*\*URL|$)/i);
    if (lnMatch) {
      source.learningNote = lnMatch[1].trim();
    }

    // Extract full content (new format: free-form text after "Extracted Content:")
    const ecMatch = block.match(/\*?\*?Extracted\s*Content\*?\*?:\s*\n([\s\S]*?)(?=\n###|\n\*\*\s*URL|\n-\s*\*\*URL|$)/i);
    if (ecMatch) {
      source.extractedContent = ecMatch[1].trim();
    }

    if (source.url || source.title) {
      sources.push(source);
    }
  }

  return sources;
}

export interface ResearchScoutResult {
  success: boolean;
  sourceCount: number;
  sources: Array<Record<string, unknown>>;
  rawText: string;
  scoutedAt: string;
  model: string;
  targetSession?: Record<string, unknown> | null;
  coveragePlan?: TargetResearchCoveragePlan | null;
  error?: string;
}

/**
 * Run the Research Scout — 1 premium request.
 *
 * The Scout searches the open internet for knowledge valuable to BOX,
 * ranks findings by importance, and outputs a structured research package.
 */
export async function runResearchScout(config: any): Promise<ResearchScoutResult> {
  const stateDir = config.paths?.stateDir || "state";
  const command = config.env?.copilotCliCommand || "copilot";
  const model = config.roleRegistry?.researchScout?.model || "gpt-5.3-codex";
  const disablePromptCache = config?.runtime?.researchScoutDisableCache !== false;
  const runNonce = disablePromptCache
    ? `research-scout-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    : "research-scout";
  const promptRuntime = resolvePromptRuntimeContext(config);
  const targetResearchPlan = promptRuntime.mode.effectiveMode === "single_target_delivery"
    ? deriveTargetResearchCoveragePlan(promptRuntime.activeTargetSession)
    : null;
  const configuredTargetSourceCount = Number.isFinite(Number(config?.runtime?.researchScoutTargetSources))
    ? Math.max(1, Number(config.runtime.researchScoutTargetSources))
    : null;
  const derivedTargetSourceCount = targetResearchPlan?.targetSourceCount ?? 20;
  const targetSourceCount = configuredTargetSourceCount !== null
    ? Math.min(configuredTargetSourceCount, derivedTargetSourceCount)
    : derivedTargetSourceCount;
  const topicSiteCompletionThreshold = Number.isFinite(Number(config?.runtime?.researchScoutTopicSiteCompletionThreshold))
    ? Math.max(2, Number(config.runtime.researchScoutTopicSiteCompletionThreshold))
    : 8;

  const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

  // Initialize live log
  try {
    await fs.writeFile(liveLogPath(stateDir), `[research_scout_live]\n[${ts()}] Research Scout starting...\n`, "utf8");
  } catch { /* best-effort */ }

  await appendProgress(config, "[RESEARCH_SCOUT] Starting internet knowledge acquisition");
  await appendProgress(config, `[RESEARCH_SCOUT][CACHE_POLICY] promptCache=${disablePromptCache ? "disabled(via nonce)" : "enabled"}`);
  if (targetResearchPlan) {
    await appendProgress(
      config,
      `[RESEARCH_SCOUT][COVERAGE_PLAN] obligations=${targetResearchPlan.obligations.join(",") || "none"} sourceTypes=${targetResearchPlan.recommendedSourceTypes.join(",") || "none"} targetSources=${targetSourceCount}`
    );
  }

  // Build context prompt
  const contextPrompt = await buildScoutContext(config);
  await appendProgress(config, `[RESEARCH_SCOUT][CONTEXT_BUDGET] prompt~${estimateTokens(contextPrompt)} tokens maxCapacityMode=${config?.runtime?.maxCapacityMode === true}`);

  const taskObjective = targetResearchPlan
    ? `Search for the most valuable external evidence that helps BOX deliver the active target repo successfully.
Do NOT stop after collecting only stack or framework docs.
Materially cover these obligation areas: ${targetResearchPlan.obligations.join(", ")}.
Prefer a balanced mix of ${targetResearchPlan.recommendedSourceTypes.join(", ")}.
Target at least ${targetSourceCount} high-quality sources when evidence allows; only return fewer if genuinely no additional strong sources are accessible.`
    : `Search the internet for the most valuable technical knowledge that can advance this autonomous agent system.
Use your full capacity — search as many different angles as you can.
Target at least ${targetSourceCount} high-quality sources when evidence allows; only return fewer if genuinely no additional strong sources are accessible.`;

  const fullPrompt = `${contextPrompt}

## YOUR TASK
${taskObjective}
Rank your findings by importance — most valuable first.
If native web search/fetch tools are unavailable, use execute tool with shell HTTP commands (curl/Invoke-WebRequest) to retrieve web pages and continue.
Follow the output format specified in your agent definition exactly.`;

  const cacheBypassPrefix = disablePromptCache
    ? `\n\n## RUN NONCE\n${runNonce}\nTreat this run nonce as immutable metadata for this execution.\n`
    : "";

  const contextPromptFinal = `${fullPrompt}${cacheBypassPrefix}`;

  // Build args — Scout needs --allow-all for web search/fetch tools
  const args = buildAgentArgs({
    agentSlug: "research-scout",
    prompt: contextPromptFinal,
    model,
    allowAll: true,
    maxContinues: undefined,
  });

  appendLiveLogSync(stateDir, `\n[scout_start] ${ts()}\n`);

  const result = await spawnAsync(command, args, {
    env: process.env,
    onStdout(chunk: Buffer) {
      appendLiveLogSync(stateDir, chunk.toString("utf8"));
    },
    onStderr(chunk: Buffer) {
      appendLiveLogSync(stateDir, chunk.toString("utf8"));
    },
  });

  appendLiveLogSync(stateDir, `\n[scout_end] ${ts()} exit=${(result as any).status}\n`);

  const stdout = String((result as any)?.stdout || "");
  const stderr = String((result as any)?.stderr || "");
  const raw = stdout || stderr;
  await appendAgentContextUsage(config, {
    agent: "research-scout",
    model: String(model || "gpt-5.3-codex"),
    promptText: contextPromptFinal,
    status: (result as any).status === 0 ? "success" : "failed",
  });

  if ((result as any).status !== 0) {
    const error = `exited ${(result as any).status}: ${(stderr || stdout).slice(0, 500)}`;
    await appendProgress(config, `[RESEARCH_SCOUT] Failed — ${error}`);
    return {
      success: false,
      sourceCount: 0,
      sources: [],
      rawText: raw,
      scoutedAt: new Date().toISOString(),
      model,
      targetSession: buildTargetResearchSessionStamp(config?.activeTargetSession),
      coveragePlan: targetResearchPlan,
      error,
    };
  }

  // Parse sources from the raw output and filter previously-seen URLs
  const parsedSources = parseScoutSources(raw);
  const seenUrls = await loadSeenScoutUrls(stateDir);
  const topicSiteState = await loadTopicSiteState(stateDir);
  const topicSiteMap = indexTopicSiteState(topicSiteState);
  const sources: Array<Record<string, unknown>> = [];
  let filteredRepeatCount = 0;
  let filteredCompletedPairCount = 0;
  const newlyCompletedPairs = new Set<string>();
  for (const source of parsedSources) {
    const normalized = normalizeUrl(String((source as any)?.url || ""));

    const host = getSourceHost(source);
    const topics = inferSourceTopics(source);
    const isCompletedPair = topics.some(topic => {
      const key = topicSiteKey(host, topic);
      const entry = topicSiteMap.get(key);
      return entry?.status === "completed";
    });
    if (isCompletedPair) {
      filteredCompletedPairCount += 1;
      continue;
    }

    if (normalized && seenUrls.has(normalized)) {
      filteredRepeatCount += 1;
      continue;
    }
    if (normalized) seenUrls.add(normalized);
    sources.push(source);

    const nowIso = new Date().toISOString();
    for (const topic of topics) {
      const key = topicSiteKey(host, topic);
      const current = topicSiteMap.get(key) || {
        site: host,
        topic,
        status: "in_progress" as const,
        uniqueSourceCount: 0,
        lastSeenAt: nowIso,
      };
      const nextCount = current.uniqueSourceCount + 1;
      const nextStatus: "in_progress" | "completed" =
        current.status === "completed" || nextCount >= topicSiteCompletionThreshold
          ? "completed"
          : "in_progress";
      if (current.status !== "completed" && nextStatus === "completed") {
        newlyCompletedPairs.add(`${host} | ${topic}`);
      }
      topicSiteMap.set(key, {
        ...current,
        status: nextStatus,
        uniqueSourceCount: nextCount,
        lastSeenAt: nowIso,
        completedAt: nextStatus === "completed" ? (current.completedAt || nowIso) : undefined,
      });
    }
  }
  await saveSeenScoutUrls(stateDir, seenUrls);
  await saveTopicSiteState(stateDir, topicSiteMap);

  await appendProgress(
    config,
    `[RESEARCH_SCOUT][YIELD] parsed=${parsedSources.length} uniqueNew=${sources.length} filteredRepeat=${filteredRepeatCount} filteredCompletedPair=${filteredCompletedPairCount}`
  );
  if (newlyCompletedPairs.size > 0) {
    const sample = Array.from(newlyCompletedPairs).slice(0, 8).join("; ");
    await appendProgress(
      config,
      `[RESEARCH_SCOUT][TOPIC_SITE_COMPLETED] count=${newlyCompletedPairs.size} sample=${sample}`
    );
  }

  const output: ResearchScoutResult = {
    success: true,
    sourceCount: sources.length,
    sources,
    rawText: raw,
    scoutedAt: new Date().toISOString(),
    model,
    targetSession: buildTargetResearchSessionStamp(config?.activeTargetSession),
    coveragePlan: targetResearchPlan,
  };

  // Persist raw research package
  await writeJson(path.join(stateDir, "research_scout_output.json"), output);

  if (filteredRepeatCount > 0) {
    await appendProgress(config, `[RESEARCH_SCOUT][DEDUPE] Filtered ${filteredRepeatCount} previously-seen source(s)`);
  }

  if (sources.length < targetSourceCount) {
    await appendProgress(config,
      `[RESEARCH_SCOUT][LOW_YIELD] Found ${sources.length}/${targetSourceCount} target source(s) — continue improving query breadth/depth next cycle`
    );
  }

  await appendProgress(config, `[RESEARCH_SCOUT] Complete — found ${sources.length} source(s)`);

  return output;
}

