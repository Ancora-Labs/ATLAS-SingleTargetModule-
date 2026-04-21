/**
 * Research Synthesizer — Knowledge Compression Engine
 *
 * Takes the Research Scout's raw findings and produces a structured,
 * topic-organized synthesis for Prometheus. Uses 1 premium request.
 *
 * Rules:
 *   - Does NOT lose useful information
 *   - Compresses FORMAT, not CONTENT
 *   - Groups by topic, not by source
 *   - Surfaces contradictions explicitly
 *   - Preserves technical details (algorithms, libraries, metrics)
 *
 * Output: synthesized research in state/research_synthesis.json
 * Live log: state/live_worker_research-synthesizer.log
 */

import path from "node:path";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { readJson, writeJson, spawnAsync } from "./fs_utils.js";
import { appendProgress } from "./state_tracker.js";
import { buildAgentArgs } from "./agent_loader.js";
import { section, compilePrompt } from "./prompt_compiler.js";
import { appendAgentContextUsage, resolveMaxPromptBudget } from "./context_usage.js";
import { appendAggregateLiveLogSync } from "./live_log.js";
import { buildPromptAssemblySections } from "./prompt_overlay.js";
import { deriveTargetResearchCoveragePlan, type TargetResearchCoveragePlan } from "./research_scout.js";

function liveLogPath(stateDir: string): string {
  return path.join(stateDir, "live_worker_research-synthesizer.log");
}

function appendLiveLogSync(stateDir: string, text: string): void {
  try {
    appendFileSync(liveLogPath(stateDir), text, "utf8");
    appendAggregateLiveLogSync(stateDir, "research-synthesizer", text);
  } catch { /* best-effort */ }
}

/**
 * Parse structured topic sections from the Synthesizer's raw text output.
 *
 * New format (librarian model):
 *   ## Topic: <name>
 *   **Topic Metadata:** freshness, avg confidence, source count
 *   **Sources:** each with ### <title>, URL, Date, Confidence, isDuplicate, **Extracted Content:**
 *
 * Also supports legacy format (Net Findings / Applicable Ideas) for backward compat.
 *
 * Rescue path: when a topic block carries raw unstructured prose but matches no
 * structured pattern, the block text is captured as a synthetic source's
 * `scoutFindings` so the density check can still pass.
 */
export function parseSynthesisTopics(rawText: string): Array<Record<string, unknown>> {
  const topics: Array<Record<string, unknown>> = [];

  // Strip tool call log noise — find where the actual synthesis begins.
  // The synthesis always starts with "## Research Synthesis" or the first "## Topic:".
  const synthStart = (() => {
    const h = rawText.indexOf("## Research Synthesis");
    const t = rawText.indexOf("## Topic:");
    if (h !== -1 && t !== -1) return Math.min(h, t);
    if (h !== -1) return h;
    if (t !== -1) return t;
    return 0;
  })();
  const cleanText = rawText.slice(synthStart);

  // Split by topic headers: ## Topic: <name>
  const blocks = cleanText.split(/##\s*Topic:\s*/i).filter(b => b.trim());

  for (const block of blocks) {
    const topic: Record<string, unknown> = {};
    // Normalize common heading punctuation variants so downstream regexes stay stable.
    // Examples:
    //   **Scout's Findings:**  -> **Scout's Findings**:
    //   Scout’s               -> Scout's
    //   Prometheus‑Ready      -> Prometheus-Ready
    const normalizedBlock = block
      .replace(/\*\*([^*\n]+?):\*\*/g, "**$1**:")
      .replace(/[’]/g, "'")
      .replace(/[‐‑‒–—]/g, "-");

    // Topic name is the first line
    const firstLine = normalizedBlock.split("\n")[0]?.trim();
    if (firstLine) topic.topic = firstLine;

    // Skip synthesis header/preamble artefacts that can appear before first real topic.
    if (typeof topic.topic === "string" && /^##\s*Research\s*Synthesis\s*Header/i.test(topic.topic)) {
      continue;
    }

    // ── New librarian format: Topic Metadata ──
    const freshnessMatch = normalizedBlock.match(/\*?\*?Freshness\*?\*?:\s*(.+)/i);
    if (freshnessMatch) topic.freshness = freshnessMatch[1].trim();

    const avgConfMatch = normalizedBlock.match(/\*?\*?Average\s*Confidence\*?\*?:\s*([\d.]+)/i);
    if (avgConfMatch) topic.confidence = avgConfMatch[1].trim();

    const srcCountMatch = normalizedBlock.match(/\*?\*?Source\s*Count\*?\*?:\s*(\d+)/i);
    if (srcCountMatch) topic.sourceCount = parseInt(srcCountMatch[1], 10);

    // ── Parse individual sources within this topic ──
    const sourceBlocks = normalizedBlock.split(/###\s+/).filter(b => b.trim());
    const sources: Array<Record<string, unknown>> = [];
    for (const sb of sourceBlocks) {
      const normalizedSb = sb.replace(/\*\*([^*\n]+?):\*\*/g, "**$1**:");
      const source: Record<string, unknown> = {};
      const sbFirstLine = normalizedSb.split("\n")[0]?.trim();
      if (!sbFirstLine) continue;
      source.title = sbFirstLine;

      const urlMatch = normalizedSb.match(/[-*]*\s*URL:\s*(.+)/i);
      if (urlMatch) source.url = urlMatch[1].trim();

      const dateMatch = normalizedSb.match(/[-*]*\s*Date:\s*(.+)/i);
      if (dateMatch) source.date = dateMatch[1].trim();

      const confMatch = normalizedSb.match(/[-*]*\s*Confidence:\s*([\d.]+)/i);
      if (confMatch) source.confidence = parseFloat(confMatch[1]);

      const dupMatch = normalizedSb.match(/[-*]*\s*isDuplicate:\s*(true|false)/i);
      if (dupMatch) source.isDuplicate = dupMatch[1].toLowerCase() === "true";

      // Extracted Content: grab everything after the marker until next ### or end
      const ecMatch = normalizedSb.match(/\*?\*?Extracted\s*Content\*?\*?:\s*\n([\s\S]*?)(?=\n---|\n###|$)/i);
      if (ecMatch) {
        source.extractedContent = ecMatch[1].trim();
      }

      // New enricher format: Scout's Findings (verbatim), Synthesizer Enrichment, Prometheus-Ready Summary
      const scoutFindingsMatch = normalizedSb.match(/\*?\*?Scout(?:'|’)?s?\s*Findings\*?\*?:\s*(?:\n|\r\n)?([\s\S]*?)(?=\n\*?\*?Synthesizer\s*Enrichment\b|\n---\s*\n|\n###|$)/i);
      if (scoutFindingsMatch) {
        source.scoutFindings = scoutFindingsMatch[1].trim();
      }

      const enrichmentMatch = normalizedSb.match(/\*?\*?Synthesizer\s*Enrichment\*?\*?:\s*(?:\n|\r\n)?([\s\S]*?)(?=\n\*?\*?Prometheus[-‑–—]?Ready\s*Summary\b|\n---\s*\n|\n###|$)/i);
      if (enrichmentMatch) {
        source.synthesizerEnrichment = enrichmentMatch[1].trim();
      }

      const prometheusMatch = normalizedSb.match(/\*?\*?Prometheus[-‑–—]?Ready\s*Summary\*?\*?:\s*(?:\n|\r\n)?([\s\S]*?)(?=\n---\s*\n|\n###|$)/i);
      if (prometheusMatch) {
        source.prometheusReadySummary = prometheusMatch[1].trim();
      }

      const ktMatch = normalizedSb.match(/[-*]*\s*Knowledge\s*Type:\s*(.+)/i);
      if (ktMatch) source.knowledgeType = ktMatch[1].trim().toLowerCase();

      const hasMeaningfulPayload = Boolean(
        source.url
        || source.extractedContent
        || source.scoutFindings
        || source.synthesizerEnrichment
        || source.prometheusReadySummary
      );
      if (hasMeaningfulPayload) {
        sources.push(source);
      }
    }
    if (sources.length > 0) {
      topic.sources = sources;
      topic.sourceList = sources.map(s => String(s.url || s.title || "")).filter(Boolean);
    }

    // ── Legacy format support: Net Findings / Applicable Ideas ──
    const findingsMatch = normalizedBlock.match(/\*?\*?Net\s*Findings\*?\*?:\s*\n([\s\S]*?)(?=\n\*?\*?Applicable|$)/i);
    if (findingsMatch) {
      topic.netFindings = findingsMatch[1]
        .split("\n")
        .map(l => l.replace(/^[\s-*•]+/, "").trim())
        .filter(l => l.length > 0);
    }

    const ideasMatch = normalizedBlock.match(/\*?\*?Applicable\s*Ideas\s*for\s*BOX\*?\*?:\s*\n([\s\S]*?)(?=\n\*?\*?Risks|$)/i);
    if (ideasMatch) {
      topic.applicableIdeas = ideasMatch[1]
        .split("\n")
        .map(l => l.replace(/^[\s-*•]+/, "").trim())
        .filter(l => l.length > 0);
    }

    const risksMatch = normalizedBlock.match(/\*?\*?Risks\*?\*?:\s*\n([\s\S]*?)(?=\n\*?\*?Conflicting|$)/i);
    if (risksMatch) {
      topic.risks = risksMatch[1]
        .split("\n")
        .map(l => l.replace(/^[\s-*•]+/, "").trim())
        .filter(l => l.length > 0);
    }

    const conflictsMatch = normalizedBlock.match(/\*?\*?Conflicting\s*Views\*?\*?:\s*\n([\s\S]*?)(?=\n\*?\*?Confidence|$)/i);
    if (conflictsMatch) {
      topic.conflictingViews = conflictsMatch[1]
        .split("\n")
        .map(l => l.replace(/^[\s-*•]+/, "").trim())
        .filter(l => l.length > 0);
    }

    // Legacy confidence field (if not already set by new format)
    if (!topic.confidence) {
      const legacyConfMatch = normalizedBlock.match(/\*?\*?Confidence\*?\*?:\s*(.+)/i);
      if (legacyConfMatch) topic.confidence = legacyConfMatch[1].trim();
    }

    // Legacy sources list (if not already set by new format)
    if (!topic.sourceList) {
      const sourcesMatch = normalizedBlock.match(/\*?\*?Sources\*?\*?:\s*\n([\s\S]*?)(?=\n##|$)/i);
      if (sourcesMatch) {
        topic.sourceList = sourcesMatch[1]
          .split("\n")
          .map(l => l.replace(/^[\s-*•]+/, "").trim())
          .filter(l => l.length > 0);
      }
    }

    // ── Rescue path: raw unstructured text ──────────────────────────────────────
    // When no structured signals were captured (no sources, no net findings, no
    // applicable ideas), extract the raw prose from the block and inject it as
    // `scoutFindings` of a synthetic source so the density check can still pass.
    const hasActionableSignal = Boolean(
      (Array.isArray(topic.sources) && (topic.sources as unknown[]).length > 0)
      || (Array.isArray(topic.netFindings) && (topic.netFindings as unknown[]).length > 0)
      || (Array.isArray(topic.applicableIdeas) && (topic.applicableIdeas as unknown[]).length > 0)
    );
    if (!hasActionableSignal) {
      const rescueLines = block
        .split("\n")
        .slice(1) // skip topic-name line
        .filter(l => {
          const t = l.trim();
          return t.length > 20
            && !/^\*?\*?(Freshness|Average\s*Confidence|Source\s*Count|Sources?)\*?\*?:/i.test(t)
            && !t.startsWith("##")
            && !t.startsWith("**Topic");
        });
      const rescuedText = rescueLines.slice(0, 5).join(" ").replace(/\s+/g, " ").trim();
      if (rescuedText) {
        topic.sources = [{ title: String(topic.topic || ""), scoutFindings: rescuedText }];
      } else if (String(topic.topic || "").length > 20) {
        // Fallback: use the topic name itself as minimal signal when the block
        // contains only metadata lines (freshness/confidence) and no extractable prose.
        // Topic names > 20 chars are specific enough to constitute an actionable signal.
        const topicName = String(topic.topic);
        topic.sources = [{ title: topicName, scoutFindings: topicName }];
      }
    }

    // Only retain topics that carry at least one actionable signal after rescue.
    // Topics with no sources, no netFindings, and no applicableIdeas are dropped
    // so they do not pollute the quality gate or trigger degraded planning mode.
    const hasFinalSignal = (
      (Array.isArray(topic.sources) && (topic.sources as unknown[]).length > 0)
      || (Array.isArray(topic.netFindings) && (topic.netFindings as unknown[]).length > 0)
      || (Array.isArray(topic.applicableIdeas) && (topic.applicableIdeas as unknown[]).length > 0)
    );
    if (topic.topic && hasFinalSignal) {
      topics.push(topic);
    }
  }

  return topics;
}

/**
 * Extract research gaps section from synthesizer output.
 */
function extractResearchGaps(rawText: string): string {
  const gapsMatch = rawText.match(/##\s*Research\s*Gaps?\s*\n([\s\S]*?)(?=\n##|$)/i);
  return gapsMatch ? gapsMatch[1].trim() : "";
}

/**
 * Extract cross-topic connections from synthesizer output.
 * Returns an array of connection strings (fixes previous bug where this was a flat string).
 */
function extractCrossTopicConnections(rawText: string): string[] {
  const connMatch = rawText.match(/##\s*Cross[- ]Topic\s*Connections?\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (!connMatch) return [];
  return connMatch[1]
    .split("\n")
    .map(l => l.replace(/^[\s-*•\d.]+/, "").trim())
    .filter(l => l.length > 0);
}

const MAX_SYNTHESIS_TOPICS = 20;
const MAX_TOPIC_SOURCES = 6;
const MAX_TOPIC_TEXT = 280;
const MAX_RESEARCH_GAPS = 2000;
const MAX_CONNECTIONS = 20;
const MAX_PLANNER_SIGNALS = 12;

/** Minimum number of actionable signals required per topic to pass the quality gate. */
const SYNTHESIS_MIN_ACTIONABLE_DENSITY_PER_TOPIC = 1;

/**
 * Minimum character length for a string to count as an actionable signal in density
 * scoring.  A string shorter than this threshold (e.g. "ok", "x") is noise, not signal.
 * Exported so callers and tests can align on the same floor.
 */
export const SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH = 5;

// ─── Deterministic applicability scoring ──────────────────────────────────────
//
// Research topics that describe non-BOX runtime platforms produce planning
// pressure without execution path — they must be identified deterministically
// and excluded from the Prometheus planning prompt.
//
// BOX runtime: Node.js/TypeScript/ESM process, Copilot CLI agent dispatch,
// GitHub Actions, npm ecosystem.  It does NOT run Temporal workflows,
// Kubernetes workloads, Go routines, JVM services, or serverless functions.

/** Non-BOX platform detection rules. Each rule matches a specific external runtime. */
const NON_PLATFORM_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly platform: string;
  readonly reason: string;
}> = [
  {
    pattern: /\btemporal\b|\btemporal\.io\b/i,
    platform: "Temporal.io",
    reason: "BOX does not run Temporal workflows; applying this API requires a runtime migration",
  },
  {
    pattern: /\bkubernetes\b|\bk8s\b|\bkubectl\b|\bhelmchart\b|\bhelm chart\b/i,
    platform: "Kubernetes",
    reason: "BOX is a Node.js CLI orchestrator, not a Kubernetes workload",
  },
  {
    pattern: /\bgoroutine\b|\bgolang\b|\bgo\s+channel\b|\bgo\s+runtime\b/i,
    platform: "Go runtime",
    reason: "BOX is implemented in TypeScript/Node.js, not Go",
  },
  {
    pattern: /\bspring\s*boot\b|\bjvm\b|\bjava\s+stream\b|\bgradle\b|\bmaven\b/i,
    platform: "JVM/Java",
    reason: "BOX runtime is Node.js/TypeScript, not JVM-based",
  },
  {
    pattern: /\baws\s+lambda\b|\bserverless\s+function\b|\blambda\s+function\b/i,
    platform: "AWS Lambda/Serverless",
    reason: "BOX is a long-running process, not a serverless function",
  },
];

/** BOX runtime indicator patterns — confirm the topic is relevant to this codebase. */
const BOX_PLATFORM_INDICATORS: ReadonlyArray<RegExp> = [
  /\bnode\.js\b|\bnodejs\b/i,
  /\btsconfig\b/i,           // BOX-specific TS project config (not standalone "TypeScript" which is too generic)
  /\bcopilot\s*(?:cli|agent|cloud\s*agent)\b/i,
  /\bgithub\s+(?:actions|copilot)\b/i,
  /\bsrc\/core\b/i,
  /\.agent\.md\b/i,
  /\bnpm\s+(?:run|install|test)\b/i,
];

export type TopicApplicabilityVerdict = "applicable" | "not_applicable" | "conditionally_applicable";

export interface TopicApplicabilityResult {
  verdict: TopicApplicabilityVerdict;
  /** 0.0 = not applicable, 0.4 = conditional, 1.0 = fully applicable */
  score: number;
  /** Human-readable evidence for the verdict */
  evidence: string[];
  /** Non-BOX platform identified, if any */
  detectedPlatform?: string;
}

/**
 * Score a research topic for applicability to the BOX platform.
 *
 *   - "not_applicable":             topic describes a non-BOX runtime with no
 *                                   BOX-relevant signals — exclude from planning.
 *   - "conditionally_applicable":   topic has non-platform content or the
 *                                   synthesizer flagged it LOW but some
 *                                   BOX-relevant signals exist.
 *   - "applicable":                 no non-platform patterns detected.
 *
 * The verdict is deterministic and based solely on static pattern matching
 * over the topic's aggregated text content.
 */
export function scoreTopicApplicability(topic: Record<string, unknown>): TopicApplicabilityResult {
  // Aggregate all text content for pattern matching
  const parts: string[] = [
    String(topic.topic || ""),
    String(topic.prometheusReadySummary || ""),
  ];
  const sources = Array.isArray(topic.sources) ? topic.sources as Array<Record<string, unknown>> : [];
  for (const src of sources) {
    parts.push(String(src.url || ""));
    parts.push(String(src.title || ""));
    parts.push(String(src.prometheusReadySummary || "").slice(0, 500));
    parts.push(String(src.scoutFindings || "").slice(0, 400));
  }
  const allText = parts.join(" ");

  const matchedRules = NON_PLATFORM_RULES.filter(r => r.pattern.test(allText));
  const hasBoxIndicators = BOX_PLATFORM_INDICATORS.some(p => p.test(allText));
  const synthMarkedLow = /relevance\s*:\s*low/i.test(allText);

  if (matchedRules.length === 0 && !synthMarkedLow) {
    return { verdict: "applicable", score: 1.0, evidence: ["No non-platform patterns detected"] };
  }

  if (matchedRules.length > 0) {
    const evidence = matchedRules.map(r => `Detected ${r.platform}: ${r.reason}`);
    if (synthMarkedLow) evidence.push("Synthesizer marked this topic as 'Relevance: LOW'");

    if (hasBoxIndicators) {
      return {
        verdict: "conditionally_applicable",
        score: 0.4,
        evidence: [...evidence, "Some BOX-relevant patterns also present; concept may transfer"],
        detectedPlatform: matchedRules[0].platform,
      };
    }

    return {
      verdict: "not_applicable",
      score: 0.0,
      evidence,
      detectedPlatform: matchedRules[0].platform,
    };
  }

  // Synthesizer flagged LOW but no hard platform mismatch
  return {
    verdict: "conditionally_applicable",
    score: 0.4,
    evidence: ["Synthesizer marked this topic as 'Relevance: LOW' — no explicit platform mismatch"],
  };
}

// ─── end applicability scoring ────────────────────────────────────────────────

export interface SynthesisTopicDensity {
  topic: string;
  /** Count of non-empty actionable signals: netFindings + applicableIdeas + prometheusReadySummary entries */
  actionableCount: number;
  passed: boolean;
}

export interface TargetCoverageAssessment {
  passed: boolean;
  requiredObligations: string[];
  coveredObligations: string[];
  missingObligations: string[];
}

const OBLIGATION_COVERAGE_RULES: Readonly<Record<string, readonly RegExp[]>> = Object.freeze({
  implementation_patterns: [/\bimplementation\b/i, /\bintegration\b/i, /\barchitecture\b/i, /\bsetup\b/i, /\bdeploy(?:ment)?\b/i, /\bnext\.js\b/i, /\breact\b/i, /\btailwind\b/i, /\bapi\b/i],
  architecture_foundation: [/\barchitecture\b/i, /\bhosting\b/i, /\bdeployment\b/i, /\bstack\b/i, /\bfoundation\b/i, /\bapp router\b/i],
  user_flow_clarity: [/\bflow\b/i, /\bcta\b/i, /\bjourney\b/i, /\bnavigation\b/i, /\bform\b/i, /\bbooking\b/i, /\bcheckout\b/i, /\breservation\b/i, /\bfunnel\b/i],
  visual_design: [/\bvisual\b/i, /\bhero\b/i, /\bbrand(?:ed|ing)?\b/i, /\bdesign system\b/i, /\blayout\b/i, /\blook and feel\b/i, /\bpremium\b/i],
  media_surfaces: [/\bimage\b/i, /\bimages\b/i, /\bphoto(?:graphy)?\b/i, /\bgallery\b/i, /\bvideo\b/i, /\billustration\b/i, /\basset\b/i],
  responsive_experience: [/\bresponsive\b/i, /\bmobile\b/i, /\bbreakpoint\b/i, /\bviewport\b/i, /\badaptive\b/i, /\bdesktop\b/i],
  trust_signals: [/\btrust\b/i, /\btestimonial\b/i, /\breview\b/i, /\brating\b/i, /\bfaq\b/i, /\bsocial\s+proof\b/i, /\bguarantee\b/i],
  accessibility_clarity: [/\baccessibility\b/i, /\ba11y\b/i, /\bkeyboard\b/i, /\bcontrast\b/i, /\bsemantic\b/i, /\baria\b/i],
});

function collectTopicCoverageText(topic: Record<string, unknown>): string {
  const parts: string[] = [
    String(topic.topic || ""),
    ...(Array.isArray(topic.netFindings) ? topic.netFindings.map((value) => String(value || "")) : []),
    ...(Array.isArray(topic.applicableIdeas) ? topic.applicableIdeas.map((value) => String(value || "")) : []),
    String(topic.prometheusReadySummary || ""),
  ];
  const sources = Array.isArray(topic.sources) ? topic.sources as Array<Record<string, unknown>> : [];
  for (const src of sources) {
    parts.push(String(src.title || ""));
    parts.push(String(src.scoutFindings || ""));
    parts.push(String(src.prometheusReadySummary || ""));
    parts.push(String(src.extractedContent || ""));
  }
  return parts.join(" ").toLowerCase();
}

export function assessTargetCoverageObligations(
  topics: Array<Record<string, unknown>>,
  coveragePlan?: TargetResearchCoveragePlan | null,
): TargetCoverageAssessment {
  const requiredObligations = Array.isArray(coveragePlan?.obligations)
    ? Array.from(new Set(coveragePlan!.obligations.map((value) => String(value || "").trim()).filter(Boolean)))
    : [];

  if (requiredObligations.length === 0) {
    return {
      passed: true,
      requiredObligations: [],
      coveredObligations: [],
      missingObligations: [],
    };
  }

  const aggregateText = topics.map((topic) => collectTopicCoverageText(topic)).join(" \n ");
  const coveredObligations = requiredObligations.filter((obligation) => {
    const patterns = OBLIGATION_COVERAGE_RULES[obligation] || [];
    return patterns.some((pattern) => pattern.test(aggregateText));
  });
  const missingObligations = requiredObligations.filter((obligation) => !coveredObligations.includes(obligation));

  return {
    passed: missingObligations.length === 0,
    requiredObligations,
    coveredObligations,
    missingObligations,
  };
}

export function buildTargetModeSynthesisTaskSection(
  activeTargetSession: any,
  coveragePlan?: TargetResearchCoveragePlan | null,
): string {
  const plan = coveragePlan || deriveTargetResearchCoveragePlan(activeTargetSession);
  return `## TARGET-REPO SYNTHESIS TASK
You are preparing research for an external target repo delivery, not BOX self-improvement.
Do NOT reframe this as BOX self-improvement or answer only in terms of BOX internal file changes.
Translate the research into implementation guidance for the target repo's product, flows, and user-facing quality.
Target product: ${String(activeTargetSession?.intent?.productType || "unknown")}
Must-have flows: ${(Array.isArray(activeTargetSession?.intent?.mustHaveFlows) ? activeTargetSession.intent.mustHaveFlows : []).join(", ") || "none"}
Success criteria: ${(Array.isArray(activeTargetSession?.intent?.successCriteria) ? activeTargetSession.intent.successCriteria : []).join(", ") || "none"}
Coverage obligations: ${plan.obligations.join(", ") || "implementation_patterns"}
For each medium/high relevance source, explain what the target repo should implement, what user-facing behavior it improves, and what evidence supports that change.`;
}

export interface SynthesisQualityGate {
  /** True when all topics meet the minimum actionable density threshold. */
  passed: boolean;
  /** Whether a retry was attempted due to insufficient density. */
  retried: boolean;
  topicDensities: SynthesisTopicDensity[];
  /** Topic names that still failed density after retry and were quarantined from the planning context. */
  quarantinedTopics: string[];
  /** True when any topic was quarantined — signals degraded planning mode to Prometheus. */
  degradedPlanningMode: boolean;
  /**
   * Minimal recovery signal used when degradedPlanningMode=true and ALL topics
   * were quarantined.  Topic names are provenance/audit metadata only; planning
   * must use internal repository evidence only. Empty string when not applicable.
   */
  recoverySignal?: string;
  /** Explicit planning contract for degraded mode consumers. */
  planningMode?: "normal" | "internal_evidence_only";
  /** Target-mode coverage analysis for obligation-based research completeness. */
  coverage?: TargetCoverageAssessment;
  /** True when another scout pass is recommended to fill missing obligation areas. */
  refreshRecommended?: boolean;
}

/**
 * Compute actionable density for each topic.
 * A signal counts if it is a non-empty string (source prometheusReadySummary)
 * or a non-empty array item (netFindings, applicableIdeas).
 */
export function computeSynthesisActionableDensity(topics: Array<Record<string, unknown>>): SynthesisTopicDensity[] {
  return topics.map((t) => {
    const topicName = String(t.topic || "");
    let count = 0;

    const findings = Array.isArray(t.netFindings) ? t.netFindings : [];
    count += findings.filter((f) => typeof f === "string" && f.trim().length >= SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH).length;

    const ideas = Array.isArray(t.applicableIdeas) ? t.applicableIdeas : [];
    count += ideas.filter((i) => typeof i === "string" && i.trim().length >= SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH).length;

    const sources = Array.isArray(t.sources) ? t.sources as Array<Record<string, unknown>> : [];
    for (const src of sources) {
      if (typeof src.prometheusReadySummary === "string" && src.prometheusReadySummary.trim().length >= SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH) {
        count++;
      } else if (typeof src.extractedContent === "string" && src.extractedContent.trim().length >= SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH) {
        // extractedContent is a direct actionable signal when prometheusReadySummary is absent
        count++;
      } else if (typeof src.scoutFindings === "string" && src.scoutFindings.trim().length >= SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH) {
        // scoutFindings is a raw but actionable signal
        count++;
      }
    }

    return {
      topic: topicName,
      actionableCount: count,
      passed: count >= SYNTHESIS_MIN_ACTIONABLE_DENSITY_PER_TOPIC,
    };
  });
}

/**
 * Partition synthesis topics into passed and quarantined sets based on density results.
 *
 * Topics that failed density after the retry pass are quarantined — they must not
 * be injected into the Prometheus planning prompt because they carry no actionable signal.
 */
export function quarantineLowDensityTopics(
  topics: Array<Record<string, unknown>>,
  densities: SynthesisTopicDensity[],
): { passedTopics: Array<Record<string, unknown>>; quarantinedTopics: string[] } {
  const failedSet = new Set(densities.filter(d => !d.passed).map(d => d.topic));
  const passedTopics = topics.filter(t => !failedSet.has(String(t.topic || "")));
  const quarantinedTopics = topics
    .filter(t => failedSet.has(String(t.topic || "")))
    .map(t => String(t.topic || ""));
  return { passedTopics, quarantinedTopics };
}

/**
 * Validate that a single topic carries at least one actionable artifact.
 *
 * A topic passes when it has at least one of:
 *   - A source with prometheusReadySummary, extractedContent, or scoutFindings ≥ min length
 *   - A non-empty netFindings entry ≥ min length
 *   - A non-empty applicableIdeas entry ≥ min length
 *
 * Used as a persistence-time invariant check before topics are written to state.
 * Exported for testing.
 *
 * @param topic — a parsed/sanitized topic object
 * @returns true when the topic carries at least one actionable artifact
 */
export function topicHasActionableArtifact(topic: Record<string, unknown>): boolean {
  if (!topic || typeof topic !== "object") return false;

  const findings = Array.isArray(topic.netFindings) ? topic.netFindings : [];
  if (findings.some(f => typeof f === "string" && f.trim().length >= SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH)) return true;

  const ideas = Array.isArray(topic.applicableIdeas) ? topic.applicableIdeas : [];
  if (ideas.some(i => typeof i === "string" && i.trim().length >= SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH)) return true;

  const sources = Array.isArray(topic.sources) ? topic.sources as Array<Record<string, unknown>> : [];
  for (const src of sources) {
    if (typeof src.prometheusReadySummary === "string" && src.prometheusReadySummary.trim().length >= SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH) return true;
    if (typeof src.extractedContent === "string" && src.extractedContent.trim().length >= SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH) return true;
    if (typeof src.scoutFindings === "string" && src.scoutFindings.trim().length >= SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH) return true;
  }
  return false;
}

/**
 * Build a minimal recovery signal for the qualityGate when all topics are
 * quarantined (degradedPlanningMode=true).
 *
 * Topic names are included for provenance only. Prometheus must derive tasks
 * from internal repository evidence only in degraded mode. Returns an empty
 * string when no topic names are available.
 *
 * Exported for testing.
 *
 * @param quarantinedTopicNames — list of topic names that failed density
 * @returns a plain-English recovery signal string, or "" when input is empty
 */
export function buildQualityGateRecoverySignal(quarantinedTopicNames: string[]): string {
  const names = quarantinedTopicNames.filter(n => String(n).trim().length > 0);
  if (names.length === 0) return "";
  // NOTE: topic names are surfaced for audit only — Prometheus must NOT use them as
  // planning evidence. Internal repository state is the authoritative planning source
  // when all topics are quarantined.
  return `Research was attempted on topics: ${names.join(", ")}. All failed density check — ` +
    `do NOT use topic names as planning input. Operate in internal-evidence-only planning mode and derive tasks only from concrete repository evidence (files, failing tests, error logs, state files).`;
}

/** Strict actionable-density thresholds used in bounded recovery synthesis scheduling. */
export const SYNTHESIS_RECOVERY_DENSITY_THRESHOLDS = Object.freeze({
  /** Minimum number of unique topics with at least one actionable finding. */
  minTopicCount: 2,
  /** Minimum number of actionable items across all topics. */
  minActionableCount: 4,
  /** Maximum number of re-synthesis retries before falling back to internal evidence only. */
  maxRetries: 1,
});

/**
 * Schedule a bounded recovery synthesis for the next cycle when synthesis density
 * fails (degraded planning mode).  Writes a `synthesis_recovery_request.json` to
 * the state directory so that the Research Scout/Synthesizer can pick it up on the
 * next cycle and run a tightly constrained re-synthesis.
 *
 * Exported for testing and for prometheus.ts to call after entering degraded mode.
 *
 * @param stateDir — path to the state directory
 * @param opts — optional metadata to embed in the request record
 */
export async function scheduleBoundedRecoverySynthesis(
  stateDir: string,
  opts: { quarantinedTopics?: string[]; retriedAlready?: boolean } = {}
): Promise<void> {
  const recoveryPath = path.join(stateDir, "synthesis_recovery_request.json");
  try {
    const record = {
      requestedAt: new Date().toISOString(),
      reason: "degraded_planning_mode_all_topics_quarantined",
      densityThresholds: SYNTHESIS_RECOVERY_DENSITY_THRESHOLDS,
      quarantinedTopics: Array.isArray(opts.quarantinedTopics) ? opts.quarantinedTopics : [],
      retriedAlready: opts.retriedAlready === true,
      scheduledForCycle: "next",
      planningMode: "internal_evidence_only",
    };
    await fs.writeFile(recoveryPath, JSON.stringify(record, null, 2), "utf8");
  } catch (err) {
    // Non-fatal — failure to schedule recovery must never block the current planning cycle.
    // Log to stderr so CI/monitoring can detect persistent write failures.
    process.stderr.write(
      `[RESEARCH_SYNTHESIZER][WARN] Failed to write synthesis_recovery_request.json: ${String((err as Error)?.message || err)}\n`
    );
  }
}

function toSingleLine(value: unknown, maxLen = 240): string {
  const compact = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";
  return compact.length > maxLen ? `${compact.slice(0, maxLen - 3)}...` : compact;
}

function clampList(values: unknown, maxItems: number, maxLen: number): string[] {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of list) {
    const normalized = toSingleLine(value, maxLen);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= maxItems) break;
  }
  return output;
}

export function stripExecutionTranscriptNoise(rawText: string): string {
  const text = String(rawText || "");
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const normalized = String(line || "").trim();
    if (!normalized) return false;
    if (/^\[(synthesizer_start|synthesizer_end|research_synthesizer_live)\]/i.test(normalized)) return false;
    if (/^(tool_call|tool_result|function_call|assistant:|system:|user:)/i.test(normalized)) return false;
    if (/^copilot>/i.test(normalized)) return false;
    if (/^```/.test(normalized)) return false;
    return true;
  });
  return filtered.join("\n").trim();
}

function toClampedConfidence(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(Math.max(0, Math.min(1, parsed)) * 1000) / 1000;
}

function buildPlannerSignals(topics: Array<Record<string, unknown>>, crossTopicConnections: string[], researchGaps: string) {
  const priorityActions: string[] = [];
  const riskFlags: string[] = [];
  for (const topic of topics) {
    const topicName = toSingleLine(topic.topic, 160);
    if (!topicName) continue;
    if (priorityActions.length < MAX_PLANNER_SIGNALS) {
      const signal =
        toSingleLine((topic as Record<string, unknown>).prometheusReadySummary, MAX_TOPIC_TEXT)
        || toSingleLine((topic as Record<string, unknown>).netFindings?.[0], MAX_TOPIC_TEXT)
        || topicName;
      priorityActions.push(`${topicName}: ${signal}`);
    }
    const risk = toSingleLine((topic as Record<string, unknown>).risks?.[0], MAX_TOPIC_TEXT);
    if (risk && riskFlags.length < MAX_PLANNER_SIGNALS) {
      riskFlags.push(`${topicName}: ${risk}`);
    }
  }

  const unresolvedGaps = clampList(
    String(researchGaps || "").split(/\n+/).map((line) => line.replace(/^[\s\-*•\d.]+/, "")),
    MAX_PLANNER_SIGNALS,
    MAX_TOPIC_TEXT,
  );

  return {
    topTopics: topics.map((topic) => toSingleLine(topic.topic, 160)).filter(Boolean).slice(0, MAX_PLANNER_SIGNALS),
    priorityActions: clampList(priorityActions, MAX_PLANNER_SIGNALS, MAX_TOPIC_TEXT),
    riskFlags: clampList(riskFlags, MAX_PLANNER_SIGNALS, MAX_TOPIC_TEXT),
    crossTopicDependencies: clampList(crossTopicConnections, MAX_PLANNER_SIGNALS, MAX_TOPIC_TEXT),
    unresolvedGaps,
  };
}

export function sanitizeResearchSynthesisForPersistence(payload: {
  success: boolean;
  topicCount: number;
  topics: Array<Record<string, unknown>>;
  crossTopicConnections: string[];
  researchGaps: string;
  synthesizedAt: string;
  scoutSourceCount: number;
  model: string;
  lastConsumedAt?: string;
  qualityGate?: SynthesisQualityGate;
  targetSession?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const rawTopics = Array.isArray(payload.topics) ? payload.topics : [];
  const topics = rawTopics.slice(0, MAX_SYNTHESIS_TOPICS).map((topic) => {
    const item = (topic && typeof topic === "object") ? topic as Record<string, unknown> : {};
    const sources = (Array.isArray(item.sources) ? item.sources : [])
      .slice(0, MAX_TOPIC_SOURCES)
      .map((source) => {
        const src = (source && typeof source === "object") ? source as Record<string, unknown> : {};
        const confidence = toClampedConfidence(src.confidence);
        return {
          title: toSingleLine(src.title, 160),
          url: toSingleLine(src.url, 260),
          date: toSingleLine(src.date, 64),
          ...(confidence !== null ? { confidence } : {}),
          isDuplicate: src.isDuplicate === true,
          knowledgeType: toSingleLine(src.knowledgeType, 64),
          scoutFindings: toSingleLine(src.scoutFindings, MAX_TOPIC_TEXT),
          synthesizerEnrichment: toSingleLine(src.synthesizerEnrichment, MAX_TOPIC_TEXT),
          prometheusReadySummary: toSingleLine(src.prometheusReadySummary, MAX_TOPIC_TEXT)
            || toSingleLine(src.extractedContent, MAX_TOPIC_TEXT)
            || toSingleLine(src.scoutFindings, MAX_TOPIC_TEXT),
        };
      })
      .filter((source) => Object.values(source).some(Boolean));

    // Derive topic-level prometheusReadySummary — the best single-sentence signal
    // from this topic for Prometheus planning. Preference order:
    //   1. first source with a non-empty prometheusReadySummary
    //   2. first netFinding
    //   3. first applicableIdea
    //   4. empty string (no signal available — topic will fail density check)
    const topicPrometheusReadySummary = (() => {
      for (const src of sources) {
        if (src.prometheusReadySummary) return String(src.prometheusReadySummary);
      }
      const nf = clampList(item.netFindings, 1, MAX_TOPIC_TEXT);
      if (nf[0]) return nf[0];
      const ai = clampList(item.applicableIdeas, 1, MAX_TOPIC_TEXT);
      if (ai[0]) return ai[0];
      return "";
    })();

    return {
      topic: toSingleLine(item.topic, 180),
      freshness: toSingleLine(item.freshness, 120),
      confidence: toSingleLine(item.confidence, 32),
      sourceCount: Number.isFinite(Number(item.sourceCount)) ? Math.max(0, Number(item.sourceCount)) : sources.length,
      sourceList: clampList(item.sourceList, MAX_TOPIC_SOURCES, 260),
      netFindings: clampList(item.netFindings, 6, MAX_TOPIC_TEXT),
      applicableIdeas: clampList(item.applicableIdeas, 6, MAX_TOPIC_TEXT),
      risks: clampList(item.risks, 6, MAX_TOPIC_TEXT),
      conflictingViews: clampList(item.conflictingViews, 6, MAX_TOPIC_TEXT),
      prometheusReadySummary: topicPrometheusReadySummary,
      sources,
    };
  // Persistence-time invariant: only retain topics with a name AND at least one actionable artifact.
  // Topics that have a name but zero signal are silently dropped so they do not pollute
  // the quality gate or degrade planning mode without cause.
  }).filter((topic) => Boolean(topic.topic) && topicHasActionableArtifact(topic))
    .map((topic) => {
      // Annotate each retained topic with a deterministic applicability score so
      // downstream consumers (Prometheus planning prompt) can filter non-platform
      // research without re-evaluating the topic content.
      const applicability = scoreTopicApplicability(topic);
      return {
        ...topic,
        applicabilityScore: applicability.verdict,
        applicabilityEvidence: applicability.evidence,
        ...(applicability.detectedPlatform ? { applicabilityDetectedPlatform: applicability.detectedPlatform } : {}),
      };
    });

  const crossTopicConnections = clampList(payload.crossTopicConnections, MAX_CONNECTIONS, MAX_TOPIC_TEXT);
  const researchGaps = String(payload.researchGaps || "").slice(0, MAX_RESEARCH_GAPS).trim();
  const plannerSignals = buildPlannerSignals(topics, crossTopicConnections, researchGaps);

  return {
    success: payload.success === true,
    topicCount: topics.length,
    topics,
    crossTopicConnections,
    researchGaps,
    synthesizedAt: String(payload.synthesizedAt || new Date().toISOString()),
    scoutSourceCount: Number.isFinite(Number(payload.scoutSourceCount)) ? Math.max(0, Number(payload.scoutSourceCount)) : 0,
    model: toSingleLine(payload.model, 80) || "gpt-5.3-codex",
    plannerSignals,
    ...(payload.qualityGate ? { qualityGate: payload.qualityGate } : {}),
    ...(payload.lastConsumedAt ? { lastConsumedAt: String(payload.lastConsumedAt) } : {}),
    ...(payload.targetSession && typeof payload.targetSession === "object"
      ? { targetSession: payload.targetSession }
      : {}),
  };
}

export interface ResearchSynthesisResult {
  success: boolean;
  topicCount: number;
  topics: Array<Record<string, unknown>>;
  crossTopicConnections: string[];
  researchGaps: string;
  rawText: string;
  synthesizedAt: string;
  scoutSourceCount: number;
  model: string;
  targetSession?: Record<string, unknown> | null;
  error?: string;
  qualityGate?: SynthesisQualityGate;
}

/**
 * Run the Research Synthesizer — 1 premium request.
 *
 * Takes the Scout's raw output and produces a topic-organized synthesis
 * that Prometheus reads before planning.
 */
export async function runResearchSynthesizer(config: any, scoutOutput: any): Promise<ResearchSynthesisResult> {
  const stateDir = config.paths?.stateDir || "state";
  const command = config.env?.copilotCliCommand || "copilot";
  const model = config.roleRegistry?.researchSynthesizer?.model || "gpt-5.3-codex";

  const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

  // Initialize live log
  try {
    await fs.writeFile(liveLogPath(stateDir), `[research_synthesizer_live]\n[${ts()}] Research Synthesizer starting...\n`, "utf8");
  } catch { /* best-effort */ }

  await appendProgress(config, `[RESEARCH_SYNTHESIZER] Starting synthesis of ${scoutOutput?.sourceCount || 0} source(s)`);

  // Build prompt with the Scout's raw output as input
  const scoutRawText = String(scoutOutput?.rawText || "");
  const sourceCount = scoutOutput?.sourceCount || 0;
  const targetSession = scoutOutput?.targetSession && typeof scoutOutput.targetSession === "object"
    ? scoutOutput.targetSession
    : (config?.activeTargetSession && typeof config.activeTargetSession === "object" ? config.activeTargetSession : null);
  const targetCoveragePlan = scoutOutput?.coveragePlan && typeof scoutOutput.coveragePlan === "object"
    ? scoutOutput.coveragePlan as TargetResearchCoveragePlan
    : (targetSession ? deriveTargetResearchCoveragePlan(targetSession) : null);
  const synthesizerAssemblySections = buildPromptAssemblySections({
    agentName: "research-synthesizer",
    config,
  });

  const taskSectionText = targetSession
    ? buildTargetModeSynthesisTaskSection(targetSession, targetCoveragePlan)
    : `## YOUR TASK
Below is the raw research output from the Research Scout.
It contains ${sourceCount} source(s) with extracted findings.
Your job: synthesize this into a structured, topic-organized output that Prometheus can use for planning.
Follow your agent definition's output format exactly.
Do NOT lose useful information. Compress the format, not the content.
If sources contradict each other, document the contradiction explicitly.`;

  const compiledPrompt = compilePrompt([
    ...synthesizerAssemblySections,
    section("task", taskSectionText),
    section("scout-output", `## RESEARCH SCOUT RAW OUTPUT
${scoutRawText}`),
  ], {
    tokenBudget: resolveMaxPromptBudget(
      config,
      String(model || "gpt-5.3-codex"),
      Number(config?.runtime?.researchSynthesizerPromptTokenBudget)
    ) || undefined,
  });
  const contextPrompt = compiledPrompt;

  // Build args — synthesizer performs second-pass enrichment and may need broad tool access.
  const args = buildAgentArgs({
    agentSlug: "research-synthesizer",
    prompt: contextPrompt,
    model,
    allowAll: true,
    maxContinues: undefined,
  });

  appendLiveLogSync(stateDir, `\n[synthesizer_start] ${ts()}\n`);

  const result = await spawnAsync(command, args, {
    env: process.env,
    onStdout(chunk: Buffer) {
      appendLiveLogSync(stateDir, chunk.toString("utf8"));
    },
    onStderr(chunk: Buffer) {
      appendLiveLogSync(stateDir, chunk.toString("utf8"));
    },
  });

  appendLiveLogSync(stateDir, `\n[synthesizer_end] ${ts()} exit=${(result as any).status}\n`);

  const stdout = String((result as any)?.stdout || "");
  const stderr = String((result as any)?.stderr || "");
  const raw = stdout || stderr;
  const cleanRaw = stripExecutionTranscriptNoise(raw);
  await appendAgentContextUsage(config, {
    agent: "research-synthesizer",
    model: String(model || "gpt-5.3-codex"),
    promptText: contextPrompt,
    status: (result as any).status === 0 ? "success" : "failed",
  });

  if ((result as any).status !== 0) {
    const error = `exited ${(result as any).status}: ${(stderr || stdout).slice(0, 500)}`;
    await appendProgress(config, `[RESEARCH_SYNTHESIZER] Failed — ${error}`);
    return {
      success: false,
      topicCount: 0,
      topics: [],
      crossTopicConnections: [],
      researchGaps: "",
      rawText: raw,
      synthesizedAt: new Date().toISOString(),
      scoutSourceCount: sourceCount,
      model,
      error,
    };
  }

  // Parse structured topics
  const topics = parseSynthesisTopics(cleanRaw);
  const crossTopicConnections = extractCrossTopicConnections(cleanRaw);
  const researchGaps = extractResearchGaps(cleanRaw);

  // ── Synthesis quality gate ────────────────────────────────────────────────
  // Check that each parsed topic carries at minimum one actionable signal.
  // When the gate fails, retry once with constrained repair instructions.
  let finalTopics = topics;
  let finalCrossTopicConnections = crossTopicConnections;
  let finalResearchGaps = researchGaps;
  let retried = false;

  const initialDensities = computeSynthesisActionableDensity(topics);
  const lowDensityTopics = initialDensities.filter(d => !d.passed);
  const initialCoverage = assessTargetCoverageObligations(topics, targetCoveragePlan);
  const missingCoverageObligations = initialCoverage.missingObligations;

  if (lowDensityTopics.length > 0 || missingCoverageObligations.length > 0) {
    // Gate failed — retry once with constrained repair instructions
    retried = true;
    appendLiveLogSync(
      stateDir,
      `\n[quality_gate_retry] ${ts()} — densityFailures=${lowDensityTopics.length} missingCoverage=${missingCoverageObligations.length}. Retrying with repair prompt.\n`
    );
    await appendProgress(
      config,
      `[RESEARCH_SYNTHESIZER][QUALITY_GATE] densityFailures=${lowDensityTopics.length} missingCoverage=${missingCoverageObligations.length}. Retrying.`
    );

    const deficientTopicNames = lowDensityTopics.map(d => `- ${d.topic}`).join("\n") || "- none";
    const missingCoverageText = missingCoverageObligations.length > 0
      ? missingCoverageObligations.map((item) => `- ${item}`).join("\n")
      : "- none";
    const repairPrompt = compilePrompt([
      ...synthesizerAssemblySections,
      section("task", `## REPAIR TASK
The previous synthesis run produced research that was incomplete for downstream planning.
Each topic MUST have at least one concrete finding, applicable idea, or prometheus-ready summary.
When target delivery mode is active, the final synthesis must also cover the required obligation areas instead of staying stack-only.

Topics requiring density repair:
${deficientTopicNames}

Missing coverage obligations:
${missingCoverageText}

Re-synthesize the deficient areas with concrete, target-relevant evidence.
For each repaired topic, include:
  - At least one **Net Finding** (concrete, factual statement)
  - At least one **Applicable Idea** tied to the active delivery target
  - At least one **Source** with a **Prometheus-Ready Summary** (actionable 1-2 sentence summary)

Preserve already-adequate evidence unchanged.
Follow your agent definition's output format exactly.`),
      section("scout-output", `## RESEARCH SCOUT RAW OUTPUT\n${scoutRawText}`),
    ], {
      tokenBudget: resolveMaxPromptBudget(
        config,
        String(model || "gpt-5.3-codex"),
        Number(config?.runtime?.researchSynthesizerPromptTokenBudget)
      ) || undefined,
    });

    const repairArgs = buildAgentArgs({
      agentSlug: "research-synthesizer",
      prompt: repairPrompt,
      model,
      allowAll: true,
      maxContinues: undefined,
    });

    appendLiveLogSync(stateDir, `\n[repair_start] ${ts()}\n`);

    let repairResult: any;
    try {
      repairResult = await spawnAsync(command, repairArgs, {
        env: process.env,
        onStdout(chunk: Buffer) { appendLiveLogSync(stateDir, chunk.toString("utf8")); },
        onStderr(chunk: Buffer) { appendLiveLogSync(stateDir, chunk.toString("utf8")); },
      });
    } catch (err) {
      appendLiveLogSync(stateDir, `\n[repair_error] ${ts()} — ${String((err as any)?.message || err)}\n`);
      repairResult = { status: 1, stdout: "", stderr: "" };
    }

    appendLiveLogSync(stateDir, `\n[repair_end] ${ts()} exit=${repairResult?.status}\n`);

    if (repairResult?.status === 0) {
      const repairRaw = stripExecutionTranscriptNoise(String(repairResult?.stdout || repairResult?.stderr || ""));
      await appendAgentContextUsage(config, {
        agent: "research-synthesizer-repair",
        model: String(model || "gpt-5.3-codex"),
        promptText: repairPrompt,
        status: "success",
      });
      const repairedTopics = parseSynthesisTopics(repairRaw);
      // Merge repaired topics over originals by topic name
      const topicMap = new Map(topics.map(t => [String(t.topic || ""), t]));
      for (const rt of repairedTopics) {
        const key = String(rt.topic || "");
        if (key) topicMap.set(key, rt);
      }
      finalTopics = Array.from(topicMap.values());
      finalCrossTopicConnections = extractCrossTopicConnections(repairRaw) || crossTopicConnections;
      finalResearchGaps = extractResearchGaps(repairRaw) || researchGaps;
    } else {
      // Repair spawn failed — fall through with original topics (fail-open)
      await appendProgress(config, `[RESEARCH_SYNTHESIZER][QUALITY_GATE] Repair attempt failed — proceeding with original output`);
    }
  }

  const qualityGateDensities = computeSynthesisActionableDensity(finalTopics);
  const coverageAssessment = assessTargetCoverageObligations(finalTopics, targetCoveragePlan);
  const gatePassed = qualityGateDensities.every(d => d.passed) && coverageAssessment.passed;
  const { passedTopics, quarantinedTopics } = quarantineLowDensityTopics(finalTopics, qualityGateDensities);
  const degradedPlanningMode = quarantinedTopics.length > 0 && passedTopics.length === 0;

  if (coverageAssessment.missingObligations.length > 0) {
    finalResearchGaps = [
      String(finalResearchGaps || "").trim(),
      `Missing target coverage obligations: ${coverageAssessment.missingObligations.join(", ")}`,
    ].filter(Boolean).join("\n");
  }

  // Build recovery signal when all topics are quarantined.
  // Invariant: degradedPlanningMode=true MUST be paired with a non-empty recoverySignal
  // so Prometheus always has at least a minimal planning context, never an empty shell.
  let recoverySignal = degradedPlanningMode
    ? buildQualityGateRecoverySignal(quarantinedTopics)
    : "";
  if (degradedPlanningMode && !recoverySignal) {
    // All topic names were empty — build a fallback signal so the invariant holds.
    recoverySignal = `All ${quarantinedTopics.length} research topic(s) quarantined due to insufficient actionable density. No named topics available — operate in internal-evidence-only planning mode and derive tasks from concrete repository evidence.`;
  }

  const qualityGate: SynthesisQualityGate = {
    passed: gatePassed,
    retried,
    topicDensities: qualityGateDensities,
    quarantinedTopics,
    // Degraded mode only fires when every topic was quarantined (passedTopics is empty).
    // Partial quarantine (some passed) does not warrant degraded mode — Prometheus
    // still has valid signal to plan from.
    degradedPlanningMode,
    // Always non-empty when degradedPlanningMode=true (invariant enforced above).
    ...(degradedPlanningMode ? { recoverySignal } : {}),
    planningMode: degradedPlanningMode ? "internal_evidence_only" : "normal",
    coverage: coverageAssessment,
    refreshRecommended: Boolean(targetCoveragePlan && !coverageAssessment.passed),
  };

  const output: ResearchSynthesisResult = {
    success: true,
    topicCount: finalTopics.length,
    topics: finalTopics,
    crossTopicConnections: finalCrossTopicConnections,
    researchGaps: finalResearchGaps,
    rawText: cleanRaw,
    synthesizedAt: new Date().toISOString(),
    scoutSourceCount: sourceCount,
    model,
    targetSession: targetSession && typeof targetSession === "object"
      ? targetSession
      : null,
    qualityGate,
  };

  // Persist synthesis for Prometheus to read
  await writeJson(path.join(stateDir, "research_synthesis.json"), sanitizeResearchSynthesisForPersistence(output));

  await appendProgress(
    config,
    `[RESEARCH_SYNTHESIZER] Complete — ${finalTopics.length} topic(s) synthesized from ${sourceCount} source(s) [qualityGate=${gatePassed ? "passed" : "failed"} coverageMissing=${coverageAssessment.missingObligations.length}]`
  );

  return output;
}

// ── Benchmark ground-truth: implementation-status accounting ──────────────────

/**
 * Possible implementation status values for a research recommendation.
 * Used in benchmark_ground_truth.json to track each recommendation lifecycle.
 */
export const IMPLEMENTATION_STATUS = Object.freeze({
  PENDING:     "pending",
  IN_PROGRESS: "in-progress",
  IMPLEMENTED: "implemented",
  FAILED:      "failed",
  RETIRED:     "retired",
});

/** Schema version for benchmark_ground_truth.json entries. */
export const BENCHMARK_ENTRY_SCHEMA_VERSION = 1;

// ── Category Frontier Structures ─────────────────────────────────────────────

/**
 * Per-instance result within a benchmark category frontier.
 * Optional — only populated when per-instance data is available.
 */
export interface BenchmarkInstanceResult {
  /** Stable unique instance identifier (e.g. SWE-bench task id). */
  instanceId: string;
  /** Whether this instance was resolved/passed. */
  resolved: boolean;
  /** Model that achieved this result. */
  model: string;
  /** ISO 8601 date the result was recorded. */
  date: string;
}

/**
 * Frontier entry for a single benchmark category.
 * Tracks the best-known score (resolved/total) for a specific category,
 * along with the model and date that achieved it.
 */
export interface BenchmarkCategoryFrontier {
  /** Category name (e.g. "django", "scikit-learn", "OSWorld-web"). */
  category: string;
  /** Number of instances resolved at the frontier. */
  resolvedCount: number;
  /** Total instances in this category. */
  totalCount: number;
  /** Normalized resolution rate at frontier: resolvedCount / totalCount. */
  frontierScore: number;
  /** Model that achieved the frontier result. */
  model: string;
  /** ISO 8601 date of the frontier measurement. */
  date: string;
  /** Optional per-instance results for the frontier. */
  perInstance?: BenchmarkInstanceResult[];
}

/**
 * Build a normalized BenchmarkCategoryFrontier entry from raw input.
 *
 * Validation rules:
 *   - resolvedCount/totalCount must be non-negative integers; resolved <= total.
 *   - frontierScore = resolvedCount / totalCount (clamped to [0, 1]).
 *   - totalCount=0 → frontierScore = 0 (avoid division by zero).
 *   - model and date are coerced to strings; empty values are retained as-is.
 *
 * @param raw — untrusted input from external benchmark source
 * @returns normalized frontier entry and any validation errors
 */
export function normalizeCategoryFrontierEntry(
  raw: Record<string, unknown>,
): { entry: BenchmarkCategoryFrontier; errors: string[] } {
  const errors: string[] = [];
  const input = raw && typeof raw === "object" ? raw : {};

  const category = String(input.category ?? "").trim();
  if (!category) errors.push("missing_field:category");

  const resolvedCount = Math.max(0, Math.floor(Number(input.resolvedCount ?? 0)));
  const totalCount = Math.max(0, Math.floor(Number(input.totalCount ?? 0)));

  if (resolvedCount > totalCount && totalCount > 0) {
    errors.push(`invalid_counts:resolved(${resolvedCount})>total(${totalCount})`);
  }

  const frontierScore = totalCount > 0
    ? Math.min(1, Math.max(0, Math.round((resolvedCount / totalCount) * 10000) / 10000))
    : 0;

  const model = String(input.model ?? "").trim();
  const date = String(input.date ?? "").trim();

  let perInstance: BenchmarkInstanceResult[] | undefined;
  if (Array.isArray(input.perInstance)) {
    perInstance = input.perInstance.map((inst: unknown, idx: number) => {
      const r = inst && typeof inst === "object" ? inst as Record<string, unknown> : {};
      return {
        instanceId: String(r.instanceId ?? `instance-${idx}`),
        resolved: Boolean(r.resolved),
        model: String(r.model ?? model),
        date: String(r.date ?? date),
      };
    });
  }

  const entry: BenchmarkCategoryFrontier = {
    category,
    resolvedCount,
    totalCount,
    frontierScore,
    model,
    date,
    ...(perInstance !== undefined ? { perInstance } : {}),
  };

  return { entry, errors };
}

/** A single tracked research recommendation entry. */
export interface ResearchRecommendation {
  id: string;
  topic: string;
  summary: string;
  implementationStatus: string;
  benchmarkScore: number | null;
  capacityGain: number | null;
  evidence: string;
  // ── Provenance fields — populated when a recommendation reaches CI closure ──
  /** Source URL where the benchmark result or implementation evidence was published. */
  source_url: string | null;
  /** Unique submission ID from the external benchmark system. */
  submission_id: string | null;
  /** Model tag/identifier that produced the implementation. */
  model_tag: string | null;
  /** Number of attempts taken to reach implementation. */
  attempt_count: number | null;
  /** Pull-request URL or identifier for the implementing change. */
  prId: string | null;
  /** Merged commit SHA — non-empty when the PR was successfully merged. */
  mergedSha: string | null;
  /** True when CI checks closed green after merge (enables skip routing). */
  ciClosed: boolean | null;
}

/**
 * Required provenance fields for a recommendation to be considered
 * "provenance-complete" for CI-closure-based skip routing.
 */
export const PROVENANCE_COMPLETE_REQUIRED_FIELDS: ReadonlyArray<keyof ResearchRecommendation> =
  Object.freeze(["mergedSha", "ciClosed"] as const);

/**
 * Return true when the given recommendation has a non-empty mergedSha AND
 * ciClosed === true — the two conditions required for skip routing after
 * CI-closure stabilization.
 *
 * A recommendation that is merely "implemented" without closed CI is not
 * considered provenance-complete; it still flows to the execute queue.
 */
export function isProvenanceComplete(rec: ResearchRecommendation): boolean {
  const sha = String(rec?.mergedSha || "").trim();
  return sha.length > 0 && rec?.ciClosed === true;
}

/**
 * Extract a flat list of recommendations from synthesis topics.
 * Each topic produces one recommendation, initially with status "pending".
 *
 * Summary preference: prometheusReadySummary > extractedContent > applicableIdeas > topic name.
 */
export function extractRecommendationsList(
  topics: Array<Record<string, unknown>>,
): ResearchRecommendation[] {
  if (!Array.isArray(topics)) return [];

  return topics.map((t, idx) => {
    const topicName = String(t.topic || `topic-${idx}`);
    const sources = Array.isArray(t.sources) ? t.sources as Array<Record<string, unknown>> : [];

    let summary = "";
    for (const src of sources) {
      if (src.prometheusReadySummary) { summary = String(src.prometheusReadySummary).slice(0, 300); break; }
      if (src.extractedContent)       { summary = String(src.extractedContent).slice(0, 300); break; }
    }
    if (!summary) {
      const ideas = Array.isArray(t.applicableIdeas) ? (t.applicableIdeas as string[]).join("; ") : "";
      summary = ideas || topicName;
    }

    // Deterministic stable ID: topic slug + position index
    const slug = topicName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").slice(0, 40);
    const id = `rec-${slug}-${idx}`;

    return {
      id,
      topic: topicName,
      summary: summary.slice(0, 300),
      implementationStatus: IMPLEMENTATION_STATUS.PENDING,
      benchmarkScore: null,
      capacityGain: null,
      evidence: "",
      source_url: null,
      submission_id: null,
      model_tag: null,
      attempt_count: null,
      prId: null,
      mergedSha: null,
      ciClosed: null,
    };
  });
}

/**
 * Build a benchmark ground-truth entry for a cycle from synthesis topics.
 * Returns an object ready for append to benchmark_ground_truth.json.
 */
export function buildBenchmarkEntry(
  cycleId: string,
  topics: Array<Record<string, unknown>>,
  categoryFrontiers?: BenchmarkCategoryFrontier[],
): {
  cycleId: string;
  evaluatedAt: string;
  schemaVersion: number;
  recommendations: ResearchRecommendation[];
  categoryFrontiers?: BenchmarkCategoryFrontier[];
} {
  const entry: ReturnType<typeof buildBenchmarkEntry> = {
    cycleId: String(cycleId || ""),
    evaluatedAt: new Date().toISOString(),
    schemaVersion: BENCHMARK_ENTRY_SCHEMA_VERSION,
    recommendations: extractRecommendationsList(topics),
  };
  if (Array.isArray(categoryFrontiers) && categoryFrontiers.length > 0) {
    entry.categoryFrontiers = categoryFrontiers;
  }
  return entry;
}

/**
 * Persist a benchmark ground-truth entry to state/benchmark_ground_truth.json.
 * Prepends the new entry; trims history to 50 entries.
 * Non-blocking — analytics failure must never stop main orchestration flow.
 */
export async function persistBenchmarkEntry(
  config: any,
  cycleId: string,
  topics: Array<Record<string, unknown>>,
  categoryFrontiers?: BenchmarkCategoryFrontier[],
): Promise<void> {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, "benchmark_ground_truth.json");
  try {
    const entry = buildBenchmarkEntry(cycleId, topics, categoryFrontiers);
    const existing = await readJson(filePath, {
      schemaVersion: BENCHMARK_ENTRY_SCHEMA_VERSION,
      updatedAt: null,
      entries: [],
    });
    const entries: unknown[] = Array.isArray(existing.entries) ? existing.entries : [];
    entries.unshift(entry);
    if (entries.length > 50) entries.length = 50;
    await writeJson(filePath, {
      schemaVersion: BENCHMARK_ENTRY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      entries,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[research_synthesizer] persistBenchmarkEntry failed: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a compact prompt section from the synthesis for injection into Prometheus.
 * This is what Prometheus actually reads — dense, structured, actionable.
 *
 * NOTE: In the new architecture Prometheus reads research_synthesis.json directly
 * via its read tool. This function is kept for backward compatibility but will
 * eventually be removed.
 */
export function buildResearchSectionForPrometheus(synthesis: ResearchSynthesisResult | null): string {
  if (!synthesis || !synthesis.success || synthesis.topicCount === 0) {
    return "";
  }

  const topicBlocks = synthesis.topics.map((t, i) => {
    // New format: sources with extractedContent
    const sourcesArr = Array.isArray(t.sources) ? t.sources as Array<Record<string, unknown>> : [];
    let sourcesBlock = "";
    if (sourcesArr.length > 0) {
      sourcesBlock = sourcesArr.map(s => {
        const title = String(s.title || "Untitled");
        const url = String(s.url || "");
        const ec = String(s.extractedContent || "").slice(0, 3000);
        const dup = s.isDuplicate ? " [DUPLICATE]" : "";
        return `  **${title}**${dup}${url ? ` (${url})` : ""}\n  ${ec}`;
      }).join("\n\n");
    }

    // Legacy format fields
    const findings = Array.isArray(t.netFindings) ? (t.netFindings as string[]).join("\n  - ") : "";
    const ideas = Array.isArray(t.applicableIdeas) ? (t.applicableIdeas as string[]).join("\n  - ") : "";
    const risks = Array.isArray(t.risks) ? (t.risks as string[]).join("\n  - ") : "";
    const conflicts = Array.isArray(t.conflictingViews) && (t.conflictingViews as string[]).length > 0
      ? (t.conflictingViews as string[]).join("\n  - ")
      : "";
    const sourceList = Array.isArray(t.sourceList) ? (t.sourceList as string[]).join(", ") : "";

    let block = `### ${i + 1}. ${t.topic || "Untitled Topic"}
  Confidence: ${t.confidence || "unknown"} | Freshness: ${t.freshness || "unknown"}`;

    if (sourcesBlock) {
      block += `\n  **Sources with Extracted Content:**\n${sourcesBlock}`;
    }
    if (findings) {
      block += `\n  **Net Findings:**\n  - ${findings}`;
    }
    if (ideas) {
      block += `\n  **Applicable Ideas for BOX:**\n  - ${ideas}`;
    }
    if (risks) {
      block += `\n  **Risks:** ${risks}`;
    }
    if (conflicts) {
      block += `\n  **Conflicting Views:** ${conflicts}`;
    }
    if (sourceList && !sourcesBlock) {
      block += `\n  **Sources:** ${sourceList}`;
    }

    return block;
  }).join("\n\n");

  let section = `\n\n## EXTERNAL RESEARCH INTELLIGENCE (from Research Scout + Synthesizer)
${synthesis.topicCount} topic(s) synthesized from ${synthesis.scoutSourceCount} internet source(s) (synthesized at ${synthesis.synthesizedAt}).
Use this research to inform your planning. Prioritize ideas with high confidence and direct applicability to BOX.

${topicBlocks}`;

  // crossTopicConnections is now an array
  if (Array.isArray(synthesis.crossTopicConnections) && synthesis.crossTopicConnections.length > 0) {
    const connections = synthesis.crossTopicConnections
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");
    section += `\n\n### Cross-Topic Connections\n${connections}`;
  }

  return section;
}

// ── Benchmark artifact ingestion normalization ─────────────────────────────────

/**
 * Normalize date and step-budget fields in a raw benchmark artifact record.
 *
 * Called during research synthesis when findings contain benchmark data
 * (e.g. OSWorld-verified style, SWE-bench results) to ensure schema
 * consistency before the data enters the planning context.
 *
 * Normalization rules:
 *   - Date fields: normalized to ISO 8601.  Non-parseable values are set to null
 *     and produce an error entry.
 *   - Step-budget fields: coerced to positive integers.  Non-integer, negative,
 *     or non-finite values are set to null and produce an error entry.
 *
 * Defaults (when opts is omitted):
 *   dateFields      = ["evaluatedAt", "verifiedAt"]
 *   stepBudgetFields = ["stepBudget"]
 *
 * @param artifact        — raw record from research/benchmark data
 * @param opts.dateFields      — field names whose values must be ISO 8601 dates
 * @param opts.stepBudgetFields — field names whose values must be positive integers
 * @returns { normalized, errors } — normalized copy of artifact and list of normalization errors
 */
export function normalizeBenchmarkArtifactFields(
  artifact: Record<string, unknown>,
  opts: {
    dateFields?: string[];
    stepBudgetFields?: string[];
  } = {}
): { normalized: Record<string, unknown>; errors: string[] } {
  if (!artifact || typeof artifact !== "object") {
    return { normalized: {}, errors: ["invalid_artifact:not_an_object"] };
  }

  const errors: string[] = [];
  const normalized: Record<string, unknown> = { ...artifact };

  const dateFields = Array.isArray(opts.dateFields) && opts.dateFields.length > 0
    ? opts.dateFields
    : ["evaluatedAt", "verifiedAt"];

  const stepBudgetFields = Array.isArray(opts.stepBudgetFields) && opts.stepBudgetFields.length > 0
    ? opts.stepBudgetFields
    : ["stepBudget"];

  for (const field of dateFields) {
    const rawVal = artifact[field];
    if (rawVal === null || rawVal === undefined) continue;
    const dateStr = String(rawVal).trim();
    if (!dateStr) continue;
    const parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) {
      errors.push(`invalid_date:${field}=${dateStr}`);
      normalized[field] = null;
    } else {
      normalized[field] = parsed.toISOString();
    }
  }

  for (const field of stepBudgetFields) {
    const rawVal = artifact[field];
    if (rawVal === null || rawVal === undefined) continue;
    const num = Number(rawVal);
    if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
      errors.push(`invalid_step_budget:${field}=${rawVal}`);
      normalized[field] = null;
    } else {
      normalized[field] = num;
    }
  }

  return { normalized, errors };
}
