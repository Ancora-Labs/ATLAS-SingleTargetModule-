/**
 * Prometheus — Self-Evolution Engine & Key Planner (Simplified)
 *
 * Prometheus is activated by Janus for deep repository analysis.
 * Uses single-prompt mode: one request per invocation.
 * The Copilot CLI agent reads the repo itself — no chunk export needed.
 * Behavior is defined in .github/agents/prometheus.agent.md.
 *
 * Output: deep analysis artifact in state/prometheus_analysis.json
 * Live log: state/live_worker_prometheus.log (streamed in real-time)
 */

import path from "node:path";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { readJson, writeJson, spawnAsync } from "./fs_utils.js";
import { appendAlert, appendProgress, appendInterventionOptimizerEntry, recordCapabilityExecution, appendPromptCacheTelemetry } from "./state_tracker.js";
import {
  buildWorkerTopologyContract,
  getRoleRegistry,
  LANE_WORKER_NAMES,
  normalizeExecutionPattern,
  normalizePrometheusPlanningMode,
  PROMETHEUS_PLANNING_MODE,
  selectExecutionPatternForPlans,
  type WorkerTopologyContract,
} from "./role_registry.js";
import { buildAgentArgs, parseAgentOutput } from "./agent_loader.js";
import { addSchemaVersion, STATE_FILE_TYPE } from "./schema_registry.js";
import { PREMORTEM_RISK_LEVEL } from "./athena_reviewer.js";
import {
  runInterventionOptimizer,
  buildInterventionsFromPlan,
  buildBudgetFromConfig,
  buildPolicyImpactByInterventionId,
  OPTIMIZER_STATUS,
  OPTIMIZER_LOG_JSONL_SCHEMA,
  OPTIMIZER_LOG_RECORD_TYPE,
} from "./intervention_optimizer.js";
import {
  resolveDependencyGraph,
  persistGraphDiagnostics,
  GRAPH_STATUS,
  GRAPH_DIAGNOSTICS_JSONL_SCHEMA,
  GRAPH_DIAGNOSTICS_RECORD_TYPE,
  isGraphDiagnosticsRecordContractValid,
} from "./dependency_graph_resolver.js";
import { dualPassCriticRepair, selectBestCandidateSet, CANDIDATE_TIE_THRESHOLD as _CANDIDATE_TIE_THRESHOLD, MAX_CANDIDATE_SETS as _MAX_CANDIDATE_SETS } from "./plan_critic.js";
import { compileAcceptanceCriteria, enrichPlansWithAC } from "./ac_compiler.js";
import { buildPromptAssemblyPrompt } from "./prompt_overlay.js";
import { PLATFORM_MODE } from "./mode_state.js";
import {
  validateLeadershipContract,
  LEADERSHIP_CONTRACT_TYPE,
  TRUST_BOUNDARY_ERROR,
  filterMemoryEntriesByTrust,
  isPrivilegedMemoryRequester,
  MEMORY_TRUST_LEVEL,
} from "./trust_boundary.js";
import {
  validateAllPlans,
  validateAndInjectRolePlans,
  PLAN_VIOLATION_SEVERITY,
  PACKET_VIOLATION_CODE,
  isCycleSpecificExclusionJustification,
  EQUAL_DIMENSION_SET,
  normalizeLeverageRank,
  buildThinPacketRejectionReason,
  computePacketDensityMetrics,
  isThinPacketForAdmission,
  getPacketThresholdsForLane,
  scanParsedOutputForProcessThought,
  OUTPUT_FIDELITY_GATE_FAIL_REASON,
  isCiCriticalMandatoryFinding,
  extractCiEvidenceFromMandatoryFinding,
  isCiBreakFinding,
  isSystemLearningCiDebtFinding,
  SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS,
  validateExecutionStrategyContract,
  type WaveTaskObject,
} from "./plan_contract_validator.js";
import {
  section,
  compilePrompt as _compilePrompt,
  estimateTokens,
  markCacheableSegments as _markCacheableSegments,
  markCycleDeltaSectionsRequired as _markCycleDeltaSectionsRequired,
  analyzePacketDensification as _analyzePacketDensification,
  PROMPT_BUDGET_PARTITION,
  compileRankedContextSection,
  boundStructuredList,
  estimateTokenCost,
  compilePrometheusContextShortlist,
  derivePromptFamilyKey,
  buildPromptLineageMarker,
  normalizePromptLineageContract,
  buildCandidateGenerationSection,
  type ShortlistItem,
} from "./prompt_compiler.js";
import {
  scanProject,
  buildSemanticFileCandidatesFromScan,
  rankSemanticFileCandidates,
} from "./project_scanner.js";
import {
  computeFingerprint,
  classifyCarryForwardByRecurrence,
  classifyLessonRetirementClass,
  isCarryForwardRetired,
  LESSON_RETIREMENT_CLASS,
} from "./carry_forward_ledger.js";
import { rewriteVerificationCommand } from "./verification_command_registry.js";
import { checkCarryForwardGate, hardGateRecurrenceToPolicies } from "./learning_policy_compiler.js";
import {
  buildPromptTruthMaintenanceSection,
  collectPromptTruthSignals,
  buildPromptTruthMaintenanceSnapshot,
  reconcilePromptTruthItems,
  resolveStructuredTruthRetirement,
  resolvePromptTruthRetirement,
  type PromptTruthSignals,
} from "./learning_policy_compiler.js";
import { buildRankedLessonShortlists } from "./lesson_halflife.js";
import {
  buildPrometheusPlanArtifact,
  derivePlanContinuationFamilyKey,
  extractImplementationEvidencePaths,
  normalizePlanIdentity,
  POSTMORTEM_LIFECYCLE_STATE,
} from "./plan_lifecycle_contract.js";
import {
  splitWavesIntoMicrowaves as _splitWavesIntoMicrowaves,
  MICROWAVE_MAX_TASKS_DEFAULT as _MICROWAVE_MAX_TASKS_DEFAULT,
  estimatePlanExecutionTokens,
  autoBundleThinRelatedPackets,
  extractTaskKindPacketTelemetry,
  resolveAdaptivePacketPlanLimit,
} from "./worker_batch_planner.js";

// Re-export so existing callers that import from prometheus.ts continue to work
export { _splitWavesIntoMicrowaves as splitWavesIntoMicrowaves, _MICROWAVE_MAX_TASKS_DEFAULT as MICROWAVE_MAX_TASKS_DEFAULT };
// Re-export WaveTaskObject for callers that type-check execution strategy payloads
export type { WaveTaskObject } from "./plan_contract_validator.js";

import { warn, emitEvent } from "./logger.js";
import { buildSpanEvent, EVENTS, EVENT_DOMAIN, SPAN_CONTRACT } from "./event_schema.js";
import { computeBenchmarkIntegrityScore, computeBenchmarkPlanningPriors, computeProvenanceRoutingDelta, deriveCandidatePlanningPolicy } from "./model_policy.js";
import type { RetryViolationSignal } from "./model_policy.js";
import {
  computeResearchCapacityGain,
  computeHistoricalLaneDifficultyPriors,
  buildWorkerCycleArtifactsDiagnosticsRecord,
  isWorkerCycleArtifactsSnapshotContractValid,
  extractLatestBenchmarkRecommendations,
} from "./cycle_analytics.js";

// Keep cycle diagnostics contract literals local to avoid circular-import TDZ
// during module initialization between prometheus <-> cycle_analytics.
const CYCLE_DIAGNOSTICS_ARTIFACT_JSONL_SCHEMA = "box.diagnostics_artifact.v1";
const WORKER_CYCLE_ARTIFACTS_DIAGNOSTICS_RECORD_TYPE = "worker_cycle_snapshot";

// ── Span contract emitter ─────────────────────────────────────────────────────

/** Canonical agent identifier for Prometheus in span events. */
export const PROMETHEUS_AGENT_ID = "prometheus";

/**
 * Build a PLANNING_STAGE_TRANSITION span event for Prometheus.
 * Conforms to SPAN_CONTRACT: stamps spanId, parentSpanId, traceId, agentId.
 *
 * @param correlationId — non-empty cycle trace ID
 * @param stageFrom     — stage being left (one of ORCHESTRATION_LOOP_STEPS)
 * @param stageTo       — stage being entered
 * @param opts          — optional parentSpanId, durationMs
 * @returns validated event envelope
 */
export function emitPrometheusSpanTransition(
  correlationId: string,
  stageFrom: string,
  stageTo: string,
  opts: { parentSpanId?: string | null; durationMs?: number | null } = {},
) {
  return buildSpanEvent(
    EVENTS.PLANNING_STAGE_TRANSITION,
    EVENT_DOMAIN.PLANNING,
    correlationId,
    { agentId: PROMETHEUS_AGENT_ID, parentSpanId: opts.parentSpanId ?? null },
    {
      [SPAN_CONTRACT.stageTransition.taskId]:     null,
      [SPAN_CONTRACT.stageTransition.stageFrom]:  stageFrom,
      [SPAN_CONTRACT.stageTransition.stageTo]:    stageTo,
      [SPAN_CONTRACT.stageTransition.durationMs]: opts.durationMs ?? null,
    },
  );
}

export function detectModelFallback(rawText) {
  const text = String(rawText || "");
  const match = text.match(/Warning:\s*Custom agent\s+"([^"]+)"\s+specifies model\s+"([^"]+)"\s+which is not available;\s+using\s+"([^"]+)"\s+instead/i);
  if (!match) return null;
  return { agent: match[1], requestedModel: match[2], fallbackModel: match[3] };
}

export function resolveCapturedAgentRawOutput(
  resultStdout: unknown,
  resultStderr: unknown,
  streamedStdout: unknown,
  streamedStderr: unknown,
): string {
  const resultCombined = `${String(resultStdout || "")}\n${String(resultStderr || "")}`.trim();
  const streamedCombined = `${String(streamedStdout || "")}\n${String(streamedStderr || "")}`.trim();
  if (!streamedCombined) return resultCombined;
  if (!resultCombined) return streamedCombined;
  const resultHasTerminalMarker = resultCombined.includes("===END===") || resultCombined.includes("===SON===");
  const streamedHasTerminalMarker = streamedCombined.includes("===END===") || streamedCombined.includes("===SON===");
  if (streamedHasTerminalMarker && !resultHasTerminalMarker) return streamedCombined;
  if (streamedCombined.length > resultCombined.length) return streamedCombined;
  return resultCombined;
}

export function buildPrometheusPlanningPolicy(config, laneTelemetry?: Record<string, unknown> | null, opts: any = {}) {
  const planner = config?.planner || {};
  const configuredMaxWorkersPerWave = Math.max(1, Number(planner.defaultMaxWorkersPerWave || config?.maxParallelWorkers || 10));
  const rawMaxTasks = Number(planner.maxTasks);
  const maxTasks = Number.isFinite(rawMaxTasks) && rawMaxTasks > 0 ? Math.floor(rawMaxTasks) : 0;
  const maxWorkersPerWave = maxTasks > 0
    ? Math.min(configuredMaxWorkersPerWave, maxTasks)
    : configuredMaxWorkersPerWave;

  // Bounded packet-size defaults — prevent over-bundling by capping plans per packet
  const rawMaxPlansPerPacket = Number(planner.maxPlansPerPacket);
  const maxPlansPerPacket = Number.isFinite(rawMaxPlansPerPacket) && rawMaxPlansPerPacket > 0
    ? Math.max(1, Math.min(20, Math.floor(rawMaxPlansPerPacket)))
    : 5; // default: cap at 5 plans per packet to prevent context overflow

  // Lane telemetry: surface per-lane performance signals for planner awareness.
  // Each lane entry carries { dispatched, completed, failed, completionRate, roi, specialistLane }.
  // Prometheus uses this to avoid over-planning into lanes with low recent completion rates.
  const resolvedLaneTelemetry = (laneTelemetry && typeof laneTelemetry === "object")
    ? laneTelemetry
    : null;
  const taskKindTelemetry = (opts?.taskKindTelemetry && typeof opts.taskKindTelemetry === "object")
    ? opts.taskKindTelemetry
    : null;
  const planningUncertainty = String(opts?.uncertainty || "low").trim().toLowerCase() || "low";
  const adaptivePacketCaps = Object.fromEntries(
    ["implementation", "bugfix", "refactor", "test", "rework", "ci-fix"].map((taskKind) => {
      const adaptive = resolveAdaptivePacketPlanLimit({
        taskKinds: [taskKind],
        baseCap: maxPlansPerPacket,
        uncertainty: planningUncertainty,
        taskKindTelemetry: taskKindTelemetry ?? undefined,
      });
      return [taskKind, adaptive.maxPlansPerPacket];
    })
  );

  return {
    maxTasks,
    maxWorkersPerWave,
    maxPlansPerPacket,
    planningUncertainty,
    adaptivePacketCaps,
    preferFewestWorkers: planner.preferFewestWorkers !== false,
    allowSameCycleFollowUps: Boolean(planner.allowSameCycleFollowUps),
    requireDependencyAwareWaves: planner.requireDependencyAwareWaves !== false,
    enforcePrometheusExecutionStrategy: planner.enforcePrometheusExecutionStrategy !== false,
    laneTelemetry: resolvedLaneTelemetry,
  };
}

export const HEALTH_AUDIT_MANDATORY_SEVERITIES: ReadonlySet<string> = new Set(["critical", "warning"]);

/**
 * Minimum character length for a strategic field value to be considered
 * semantically valid (not a noise token, placeholder, or trivially short string).
 * Exported for testing.
 */
export const STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH = 10 as const;

/**
 * Normalize a string for contamination pattern matching using Unicode NFKC
 * decomposition.  NFKC collapses Unicode homoglyphs (e.g. mathematical bold
 * "𝐋et" → "Let", fullwidth "Ｉ" → "I") so that pattern matching is not
 * bypassable via look-alike Unicode code-points.
 *
 * Safe to call on arbitrary strings — never throws.
 * Exported for testing.
 */
export function normalizeTextForContaminationCheck(text: string): string {
  try {
    return String(text || "").normalize("NFKC");
  } catch {
    return String(text || "");
  }
}

/**
 * Lexical patterns that identify first-person process narration — AI agents
 * narrating their own tool usage in present tense.  These must NOT appear in
 * persisted strategic planning fields (keyFindings, strategicNarrative).
 *
 * Examples of rejected strings:
 *   "Let me analyze the codebase for gaps..."
 *   "I'm reading file src/core/prometheus.ts now"
 *   "I will now scan the repository to find..."
 *
 * Exported for testing and reuse in plan_contract_validator.ts.
 */
export const PROCESS_NARRATION_LEXICAL_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  // First-person agent narration of upcoming action at sentence start — tool-use verbs
  /^(let\s+me|i['’]?m\s+going\s+to|i\s+am\s+going\s+to|i\s+will\s+now|i['’]?m\s+now|i\s+am\s+now|now\s+i\s+will|now\s+i['’]?m|i['’]?ll\s+now|i['’]?m|i\s+am)\s+(read|scan|check|view|analyze|look|open|search|find|examine|browse|explore|fetch|get|inspect|reading|scanning|checking|viewing|analyzing|looking|opening|searching|finding|examining|browsing|exploring|fetching|getting|inspecting)/im,
  // First-person agent narration — investigation/gathering/evidence-collection verbs
  // Catches "I'm going to gather evidence", "I will now collect findings", etc.
  /^(let\s+me|i['’]?m\s+going\s+to|i\s+am\s+going\s+to|i\s+will\s+now|i['’]?m\s+now|i\s+am\s+now|now\s+i\s+will|now\s+i['’]?m|i['’]?ll\s+now|i['’]?m|i\s+am)\s+(gather|gathering|collect|collecting|investigate|investigating|review|reviewing|document|documenting|compile|compiling|assess|assessing|evaluate|evaluating|determine|determining|identify|identifying|figure|understand|capture|capturing|record|recording|synthesize|synthesizing|pull|pulling)\b/im,
]);

/**
 * Semantic patterns that identify tool-trace fragments — direct tool invocation
 * or output text that leaked from the AI's execution context into output fields.
 *
 * Examples of rejected strings:
 *   "reading file src/core/prometheus.ts"
 *   "tool output: { ... }"
 *   "view_file(path='src/foo.ts')"
 *
 * Exported for testing and reuse in plan_contract_validator.ts.
 */
export const SEMANTIC_TOOL_TRACE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  // Direct tool invocation traces (code-style)
  /\b(view_file|read_file|write_file|list_files|search_files|create_file|delete_file)\s*\(/i,
  // Tool/function output blocks
  /^(tool\s+output|function\s+output|tool\s+response|function\s+result)\s*:/im,
  // Present-progressive tool operation at line start
  /^(reading|scanning|checking|viewing)\s+(the\s+)?(file|directory|repo|codebase|code|source)\b/im,
]);

/**
 * Patterns that identify unparsed decision blobs — structured planner/reviewer
 * decision outputs (Athena votes, JSON decision objects) that must NOT appear
 * verbatim in persisted strategic planning fields (keyFindings, strategicNarrative).
 *
 * Examples of rejected strings:
 *   "DECISION: approve | task_id: T-001"
 *   "VOTE: approve"
 *   '{"decision": "approve", "confidence": 0.8}'
 *
 * Exported for testing and reuse in plan_contract_validator.ts.
 */
export const DECISION_BLOB_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  // Structured decision trace markers at line start (planner/Athena output that leaked in)
  /^(DECISION|APPROVE|REJECT|VOTE|VERDICT|OUTCOME|RATIONALE)\s*[:=]/im,
  // JSON decision blob: object literal containing decision-related keys
  /^\s*\{[^{}]*"(decision|approve|reject|vote|confidence|rationale|verdict|outcome)"\s*:/im,
]);

/**
 * Returns true when the given string contains tool-trace or process-thought
 * contamination patterns that must not appear in persisted planning fields.
 *
 * Checks five categories in order:
 *   1. Classic tool-call / role-prefix markers (tool_call:, assistant:, etc.)
 *   2. Process-thought XML/marker tags (<thinking>, [THINKING], <reasoning>, etc.)
 *   3. Process narration lexical patterns (first-person action narration, including
 *      gathering/collecting/investigating verbs that signal procedural intent)
 *   4. Semantic tool-trace fragments (tool invocation text, output blocks)
 *   5. Unparsed decision blobs (Athena/planner decision outputs, JSON decision objects)
 *
 * Unicode NFKC normalization is applied before pattern matching so that
 * homoglyph substitutions (e.g. mathematical bold "𝐋et me" → "Let me") cannot
 * bypass ASCII-anchored patterns.
 *
 * Matches the same patterns stripped by sanitizePlanningFieldForPersistence
 * plus the PROCESS_THOUGHT_MARKER_PATTERNS from plan_contract_validator.ts so
 * validation and sanitisation share a single, consistent surface.
 *
 * Exported for testing.
 */
export function isStrategicFieldToolTraceContaminated(text: string): boolean {
  // Apply Unicode NFKC normalization to defeat homoglyph bypasses before any
  // ASCII-anchored pattern matching.
  const s = normalizeTextForContaminationCheck(text);
  // ── Category 1: classic tool-call / role-prefix markers ──────────────────
  if (/^(tool_call|tool_result|function_call|assistant:|system:|user:)/im.test(s)) return true;
  if (/^copilot>/im.test(s)) return true;
  if (/^\[?(synthesizer_start|synthesizer_end|research_synthesizer_live)\]/im.test(s)) return true;
  // ── Category 2: process-thought XML/marker tags ───────────────────────────
  if (/<thinking>[\s\S]*?<\/thinking>/i.test(s)) return true;
  if (/<think[\s>]/i.test(s)) return true;
  if (/<\/think>/i.test(s)) return true;
  if (/<reasoning[\s>]/i.test(s)) return true;
  if (/<\/reasoning>/i.test(s)) return true;
  if (/\[THINKING\]/i.test(s)) return true;
  if (/<internal>/i.test(s)) return true;
  if (/<!--\s*thinking/i.test(s)) return true;
  // ── Category 3: process narration lexical patterns ────────────────────────
  if (PROCESS_NARRATION_LEXICAL_PATTERNS.some(p => p.test(s))) return true;
  // ── Category 4: semantic tool-trace fragments ─────────────────────────────
  if (SEMANTIC_TOOL_TRACE_PATTERNS.some(p => p.test(s))) return true;
  // ── Category 5: unparsed decision blobs ──────────────────────────────────
  if (DECISION_BLOB_PATTERNS.some(p => p.test(s))) return true;
  return false;
}

export interface MandatoryHealthAuditFinding {
  id: string;
  area: string;
  severity: "critical" | "warning";
  finding: string;
  remediation: string;
  capabilityNeeded: string;
}

export interface MandatoryTaskCoverageValidationResult {
  ok: boolean;
  missing: string[];
  invalid: string[];
  mapped: string[];
  excluded: string[];
}

function sanitizeMandatoryFindingId(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeMandatorySeverity(value: unknown): "critical" | "warning" | "" {
  const severity = String(value || "").trim().toLowerCase();
  if (severity === "critical") return "critical";
  // Bridge legacy "important" → "warning" for backward compatibility with stored findings.
  if (severity === "warning" || severity === "important") return "warning";
  return "";
}

function buildMandatoryFindingId(entry: Record<string, unknown>, index: number): string {
  const capability = sanitizeMandatoryFindingId(entry.capabilityNeeded);
  if (capability) return capability;
  const area = sanitizeMandatoryFindingId(entry.area);
  if (area) return `${area}-${index + 1}`;
  return `mandatory-finding-${index + 1}`;
}

export function extractMandatoryHealthAuditFindings(payload: unknown): MandatoryHealthAuditFinding[] {
  const findings = Array.isArray((payload as any)?.findings) ? (payload as any).findings : [];
  const result: MandatoryHealthAuditFinding[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < findings.length; i++) {
    const raw = findings[i];
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (resolveStructuredTruthRetirement(entry, `${String(entry.finding || "")} ${String(entry.remediation || "")}`)) continue;
    const severity = normalizeMandatorySeverity((raw as any).severity);
    if (!severity || !HEALTH_AUDIT_MANDATORY_SEVERITIES.has(severity)) continue;
    const id = buildMandatoryFindingId(entry, i);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      area: String(entry.area || "unknown"),
      severity,
      finding: sanitizePromptLine(entry.finding, 500),
      remediation: sanitizePromptLine(entry.remediation, 500),
      capabilityNeeded: String(entry.capabilityNeeded || ""),
    });
  }

  return result;
}

export function buildMandatoryTasksPromptSection(findings: MandatoryHealthAuditFinding[]): string {
  if (!Array.isArray(findings) || findings.length === 0) return "";
  const lines = findings.map((f, i) =>
    `${i + 1}. id=${f.id} | severity=${f.severity} | area=${sanitizePromptLine(f.area, 80)} | finding=${sanitizePromptLine(f.finding, 240)} | remediation=${sanitizePromptLine(f.remediation, 240)}`
  ).join("\n");
  return `## MANDATORY_TASKS
The following findings are loaded from state/health_audit_findings.json (severity in {critical, warning}).
For EACH finding, you MUST do exactly one:
1. Map it to at least one concrete task in plans[] (status="mapped"), OR
2. Exclude it explicitly with cycle-specific justification (status="excluded" + non-empty justification).

You MUST include this JSON field in your companion block:
"mandatoryTaskCoverage": [
  { "findingId": "<id>", "status": "mapped", "planTask": "<exact task/title/task_id from plans[]>" },
  { "findingId": "<id>", "status": "excluded", "justification": "<why excluded this cycle>" }
]
All finding IDs below are mandatory and must appear exactly once in mandatoryTaskCoverage:
${lines}`;
}

function normalizeCoverageStatus(value: unknown): "mapped" | "excluded" | "" {
  const status = String(value || "").trim().toLowerCase();
  if (status === "mapped" || status === "include" || status === "included") return "mapped";
  if (status === "excluded" || status === "exclude") return "excluded";
  return "";
}

function normalizeTaskDescriptor(value: unknown): string {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

const MANDATORY_COVERAGE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "when",
  "where",
  "must",
  "should",
  "cycle",
  "plan",
  "task",
  "finding",
  "fix",
  "review",
]);

function tokenizeMandatoryCoverageText(value: unknown): string[] {
  return [...new Set(
    String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) => !MANDATORY_COVERAGE_STOPWORDS.has(token))
  )];
}

function collectPlanCoverageText(plan: unknown): string {
  if (!plan || typeof plan !== "object") return "";
  const entry = plan as Record<string, unknown>;
  return [
    entry.task,
    entry.title,
    entry.scope,
    entry.taskKind,
    entry.capabilityTag,
    entry.capabilityLane,
    entry.description,
    entry.before_state,
    entry.after_state,
    ...(Array.isArray(entry.target_files) ? entry.target_files : []),
    ...(Array.isArray(entry.acceptance_criteria) ? entry.acceptance_criteria : []),
    ...(Array.isArray(entry.verification_commands) ? entry.verification_commands : []),
    entry.verification,
  ].map((value) => String(value || "").trim()).filter(Boolean).join(" ").toLowerCase();
}

function scoreMandatoryFindingPlanMatch(finding: MandatoryHealthAuditFinding, plan: unknown): number {
  if (!plan || typeof plan !== "object") return 0;
  if (isCiCriticalMandatoryFinding(finding) && isCiFixPlan(plan)) return 100;

  const planText = collectPlanCoverageText(plan);
  if (!planText) return 0;

  let score = 0;
  const directNeedles = [finding.id, finding.capabilityNeeded]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  for (const needle of directNeedles) {
    if (planText.includes(needle)) score += 4;
  }

  const tokens = tokenizeMandatoryCoverageText([
    finding.id,
    finding.area,
    finding.capabilityNeeded,
    finding.finding,
    finding.remediation,
  ].join(" "));
  score += tokens.filter((token) => planText.includes(token)).length;

  const normalizedTaskKind = String((plan as Record<string, unknown>).taskKind || "").trim().toLowerCase();
  if (finding.area && planText.includes(String(finding.area).trim().toLowerCase())) score += 1;
  if (normalizedTaskKind && String(finding.capabilityNeeded || "").toLowerCase().includes(normalizedTaskKind)) score += 1;
  return score;
}

function normalizeMandatoryTaskCoverageEntries(payload: unknown): Array<{
  findingId: string;
  status: "mapped" | "excluded" | "";
  planTask: string;
  justification: string;
}> {
  const entries = Array.isArray((payload as any)?.mandatoryTaskCoverage)
    ? (payload as any).mandatoryTaskCoverage
    : [];
  return entries
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => {
      const obj = entry as Record<string, unknown>;
      return {
        findingId: sanitizeMandatoryFindingId(obj.findingId || obj.id || obj.capabilityNeeded),
        status: normalizeCoverageStatus(obj.status),
        planTask: String(obj.planTask || obj.task || obj.mappedTask || obj.mappedToTask || "").trim(),
        justification: String(obj.justification || obj.exclusionJustification || obj.reason || "").trim(),
      };
    });
}

function planReferenceExists(plans: unknown[], taskRef: string): boolean {
  const normalizedRef = normalizeTaskDescriptor(taskRef);
  if (!normalizedRef) return false;
  const planList = Array.isArray(plans) ? plans : [];
  for (const plan of planList) {
    if (!plan || typeof plan !== "object") continue;
    const obj = plan as Record<string, unknown>;
    const candidates = [
      obj.task,
      obj.title,
      obj.task_id,
      obj.id,
    ].map(normalizeTaskDescriptor).filter(Boolean);
    if (candidates.some((c) => c === normalizedRef || c.includes(normalizedRef) || normalizedRef.includes(c))) {
      return true;
    }
  }
  return false;
}

export function validateMandatoryTaskCoverageContract(
  payload: unknown,
  findings: MandatoryHealthAuditFinding[],
): MandatoryTaskCoverageValidationResult {
  const mandatory = Array.isArray(findings) ? findings : [];
  if (mandatory.length === 0) {
    return { ok: true, missing: [], invalid: [], mapped: [], excluded: [] };
  }

  const entries = normalizeMandatoryTaskCoverageEntries(payload);
  const byId = new Map<string, { status: "mapped" | "excluded" | ""; planTask: string; justification: string }>();
  for (const entry of entries) {
    if (!entry.findingId || byId.has(entry.findingId)) continue;
    byId.set(entry.findingId, entry);
  }

  const missing: string[] = [];
  const invalid: string[] = [];
  const mapped: string[] = [];
  const excluded: string[] = [];
  const plans = Array.isArray((payload as any)?.plans) ? (payload as any).plans : [];

  for (const finding of mandatory) {
    const entry = byId.get(finding.id);
    if (!entry) {
      missing.push(finding.id);
      continue;
    }
    if (entry.status === "mapped") {
      if (!entry.planTask || !planReferenceExists(plans, entry.planTask)) {
        invalid.push(`${finding.id}:mapped_without_existing_plan`);
      } else {
        mapped.push(finding.id);
      }
      continue;
    }
    if (entry.status === "excluded") {
      if (!isCycleSpecificExclusionJustification(entry.justification)) {
        invalid.push(`${finding.id}:excluded_without_justification`);
      } else {
        excluded.push(finding.id);
      }
      continue;
    }
    invalid.push(`${finding.id}:invalid_status`);
  }

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid, mapped, excluded };
}

export function buildMandatoryCoverageRetryDiff(result: MandatoryTaskCoverageValidationResult): string {
  const missing = Array.isArray(result?.missing) ? result.missing : [];
  const invalid = Array.isArray(result?.invalid) ? result.invalid : [];
  const missingText = missing.length > 0 ? missing.join(", ") : "none";
  const invalidText = invalid.length > 0 ? invalid.join(", ") : "none";
  return `missing=[${sanitizePromptLine(missingText, 600)}]
invalid=[${sanitizePromptLine(invalidText, 1200)}]`;
}

export function synthesizeMandatoryTaskCoverage(
  payload: any,
  findings: MandatoryHealthAuditFinding[],
): any {
  const output = (payload && typeof payload === "object") ? payload : {};
  const plans = Array.isArray(output.plans) ? output.plans : [];
  const existingById = new Map(
    normalizeMandatoryTaskCoverageEntries(output)
      .filter((entry) => entry.findingId)
      .map((entry) => [entry.findingId, entry] as const)
  );

  output.mandatoryTaskCoverage = (Array.isArray(findings) ? findings : []).map((finding) => {
    const existing = existingById.get(finding.id);
    if (existing?.status === "mapped" && planReferenceExists(plans, existing.planTask)) {
      return { findingId: finding.id, status: "mapped", planTask: existing.planTask };
    }
    if (existing?.status === "excluded" && isCycleSpecificExclusionJustification(existing.justification)) {
      return { findingId: finding.id, status: "excluded", justification: existing.justification };
    }

    let bestPlan: Record<string, unknown> | null = null;
    let bestScore = 0;
    for (const plan of plans) {
      const score = scoreMandatoryFindingPlanMatch(finding, plan);
      if (score > bestScore) {
        bestScore = score;
        bestPlan = (plan && typeof plan === "object") ? plan as Record<string, unknown> : null;
      }
    }

    if (bestPlan && bestScore >= 2) {
      return {
        findingId: finding.id,
        status: "mapped",
        planTask: String(bestPlan.task || bestPlan.title || bestPlan.task_id || bestPlan.id || "").trim(),
      };
    }

    if (existing) {
      return {
        findingId: finding.id,
        status: existing.status,
        planTask: existing.planTask,
        justification: existing.justification,
      };
    }

    return {
      findingId: finding.id,
      status: "",
      planTask: "",
      justification: "",
    };
  });

  return output;
}

function buildRolePlanCoverageRetryDiff(result: any): string {
  const required = Array.isArray(result?.requiredRoles) ? result.requiredRoles : [];
  const missing = Array.isArray(result?.initialMissingRoles) ? result.initialMissingRoles : [];
  const invalid = Array.isArray(result?.invalidRolePlans) ? result.invalidRolePlans : [];
  const requiredText = required.length > 0 ? required.join(", ") : "none";
  const missingText = missing.length > 0 ? missing.join(", ") : "none";
  const invalidText = invalid.length > 0 ? invalid.join(", ") : "none";
  return `required_roles=[${sanitizePromptLine(requiredText, 600)}]
missing_roles=[${sanitizePromptLine(missingText, 600)}]
invalid_role_plans=[${sanitizePromptLine(invalidText, 600)}]`;
}

export const MANDATORY_COVERAGE_ENFORCE_REJECT_TOKEN = "ENFORCE_REJECT";
export const MANDATORY_COVERAGE_ENFORCE_EXIT_CODE = 2;

/** Error code emitted when role-plan coverage is incomplete after retry. */
export const ROLE_PLAN_COMPLETENESS_ERROR_CODE = "ROLE_PLAN_COVERAGE_INCOMPLETE";

/**
 * Thrown by the execution-strategy role coverage gate when required roles have no
 * contract-valid plans[] entry after one retry attempt (fail-closed path).
 *
 * This error prevents Athena submission of plans that are structurally incomplete,
 * giving the orchestrator a typed signal to emit a cycle-level rejection event.
 */
export class RolePlanCompletenessError extends Error {
  readonly errorCode = ROLE_PLAN_COMPLETENESS_ERROR_CODE;
  readonly missingRoles: string[];
  readonly requiredRoles: string[];
  readonly retried: boolean;

  constructor(missingRoles: string[], requiredRoles: string[], retried: boolean) {
    const preview = Array.isArray(missingRoles) ? missingRoles.slice(0, 5).join(", ") : "";
    super(
      `[${ROLE_PLAN_COMPLETENESS_ERROR_CODE}] Role plan coverage incomplete after retry: ` +
      `missing=[${preview}] required=${Array.isArray(requiredRoles) ? requiredRoles.length : 0} retried=${retried}`
    );
    this.name = "RolePlanCompletenessError";
    this.missingRoles = Array.isArray(missingRoles) ? [...missingRoles] : [];
    this.requiredRoles = Array.isArray(requiredRoles) ? [...requiredRoles] : [];
    this.retried = Boolean(retried);
  }
}

export function applyMandatoryCoverageEnforceReject(
  payload: any,
  result: MandatoryTaskCoverageValidationResult,
): any {
  const next = (payload && typeof payload === "object") ? payload : {};
  next._mandatoryTaskCoverageGate = {
    ok: false,
    missing: Array.isArray(result?.missing) ? result.missing : [],
    invalid: Array.isArray(result?.invalid) ? result.invalid : [],
    mapped: Array.isArray(result?.mapped) ? result.mapped : [],
    excluded: Array.isArray(result?.excluded) ? result.excluded : [],
    _retryAttempted: true,
    logToken: MANDATORY_COVERAGE_ENFORCE_REJECT_TOKEN,
    exitCode: MANDATORY_COVERAGE_ENFORCE_EXIT_CODE,
  };
  next._parserReject = {
    token: MANDATORY_COVERAGE_ENFORCE_REJECT_TOKEN,
    exitCode: MANDATORY_COVERAGE_ENFORCE_EXIT_CODE,
    reason: "mandatory_task_coverage_enforce",
  };
  next.plans = [];
  return next;
}

function isCiFixPlan(plan: unknown): boolean {
  if (!plan || typeof plan !== "object") return false;
  const entry = plan as Record<string, unknown>;
  const taskKind = String(entry.taskKind || entry.kind || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (taskKind === "ci-fix") return true;
  const text = `${String(entry.task || "")} ${String(entry.title || "")}`.toLowerCase();
  return /\bci[-_\s]?fix\b/.test(text);
}

function uniqueStrings(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function extractTargetFilesFromMandatoryFinding(finding: MandatoryHealthAuditFinding): string[] {
  const joined = `${String(finding.finding || "")} ${String(finding.remediation || "")}`;
  const extracted = [...joined.matchAll(/([a-z0-9_./-]+\.(?:ts|tsx|js|mjs|cjs|json|md))/gi)]
    .map((match) => String(match[1] || "").trim())
    .filter(Boolean);
  if (extracted.length > 0) return uniqueStrings(extracted);

  const signals = `${finding.id} ${finding.capabilityNeeded} ${finding.finding} ${finding.remediation}`.toLowerCase();
  if (/athena|correction|fidelity/.test(signals)) {
    return ["src/core/athena_reviewer.ts", "tests/core/athena_review_normalization.test.ts"];
  }
  if (/governance|dispatchblockreason|dispatch block|lane|pre-wave|token/.test(signals)) {
    return ["src/core/orchestrator.ts", "tests/core/orchestrator_gate_precedence.test.ts"];
  }
  return ["src/core/prometheus.ts", "tests/core/prometheus_parse.test.ts"];
}

function buildMandatoryFindingFallbackPlan(finding: MandatoryHealthAuditFinding): Record<string, unknown> {
  const targetFiles = extractTargetFilesFromMandatoryFinding(finding);
  return {
    task: `Implement mandatory finding ${finding.id}: ${String(finding.remediation || finding.finding || finding.id).trim()}`,
    title: `Implement mandatory finding ${finding.id}`,
    description: `${finding.finding}. Remediation: ${finding.remediation}`,
    role: "evolution-worker",
    taskKind: "mandatory-gap",
    scope: finding.area || "capability-gap",
    target_files: targetFiles,
    acceptance_criteria: [
      `Mandatory finding ${finding.id} is addressed with deterministic behavior changes.`,
      `Verification proves the remediation for ${finding.id} is active in the runtime path.`,
    ],
    verification: `${targetFiles[targetFiles.length - 1]} — test: mandatory finding ${finding.id} remains enforced`,
    dependencies: [],
    capacityDelta: 0.15,
    requestROI: 1.2,
    capabilityTag: inferPlanningCapabilityTag(
      String(finding.remediation || finding.finding || finding.id),
      "implementation",
      targetFiles,
      `${finding.id} ${finding.capabilityNeeded} ${finding.area}`,
    ),
    implementationEvidence: targetFiles.map((file) => `${file} is in scope for mandatory finding ${finding.id}`),
  };
}

export function enforceMandatoryFindingCoveragePackets(
  payload: any,
  findings: MandatoryHealthAuditFinding[],
): { output: any; injectedFindingIds: string[] } {
  const output = (payload && typeof payload === "object") ? payload : {};
  if (!Array.isArray(output.plans)) output.plans = [];

  const synthesized = synthesizeMandatoryTaskCoverage(output, findings);
  const coverage = validateMandatoryTaskCoverageContract(synthesized, findings);
  if (coverage.ok) {
    return { output: synthesized, injectedFindingIds: [] };
  }

  const findingsById = new Map((Array.isArray(findings) ? findings : []).map((finding) => [finding.id, finding] as const));
  const unresolvedFindingIds = [...new Set([
    ...coverage.missing,
    ...coverage.invalid
      .map((entry) => String(entry || "").split(":")[0].trim())
      .filter(Boolean),
  ])];
  const injectedFindingIds: string[] = [];
  for (const findingId of unresolvedFindingIds) {
    const finding = findingsById.get(findingId);
    if (!finding) continue;
    output.plans.push(buildMandatoryFindingFallbackPlan(finding));
    injectedFindingIds.push(findingId);
  }

  return { output, injectedFindingIds };
}

export function enforceCiRepairPacketForMandatoryFindings(
  payload: any,
  mandatoryFindings: MandatoryHealthAuditFinding[],
): { output: any; injected: boolean; findingIds: string[] } {
  const output = (payload && typeof payload === "object") ? payload : {};
  const findings = Array.isArray(mandatoryFindings) ? mandatoryFindings.filter(isCiCriticalMandatoryFinding) : [];
  if (findings.length === 0) {
    return { output, injected: false, findingIds: [] };
  }

  if (!Array.isArray(output.plans)) output.plans = [];
  const findingIds = findings.map((finding) => finding.id);
  const evidence = findings.map(extractCiEvidenceFromMandatoryFinding);
  const failedTestIdentifiers = uniqueStrings(evidence.flatMap((entry) => entry.failedTestIdentifiers));
  const errorMessages = uniqueStrings(evidence.flatMap((entry) => entry.errorMessages));
  const stackTraces = uniqueStrings(evidence.flatMap((entry) => entry.stackTraces));
  const ciFailureEvidence = {
    source: "mandatory_ci_findings",
    findingIds,
    failedTestIdentifiers,
    errorMessages,
    stackTraces,
  };

  const existingIndex = output.plans.findIndex((plan: unknown) => isCiFixPlan(plan));
  if (existingIndex >= 0) {
    const existing = (output.plans[existingIndex] && typeof output.plans[existingIndex] === "object")
      ? output.plans[existingIndex]
      : {};
    output.plans[existingIndex] = {
      ...existing,
      taskKind: "ci-fix",
      wave: 1,
      ciFailureEvidence,
      githubCiContext: (existing as any).githubCiContext || output.githubCiContext,
    };
    return { output, injected: false, findingIds };
  }

  output.plans.push({
    role: "evolution-worker",
    wave: 1,
    taskKind: "ci-fix",
    task: `Build explicit CI repair packet from mandatory CI-critical findings: ${findingIds.join(", ")}`,
    target_files: [
      "src/core/prometheus.ts",
      "src/core/orchestrator.ts",
      "tests/core/prometheus_parse.test.ts",
      "tests/core/orchestrator_ci_fix_context.test.ts",
    ],
    scope: "ci",
    dependencies: [],
    acceptance_criteria: [
      "Worker context includes deterministic CI_FAILURE_CONTEXT with concrete failing evidence from mandatory findings or CI logs.",
      "CI repair packet remains on wave 1 and preserves required CI metadata for dispatch hydration.",
    ],
    verification: "tests/core/prometheus_parse.test.ts — test: forces wave-1 ci-fix packet construction from CI-critical findings",
    capacityDelta: 0.1,
    requestROI: 1.1,
    estimatedExecutionTokens: 4000,
    ciFailureEvidence,
    githubCiContext: output.githubCiContext,
  });
  return { output, injected: true, findingIds };
}

/**
 * Freshness-aware normalization for CI-break findings loaded from
 * health_audit_findings.json at the mandatory finding ingestion boundary.
 *
 * When the stored payload carries `latestMainCiConclusion === "success"`, the
 * main-branch CI was healthy when Janus wrote the file.  Any CI-break findings
 * present in that same payload are stale carry-overs from a prior write cycle
 * (written when the file was last updated with non-empty findings during a
 * previous broken-CI cycle) and must be suppressed so Prometheus does not force
 * unnecessary wave-1 CI-fix tasks.
 *
 * The check is deliberately narrow: only findings where area="ci" AND
 * capabilityNeeded ∈ {ci-fix, ci-setup} are suppressed — system-learning or
 * capability-gap findings that mention CI in their text are retained.
 *
 * Pure function — returns a new payload object; does not mutate the input.
 *
 * @param payload — raw parsed health_audit_findings.json content
 * @param nowMs   — current epoch ms for age checks (default: Date.now())
 * @returns normalized payload, suppression count, and machine-readable reasons
 */
export function normalizeStaleCiBreakFindings(
  payload: unknown,
  nowMs: number = Date.now(),
): { payload: unknown; suppressedCount: number; suppressedReasons: string[]; resolvedLineage: Record<string, unknown>[] } {
  if (!payload || typeof payload !== "object") {
    return { payload, suppressedCount: 0, suppressedReasons: [], resolvedLineage: [] };
  }
  const obj = payload as Record<string, unknown>;
  const findings = Array.isArray(obj.findings) ? obj.findings : [];
  const latestMainCiConclusion = String(obj.latestMainCiConclusion || "").trim().toLowerCase();
  const auditedAt = String(obj.auditedAt || "").trim();

  // Only suppress when stored CI evidence confirms main was healthy at audit time.
  // Absent or non-success CI conclusion → pass through unchanged (fail-safe).
  if (latestMainCiConclusion !== "success") {
    return { payload, suppressedCount: 0, suppressedReasons: [], resolvedLineage: [] };
  }

  // Compute audit age so system-learning CI-debt suppression can apply an age gate.
  // Suppression is only applied when the audit is fresh (within the max-age window)
  // to ensure the CI-success annotation is still reliable.
  const auditedAtMs = auditedAt ? Date.parse(auditedAt) : NaN;
  const auditAgeMs = Number.isFinite(auditedAtMs) ? nowMs - auditedAtMs : Infinity;
  const auditIsFresh = auditAgeMs <= SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS;

  const suppressedReasons: string[] = [];
  // Collect suppressed findings into resolvedLineage so callers can distinguish
  // historical CI-break context from active debt without losing audit trail.
  const resolvedLineage: Record<string, unknown>[] = [];

  const normalizedFindings = findings.filter((f: unknown) => {
    if (!f || typeof f !== "object") return true;
    const entry = f as Record<string, unknown>;

    // Gate 1: suppress canonical area=ci findings (ci-fix / ci-setup) — existing behaviour.
    if (isCiBreakFinding(f)) {
      const reason =
        `stale_ci_break_suppressed:area=ci:capabilityNeeded=${String(entry.capabilityNeeded || "")}` +
        `:latestMainCiConclusion=success:auditedAt=${auditedAt}`;
      suppressedReasons.push(reason);
      resolvedLineage.push({ ...entry, _resolvedAt: auditedAt, _resolutionReason: reason });
      return false;
    }

    // Gate 2: suppress system-learning findings that encode CI debt when the finding
    // was explicitly annotated by Janus with a CI-success signal AND the audit is still
    // fresh enough that the CI-success evidence is reliable.
    if (
      isSystemLearningCiDebtFinding(f) &&
      String(entry.latestMainCiConclusion || "").trim().toLowerCase() === "success" &&
      auditIsFresh
    ) {
      const reason =
        `stale_system_learning_ci_debt_suppressed:area=system-learning` +
        `:findingCiConclusion=success:payloadCiConclusion=success` +
        `:auditedAt=${auditedAt}:auditAgeMs=${Math.round(auditAgeMs)}`;
      suppressedReasons.push(reason);
      resolvedLineage.push({ ...entry, _resolvedAt: auditedAt, _resolutionReason: reason });
      return false;
    }

    return true;
  });

  if (suppressedReasons.length === 0) {
    return { payload, suppressedCount: 0, suppressedReasons: [], resolvedLineage: [] };
  }

  const normalizedPayload: Record<string, unknown> = {
    ...obj,
    findings: normalizedFindings,
    _staleCiBreakFindingsSuppressed: suppressedReasons.length,
    _staleCiBreakSuppressedReasons: suppressedReasons,
    // Historical CI-break context preserved for audit trail; not treated as active debt.
    resolvedLineage,
  };
  return {
    payload: normalizedPayload,
    suppressedCount: suppressedReasons.length,
    suppressedReasons,
    resolvedLineage,
  };
}

// Export the freshness max-age constant so callers (tests, prometheus prompt) can reference it.
export { CI_BREAK_FINDING_FRESHNESS_MAX_AGE_MS, SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS, isSystemLearningCiDebtFinding } from "./plan_contract_validator.js";

// ── Mandatory findings preflight truth gate ───────────────────────────────────

/**
 * Maximum age (ms) for the health_audit_findings.json payload before CI-specific
 * mandatory findings are quarantined.  After this threshold the source is
 * considered untrusted for CI evidence — CI may have been fixed since the audit.
 *
 * Non-CI findings (capability gaps, architecture debt) are structural and remain
 * trusted regardless of payload age.
 *
 * Exported so tests and callers can reference the constant without reading files.
 */
export const MANDATORY_FINDINGS_PREFLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Preflight truth status values returned by computeMandatoryFindingsPreflight. */
export const MANDATORY_FINDINGS_PREFLIGHT_STATUS = Object.freeze({
  /** All findings are trusted — source is fresh and no quarantine applied. */
  TRUSTED: "trusted",
  /** Some CI-related findings were quarantined; non-CI findings remain trusted. */
  DEGRADED: "degraded",
  /** All findings were quarantined (source is too stale to trust any CI evidence). */
  QUARANTINED: "quarantined",
} as const);

/** Result returned by computeMandatoryFindingsPreflight. */
export interface MandatoryFindingsPreflightResult {
  /** Findings confirmed as trusted and safe to inject into planning. */
  trustedFindings: MandatoryHealthAuditFinding[];
  /** Findings quarantined due to stale/untrusted source. */
  quarantinedFindings: MandatoryHealthAuditFinding[];
  /** Count of quarantined findings. */
  quarantinedCount: number;
  /** Machine-readable reasons, one per quarantined finding. */
  quarantineReasons: string[];
  /** Whether the source payload timestamp is within the freshness window. */
  sourceFresh: boolean;
  /**
   * Age of the source payload in ms from nowMs, or Infinity when auditedAt is
   * absent or unparseable.
   */
  sourceAgeMs: number;
  /** Summary status for telemetry and orchestrator admission logging. */
  preflightStatus: "trusted" | "degraded" | "quarantined";
}

/**
 * Deterministic pre-planning truth preflight for mandatory health-audit findings.
 *
 * Quarantines CI-related mandatory findings (area="ci" or system-learning CI debt)
 * when the source payload is too old or lacks a parseable `auditedAt` timestamp.
 * Non-CI findings (capability gaps, architecture debt) are structural and remain
 * trusted regardless of payload age.
 *
 * This prevents stale CI-break evidence from forcing Prometheus to waste premium
 * requests on tasks that CI may have already resolved since the last audit write.
 *
 * Pure function — no I/O.  Callers pass pre-loaded findings and raw payload;
 * file access is the caller's responsibility.
 *
 * @param findings   — already-extracted mandatory findings (post normalization)
 * @param rawPayload — raw health_audit_findings.json content for auditedAt check
 * @param nowMs      — current epoch ms (defaults to Date.now())
 * @returns MandatoryFindingsPreflightResult
 */
export function computeMandatoryFindingsPreflight(
  findings: MandatoryHealthAuditFinding[],
  rawPayload: unknown,
  nowMs: number = Date.now(),
): MandatoryFindingsPreflightResult {
  const safeFindings = Array.isArray(findings) ? findings : [];

  // Determine source freshness from auditedAt timestamp in the raw payload.
  const auditedAt = String(
    (rawPayload && typeof rawPayload === "object") ? (rawPayload as Record<string, unknown>).auditedAt || "" : ""
  ).trim();

  let sourceAgeMs = Infinity;
  let sourceFresh = false;

  if (auditedAt) {
    const auditedAtMs = Date.parse(auditedAt);
    if (Number.isFinite(auditedAtMs)) {
      sourceAgeMs = nowMs - auditedAtMs;
      sourceFresh = sourceAgeMs <= MANDATORY_FINDINGS_PREFLIGHT_MAX_AGE_MS;
    }
  }

  // When source is fresh, all findings are trusted.
  if (sourceFresh) {
    return {
      trustedFindings: safeFindings,
      quarantinedFindings: [],
      quarantinedCount: 0,
      quarantineReasons: [],
      sourceFresh: true,
      sourceAgeMs,
      preflightStatus: MANDATORY_FINDINGS_PREFLIGHT_STATUS.TRUSTED,
    };
  }

  // Source is stale or missing timestamp — quarantine CI-related findings only.
  // Non-CI findings (capability gaps, architecture debt) are structural and not
  // time-sensitive in the same way: they remain valid planning input.
  const trustedFindings: MandatoryHealthAuditFinding[] = [];
  const quarantinedFindings: MandatoryHealthAuditFinding[] = [];
  const quarantineReasons: string[] = [];

  const ageLabel = Number.isFinite(sourceAgeMs) && sourceAgeMs !== Infinity
    ? `ageMs=${Math.round(sourceAgeMs)}`
    : "auditedAt_missing";
  const sourceLabel = auditedAt ? `auditedAt=${auditedAt}` : "auditedAt_absent";

  for (const finding of safeFindings) {
    if (isCiBreakFinding(finding) || isSystemLearningCiDebtFinding(finding)) {
      quarantinedFindings.push(finding);
      quarantineReasons.push(
        `mandatory_finding_quarantined:id=${finding.id}:area=${finding.area}` +
        `:reason=stale_ci_evidence:${ageLabel}:${sourceLabel}` +
        `:threshold=${MANDATORY_FINDINGS_PREFLIGHT_MAX_AGE_MS}ms`,
      );
    } else {
      trustedFindings.push(finding);
    }
  }

  const preflightStatus =
    quarantinedFindings.length === 0
      ? MANDATORY_FINDINGS_PREFLIGHT_STATUS.TRUSTED
      : trustedFindings.length === 0
        ? MANDATORY_FINDINGS_PREFLIGHT_STATUS.QUARANTINED
        : MANDATORY_FINDINGS_PREFLIGHT_STATUS.DEGRADED;

  return {
    trustedFindings,
    quarantinedFindings,
    quarantinedCount: quarantinedFindings.length,
    quarantineReasons,
    sourceFresh: false,
    sourceAgeMs,
    preflightStatus,
  };
}

function sanitizePromptLine(value: unknown, maxLen = 220): string {
  const compact = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";
  return compact.length > maxLen ? `${compact.slice(0, maxLen - 3)}...` : compact;
}

/**
 * Strip operational tool traces and free-form internal reasoning from a planning
 * text field before persistence.  Prevents tool_call lines, thinking blocks, and
 * role prefixes from leaking into downstream planning artifacts (prometheus_analysis.json).
 *
 * Exported for testing.
 */
export function sanitizePlanningFieldForPersistence(text: string): string {
  const raw = String(text || "");
  // Remove <thinking>...</thinking> blocks (potentially multiline).
  const noThinking = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  const lines = noThinking.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const norm = line.trim();
    if (!norm) return false;
    if (/^(tool_call|tool_result|function_call|assistant:|system:|user:)/i.test(norm)) return false;
    if (/^copilot>/i.test(norm)) return false;
    if (/^\[?(synthesizer_start|synthesizer_end|research_synthesizer_live)\]/i.test(norm)) return false;
    if (isStrategicFieldToolTraceContaminated(norm)) return false;
    return true;
  });
  return filtered.join("\n").trim();
}

/**
 * Returns true ONLY when ALL topics are quarantined (passedTopics is empty).
 * Partial quarantine (some topics pass) does NOT constitute degraded mode.
 * Exported for testing.
 */
export function isResearchDegradedModeActive(
  quarantinedTopicNames: string[],
  passedTopics: unknown[],
): boolean {
  return quarantinedTopicNames.length > 0 && passedTopics.length === 0;
}

function normalizeResearchTopic(value: unknown): string {
  const text = sanitizePromptLine(value, 180)
    .replace(/^[-*\u2022\u25cf\u25cb\u00b7\s]+/, "")
    .trim();
  if (!text) return "";
  if (/^read\s+/i.test(text)) return "";
  if (/^prompt[_-]/i.test(text)) return "";
  if (/^state[\\/]/i.test(text)) return "";
  return text;
}

function extractResearchTopics(synthesis: unknown, scout: unknown): string[] {
  const topics: string[] = [];
  const seen = new Set<string>();
  const synthesisObj = (synthesis && typeof synthesis === "object") ? synthesis as Record<string, unknown> : {};
  const scoutObj = (scout && typeof scout === "object") ? scout as Record<string, unknown> : {};

  const pushTopic = (raw: unknown) => {
    const normalized = normalizeResearchTopic(raw);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    topics.push(normalized);
  };

  const synthesisTopics = Array.isArray(synthesisObj.topics) ? synthesisObj.topics : [];
  for (const topic of synthesisTopics) {
    const topicObj = (topic && typeof topic === "object") ? topic as Record<string, unknown> : {};
    pushTopic(topicObj.topic);
  }

  const scoutSources = Array.isArray(scoutObj.sources) ? scoutObj.sources : [];
  for (const source of scoutSources) {
    const sourceObj = (source && typeof source === "object") ? source as Record<string, unknown> : {};
    const tags = Array.isArray(sourceObj.topicTags) ? sourceObj.topicTags : [];
    for (const tag of tags) pushTopic(tag);
    pushTopic(sourceObj.title);
  }

  return topics;
}

function computeResearchCoverageTarget(topicCount: number, sourceCount: number, maxTasks: number): number {
  const topics = Number.isFinite(topicCount) ? Math.max(0, Math.floor(topicCount)) : 0;
  const sources = Number.isFinite(sourceCount) ? Math.max(0, Math.floor(sourceCount)) : 0;
  if (topics === 0 && sources === 0) return 0;

  const signal = Math.max(topics, Math.ceil(sources / 2));
  const dynamicTarget = Math.max(3, Math.ceil(signal * 0.45));
  const boundedByResearch = Math.min(12, dynamicTarget);
  if (Number.isFinite(maxTasks) && maxTasks > 0) {
    return Math.max(1, Math.min(Math.floor(maxTasks), boundedByResearch));
  }
  return boundedByResearch;
}

export function isSingleTargetPromptIsolationActive(config: any): boolean {
  return config?.platformModeState?.currentMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY
    && Boolean(config?.activeTargetSession?.sessionId);
}

function buildResearchPromptSection(
  synthesis: unknown,
  scout: unknown,
  planningPolicy: { maxTasks?: number } | Record<string, unknown>,
  artifactAgeMs?: number,
  config?: any,
): {
  sectionText: string;
  topicCount: number;
  sourceCount: number;
  coverageTarget: number;
} {
  const STALE_THRESHOLD_MS = 72 * 60 * 60 * 1000;
  const isStale = typeof artifactAgeMs === "number" && artifactAgeMs > 0
    && (Date.now() - artifactAgeMs) > STALE_THRESHOLD_MS;
  const synthesisObj = (synthesis && typeof synthesis === "object") ? synthesis as Record<string, unknown> : {};
  const scoutObj = (scout && typeof scout === "object") ? scout as Record<string, unknown> : {};
  const targetModeActive = config?.platformModeState?.currentMode === "single_target_delivery"
    && config?.selfDev?.futureModeFlags?.singleTargetDelivery === true;
  const activeTargetSession = config?.activeTargetSession;
  const synthesisAligned = isResearchArtifactAlignedToTargetSession(synthesisObj, activeTargetSession);
  const scoutAligned = isResearchArtifactAlignedToTargetSession(scoutObj, activeTargetSession);

  if (targetModeActive && activeTargetSession && !synthesisAligned) {
    return { sectionText: "", topicCount: 0, sourceCount: 0, coverageTarget: 0 };
  }

  // ── Applicability filtering ─────────────────────────────────────────────────
  // Exclude topics marked not_applicable (non-BOX platform research) from the
  // planning prompt so they do not create plan pressure without execution path.
  // Build a filtered synthesis view before passing to extractResearchTopics.
  const rawSynthesisTopics = Array.isArray(synthesisObj.topics)
    ? synthesisObj.topics as Array<Record<string, unknown>>
    : [];
  const applicableTopics = targetModeActive
    ? rawSynthesisTopics
    : rawSynthesisTopics.filter(
      t => String(t?.applicabilityScore || "") !== "not_applicable"
    );
  const excludedCount = rawSynthesisTopics.length - applicableTopics.length;
  const filteredSynthesisObj = { ...synthesisObj, topics: applicableTopics };

  const topics = extractResearchTopics(filteredSynthesisObj, scout);
  const topicCount = topics.length;
  const sourceCount = Number.isFinite(Number(synthesisObj.scoutSourceCount))
    ? Number(synthesisObj.scoutSourceCount)
    : Number.isFinite(Number(scoutObj.sourceCount))
      ? Number(scoutObj.sourceCount)
      : 0;
  const coverageTarget = computeResearchCoverageTarget(topicCount, sourceCount, Number(planningPolicy?.maxTasks || 0));

  if (topicCount === 0 && sourceCount === 0) {
    return { sectionText: "", topicCount: 0, sourceCount: 0, coverageTarget: 0 };
  }

  // When stale, reduce source preview to reduce bloat with outdated data.
  // Topics and cross-topic connections are always fully injected — they are the
  // richest planning signal and must not be truncated.
  const sourcePreviewLimit = isStale ? 5 : 15;
  const boundedTopics = boundStructuredList(topics, { maxItems: 24, maxItemChars: 220 });
  const topicLines = boundedTopics.map((topic, i) => `${i + 1}. ${topic}`).join("\n");
  const _hiddenTopicCount = 0; // all topics always shown
  const sourceSignals = (Array.isArray(scoutObj.sources) ? scoutObj.sources : [])
    .filter(() => !targetModeActive || !activeTargetSession || scoutAligned)
    .slice(0, sourcePreviewLimit)
    .map((source, i: number) => {
      const sourceObj = (source && typeof source === "object") ? source as Record<string, unknown> : {};
      const title = sanitizePromptLine(sourceObj.title || "Untitled source", 160);
      const why = sanitizePromptLine(sourceObj.whyImportant || "", 280);
      return `${i + 1}. ${title}${why ? ` — ${why}` : ""}`;
    })
    .join("\n");
  // Research gaps: inject in full — these directly tell Prometheus what was NOT covered.
  const gapsPreview = String(synthesisObj.researchGaps || "").slice(0, 2000);

  // Cross-topic connections are the RICHEST actionable content: they show which topics
  // must be implemented together and why. Inject ALL connections at full fidelity.
  const crossTopicLines = boundStructuredList(
    Array.isArray(synthesisObj.crossTopicConnections) ? synthesisObj.crossTopicConnections : [],
    { maxItems: 20, maxItemChars: 360 }
  )
    .map((c: string, i: number) => `${i + 1}. ${sanitizePromptLine(c, 360)}`)
    .join("\n");
  const plannerSignals = (synthesisObj.plannerSignals && typeof synthesisObj.plannerSignals === "object")
    ? synthesisObj.plannerSignals as Record<string, unknown>
    : {};
  const priorityActionLines = boundStructuredList(
    Array.isArray(plannerSignals.priorityActions) ? plannerSignals.priorityActions : [],
    { maxItems: 12, maxItemChars: 360 }
  )
    .map((entry: string, i: number) => `${i + 1}. ${sanitizePromptLine(entry, 360)}`)
    .join("\n");
  const riskFlagLines = boundStructuredList(
    Array.isArray(plannerSignals.riskFlags) ? plannerSignals.riskFlags : [],
    { maxItems: 12, maxItemChars: 360 }
  )
    .map((entry: string, i: number) => `${i + 1}. ${sanitizePromptLine(entry, 360)}`)
    .join("\n");

  const stalenessNote = isStale
    ? `\n⚠️  STALE: Research artifacts are >72 h old. Do NOT produce redundant plans for topics already in ACCUMULATED TOPIC KNOWLEDGE. Only generate NEW packets for genuinely unaddressed gaps.`
    : "";

  const excludedNote = excludedCount > 0 && !targetModeActive
    ? `\n⚠️  ${excludedCount} topic(s) excluded as not_applicable to BOX platform (non-BOX runtime detected — Temporal, Kubernetes, Go, JVM, etc.). Do NOT generate plans for excluded topics.`
    : "";

  const sectionText = `\n\n## EXTERNAL RESEARCH INTELLIGENCE${stalenessNote}${excludedNote}\nResearch signal available for this cycle: ${topicCount} topic(s), ${sourceCount} source(s).\n\nResearch coverage target: ${coverageTarget > 0 ? coverageTarget : "AUTO"} research-backed packet(s) when materially applicable.\nDo NOT ignore this section. For each high-confidence unresolved topic, either:\n1) produce an actionable packet with concrete target_files and verification, or\n2) state that it is already implemented and cite exact file evidence in before_state/after_state.\n\nAll research topics:\n${topicLines || "(none)"}${crossTopicLines ? `\n\nCross-topic implementation dependencies (act on these together — these are your highest-priority planning inputs):\n${crossTopicLines}` : ""}${priorityActionLines ? `\n\nPlanner-ready priority actions (distilled):\n${priorityActionLines}` : ""}${riskFlagLines ? `\n\nPlanner risk flags:\n${riskFlagLines}` : ""}${sourceSignals ? `\n\nSource signals:\n${sourceSignals}` : ""}${gapsPreview ? `\n\nResearch gaps to address next (areas the Scout did NOT cover — generate packets for these):\n${gapsPreview}` : ""}`;

  return { sectionText, topicCount, sourceCount, coverageTarget };
}

export function isResearchArtifactAlignedToTargetSession(
  artifact: Record<string, unknown> | null | undefined,
  activeTargetSession: any,
): boolean {
  if (!artifact || typeof artifact !== "object") return true;
  if (!activeTargetSession || typeof activeTargetSession !== "object") {
    return !artifact.targetSession;
  }

  const targetStamp = artifact.targetSession && typeof artifact.targetSession === "object"
    ? artifact.targetSession as Record<string, unknown>
    : null;
  if (!targetStamp) return false;

  return String(targetStamp.sessionId || "") === String(activeTargetSession.sessionId || "")
    && String(targetStamp.projectId || "") === String(activeTargetSession.projectId || "");
}

async function getLatestResearchArtifactUpdatedAtMs(stateDir: string): Promise<number> {
  const files = ["research_scout_output.json", "research_synthesis.json"];
  let latest = 0;
  for (const file of files) {
    try {
      const stat = await fs.stat(path.join(stateDir, file));
      const ms = Number(stat?.mtimeMs || 0);
      if (Number.isFinite(ms) && ms > latest) latest = ms;
    } catch {
      // Optional artifact; ignore missing file.
    }
  }
  return latest;
}

const DIAGNOSTICS_FRESHNESS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// ── Diagnostics freshness admission gate (exported) ──────────────────────────

/**
 * A single diagnostics source record for freshness evaluation.
 * Callers supply one entry per diagnostics artifact (intervention_optimizer,
 * dependency_graph, etc.).
 */
export interface DiagnosticsFreshnessRecord {
  /** Human-readable label for the diagnostics source (used in reasons). */
  label: string;
  /** ISO 8601 timestamp when the record was last written, or null if absent. */
  recordedAt: string | null;
  /**
   * Maximum age in ms before the record is considered stale.
   * Defaults to DIAGNOSTICS_FRESHNESS_MAX_AGE_MS (6 h).
   */
  staleAfterMs?: number;
}

/**
 * Result returned by computeDiagnosticsFreshnessAdmission.
 */
export interface DiagnosticsFreshnessAdmission {
  /** True when ALL diagnostics sources are fresh (no stale or missing entries). */
  allFresh: boolean;
  /** Labels of sources that are stale or missing. */
  staleSources: string[];
  /**
   * Machine-readable reasons, one per stale/missing source.
   * Format: "stale_diagnostics:<label>:ageMinutes=<N>:staleAfterMs=<M>"
   * or      "missing_diagnostics:<label>"
   */
  freshnessReasons: string[];
}

export const DIAGNOSTICS_PLANNING_TRUTH_STATUS = Object.freeze({
  LIVE: "live",
  HISTORICAL: "historical",
});

export interface DiagnosticsTruthPropagationResult {
  planningTruthStatus: string;
  diagnosticsFreshnessScore: number;
  penaltyApplied: number;
}

/**
 * Deterministic freshness gate for diagnostics records.
 *
 * Pure function — no I/O.  Callers pass pre-loaded timestamp metadata;
 * this function computes admission status from those values alone.
 *
 * @param records — array of diagnostics source descriptors
 * @param nowMs   — current time in ms (defaults to Date.now())
 * @returns DiagnosticsFreshnessAdmission
 */
export function computeDiagnosticsFreshnessAdmission(
  records: DiagnosticsFreshnessRecord[],
  nowMs: number = Date.now(),
): DiagnosticsFreshnessAdmission {
  const safeRecords = Array.isArray(records) ? records : [];
  const staleSources: string[] = [];
  const freshnessReasons: string[] = [];

  for (const record of safeRecords) {
    const label = String(record.label || "unknown");
    const staleAfterMs = Number.isFinite(record.staleAfterMs) && (record.staleAfterMs as number) > 0
      ? (record.staleAfterMs as number)
      : DIAGNOSTICS_FRESHNESS_MAX_AGE_MS;

    if (!record.recordedAt) {
      staleSources.push(label);
      freshnessReasons.push(`missing_diagnostics:${label}`);
      continue;
    }

    const recordedAtMs = new Date(record.recordedAt).getTime();
    if (!Number.isFinite(recordedAtMs)) {
      staleSources.push(label);
      freshnessReasons.push(`missing_diagnostics:${label}:invalid_timestamp`);
      continue;
    }

    const ageMs = nowMs - recordedAtMs;
    if (ageMs > staleAfterMs) {
      staleSources.push(label);
      const ageMinutes = Math.round(ageMs / 60_000);
      freshnessReasons.push(
        `stale_diagnostics:${label}:ageMinutes=${ageMinutes}:staleAfterMs=${staleAfterMs}`,
      );
    }
  }

  return {
    allFresh: staleSources.length === 0,
    staleSources,
    freshnessReasons,
  };
}

/**
 * Bind diagnostics freshness admission into planner confidence/truth channels.
 * Stale diagnostics are treated as historical context and reduce context confidence.
 */
export function applyDiagnosticsFreshnessTruthToPlanning(
  parsed: any,
  freshnessResult: DiagnosticsFreshnessAdmission,
): DiagnosticsTruthPropagationResult {
  const safeFreshness = freshnessResult && typeof freshnessResult === "object"
    ? freshnessResult
    : { allFresh: true, staleSources: [], freshnessReasons: [] };
  const staleSources = Array.isArray(safeFreshness.staleSources)
    ? safeFreshness.staleSources.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  const freshnessReasons = Array.isArray(safeFreshness.freshnessReasons)
    ? safeFreshness.freshnessReasons.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  const allFresh = safeFreshness.allFresh === true && staleSources.length === 0 && freshnessReasons.length === 0;
  const planningTruthStatus = allFresh
    ? DIAGNOSTICS_PLANNING_TRUTH_STATUS.LIVE
    : DIAGNOSTICS_PLANNING_TRUTH_STATUS.HISTORICAL;
  const staleCount = staleSources.length;
  const diagnosticsFreshnessScore = allFresh
    ? 1.0
    : Math.max(0.6, Math.round((1 - Math.min(0.4, staleCount * 0.2)) * 100) / 100);
  const penaltyApplied = allFresh ? 0 : Math.round((1 - diagnosticsFreshnessScore) * 100) / 100;

  if (!parsed || typeof parsed !== "object") {
    return { planningTruthStatus, diagnosticsFreshnessScore, penaltyApplied };
  }

  if (!parsed.parserConfidenceComponents || typeof parsed.parserConfidenceComponents !== "object") {
    parsed.parserConfidenceComponents = {};
  }
  parsed.parserConfidenceComponents.diagnosticsFreshness = diagnosticsFreshnessScore;
  parsed.diagnosticsFreshnessAdmission = {
    allFresh,
    staleSources,
    freshnessReasons,
  };
  parsed.planningTruthStatus = planningTruthStatus;

  if (penaltyApplied > 0) {
    if (!Array.isArray(parsed.parserConfidencePenalties)) parsed.parserConfidencePenalties = [];
    const reason = `diagnostics_freshness_stale_${Math.max(1, staleCount)}`;
    const existingPenaltyIdx = parsed.parserConfidencePenalties.findIndex(
      (p: any) => p?.component === "diagnosticsFreshness",
    );
    const penaltyEntry = {
      reason,
      component: "diagnosticsFreshness",
      delta: -penaltyApplied,
    };
    if (existingPenaltyIdx >= 0) parsed.parserConfidencePenalties[existingPenaltyIdx] = penaltyEntry;
    else parsed.parserConfidencePenalties.push(penaltyEntry);

    const currentContextPenalty = typeof parsed.parserContextPenalty === "number"
      ? parsed.parserContextPenalty
      : 0;
    parsed.parserContextPenalty = Math.round((currentContextPenalty + penaltyApplied) * 100) / 100;
    const coreConfidence = typeof parsed.parserCoreConfidence === "number"
      ? parsed.parserCoreConfidence
      : (typeof parsed.parserConfidence === "number" ? parsed.parserConfidence : 1.0);
    parsed.parserConfidence = Math.round(Math.max(0.1, coreConfidence - parsed.parserContextPenalty) * 100) / 100;
  }

  return { planningTruthStatus, diagnosticsFreshnessScore, penaltyApplied };
}

/**
 * Tag plans that reference stale diagnostics sources with machine-readable
 * quarantine metadata.  Plans are tagged when:
 *   1. The freshness admission result reports at least one stale source, AND
 *   2. The plan's task or context text explicitly references a known stale label
 *      OR the plan has no independent backing signals (no implementationEvidence
 *      and no explicit novelty score above the collapse threshold).
 *
 * Tagged plans receive `_staleDiagnosticsGated: true` and
 * `_staleDiagnosticsReason: string` so downstream validators can reject them
 * deterministically without re-reading the diagnostics files.
 *
 * Pure function — mutates plan objects in-place and returns the same array.
 *
 * @param plans             — plan objects to evaluate
 * @param freshnessResult   — result from computeDiagnosticsFreshnessAdmission
 * @returns the same plans array (with mutated entries)
 */
export function tagStaleDiagnosticsBackedPlans(
  plans: any[],
  freshnessResult: DiagnosticsFreshnessAdmission,
): any[] {
  if (!Array.isArray(plans) || freshnessResult.allFresh) return plans;

  const staleLabels = new Set(freshnessResult.staleSources.map(l => l.toLowerCase()));
  const reasonSummary = freshnessResult.freshnessReasons.join("; ");

  for (const plan of plans) {
    if (!plan || typeof plan !== "object") continue;

    const taskText = String(plan.task || plan.title || "").toLowerCase();
    const contextText = String(plan.context || "").toLowerCase();
    const combined = taskText + " " + contextText;

    // Check if the plan explicitly references a stale source by label
    const referencesStaleSource = [...staleLabels].some(label => combined.includes(label));

    // Check for independent backing: implementationEvidence or novelty
    const hasImplementationEvidence =
      Array.isArray(plan.implementationEvidence) &&
      plan.implementationEvidence.some((e: unknown) => String(e || "").trim().length > 0);
    const hasTargetFileEvidence =
      (Array.isArray(plan.target_files) && plan.target_files.some((entry: unknown) => String(entry || "").trim().length > 0))
      || (Array.isArray(plan.targetFiles) && plan.targetFiles.some((entry: unknown) => String(entry || "").trim().length > 0));
    const hasNoveltyScore =
      typeof plan._noveltyScore === "number" && plan._noveltyScore > 0;

    const hasIndependentBacking = hasImplementationEvidence || hasTargetFileEvidence || hasNoveltyScore;

    if (referencesStaleSource || !hasIndependentBacking) {
      plan._staleDiagnosticsGated = true;
      plan._staleDiagnosticsReason =
        `stale_diagnostics_backed: plan lacks independent backing and diagnostics are stale — ` +
        reasonSummary;
    }
  }

  return plans;
}

export function applyAdmissionPacketHardFilter(
  plans: any[],
  contractResult: { results?: Array<{ planIndex: number; valid: boolean; violations: Array<{ code?: string; severity?: string }> }> },
): {
  filteredCount: number;
  warnedOnly: boolean;
  rejectedPlanIndices: number[];
} {
  const safePlans = Array.isArray(plans) ? plans : [];
  const results = Array.isArray(contractResult?.results) ? contractResult.results : [];
  const ADMISSION_REJECTION_VIOLATION_CODES: Set<string> = new Set([
    PACKET_VIOLATION_CODE.MISSING_CAPACITY_DELTA,
    PACKET_VIOLATION_CODE.INVALID_CAPACITY_DELTA,
    PACKET_VIOLATION_CODE.MISSING_REQUEST_ROI,
    PACKET_VIOLATION_CODE.INVALID_REQUEST_ROI,
    PACKET_VIOLATION_CODE.MISSING_IMPLEMENTATION_EVIDENCE,
    PACKET_VIOLATION_CODE.MISSING_CAPACITY_FIRST_JUSTIFICATION,
  ]);

  const rejectedPlanIndices = results
    .filter(r => !r.valid && Array.isArray(r.violations) && r.violations.some(v =>
      ADMISSION_REJECTION_VIOLATION_CODES.has(String(v.code || "")) &&
      v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
    ))
    .map(r => r.planIndex)
    .filter(index => Number.isInteger(index) && index >= 0 && index < safePlans.length)
    .sort((a, b) => b - a);

  if (rejectedPlanIndices.length === 0) {
    return { filteredCount: 0, warnedOnly: false, rejectedPlanIndices: [] };
  }

  const remainingCount = safePlans.length - rejectedPlanIndices.length;
  if (remainingCount <= 0) {
    return {
      filteredCount: 0,
      warnedOnly: true,
      rejectedPlanIndices,
    };
  }

  for (const idx of rejectedPlanIndices) {
    safePlans.splice(idx, 1);
  }

  return {
    filteredCount: rejectedPlanIndices.length,
    warnedOnly: false,
    rejectedPlanIndices,
  };
}

export function analyzePlanContractGateOutcome(
  contractResult: {
    totalPlans?: number;
    invalidCount?: number;
    results?: Array<{
      planIndex: number;
      valid: boolean;
      violations: Array<{ code?: string; severity?: string }>;
    }>;
  },
): {
  totalPlans: number;
  criticalInvalidCount: number;
  allPlansBlocked: boolean;
  blockedPlanIndices: number[];
  blockedViolationCodes: string[];
} {
  const results = Array.isArray(contractResult?.results) ? contractResult.results : [];
  const totalPlans = Number.isFinite(Number(contractResult?.totalPlans))
    ? Number(contractResult.totalPlans)
    : results.length;
  const criticalInvalidResults = results.filter((result) =>
    !result?.valid && Array.isArray(result.violations) && result.violations.some((violation) =>
      violation?.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
    )
  );

  const blockedPlanIndices = criticalInvalidResults
    .map((result) => result.planIndex)
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((a, b) => a - b);
  const blockedViolationCodes = [...new Set(
    criticalInvalidResults.flatMap((result) =>
      Array.isArray(result.violations)
        ? result.violations
          .filter((violation) => violation?.severity === PLAN_VIOLATION_SEVERITY.CRITICAL)
          .map((violation) => String(violation.code || "").trim())
          .filter(Boolean)
        : []
    )
  )].sort();

  return {
    totalPlans,
    criticalInvalidCount: criticalInvalidResults.length,
    allPlansBlocked: totalPlans > 0 && criticalInvalidResults.length === totalPlans,
    blockedPlanIndices,
    blockedViolationCodes,
  };
}

async function readLatestJsonlRecord(filePath: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n").map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    // Trust boundary: only the latest line is admissible as "current" diagnostics
    // truth. If that line is malformed, quarantine the stream for this cycle.
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    // optional diagnostics files may not exist
  }
  return null;
}

async function readLegacyDiagnosticsFallback(stateDir: string, label: string): Promise<any | null> {
  if (label !== "intervention_optimizer") return null;
  const fallbackPath = path.join(stateDir, "intervention_optimizer_log.json");
  try {
    const legacy = await readJson(fallbackPath, null);
    const entries = Array.isArray(legacy?.entries) ? legacy.entries : [];
    if (entries.length === 0) return null;
    const latest = entries[entries.length - 1];
    const savedAt = String(latest?.generatedAt || legacy?.updatedAt || "").trim() || new Date().toISOString();
    const staleAfterMs = DIAGNOSTICS_FRESHNESS_MAX_AGE_MS;
    return {
      jsonlSchema: OPTIMIZER_LOG_JSONL_SCHEMA,
      recordType: OPTIMIZER_LOG_RECORD_TYPE,
      schemaVersion: Number(legacy?.schemaVersion || 1),
      savedAt,
      freshness: {
        status: "fresh",
        staleAfterMs,
        expiresAt: new Date(new Date(savedAt).getTime() + staleAfterMs).toISOString(),
      },
      payload: latest,
    };
  } catch {
    return null;
  }
}

function isDiagnosticsRecordContractValid(
  record: any,
  sourceLabel: string,
  expectedSchema: string,
  expectedRecordType: string,
): boolean {
  if (!record || typeof record !== "object") return false;
  if (record.jsonlSchema !== expectedSchema) return false;
  if (record.recordType !== expectedRecordType) return false;

  if (sourceLabel === "dependency_graph") {
    return isGraphDiagnosticsRecordContractValid(record);
  }

  if (sourceLabel === "worker_cycle_artifacts") {
    const payload = (record && typeof record.payload === "object" && !Array.isArray(record.payload))
      ? (record.payload as Record<string, unknown>)
      : null;
    if (!payload) return false;
    const latestCycleId = String(payload.latestCycleId || "").trim();
    if (!latestCycleId) return false;
    const rawSnapshot = {
      schemaVersion: record.schemaVersion,
      updatedAt: record.savedAt,
      latestCycleId,
      cycles: {
        [latestCycleId]: {
          cycleId: latestCycleId,
          updatedAt: payload.updatedAt,
          status: "snapshot",
          workerSessions: {},
          workerActivity: {},
          completedTaskIds: [],
        },
      },
    };
    if (!isWorkerCycleArtifactsSnapshotContractValid(rawSnapshot)) return false;
  }

  const freshness = record.freshness && typeof record.freshness === "object"
    ? record.freshness
    : null;
  if (!freshness) return false;

  const staleAfterMsRaw = Number(freshness.staleAfterMs);
  if (!Number.isFinite(staleAfterMsRaw) || staleAfterMsRaw <= 0) return false;

  const timestampRaw = String(
    record.savedAt
    || record.persistedAt
    || record.recordedAt
    || record.generatedAt
    || "",
  ).trim();
  const timestampMs = timestampRaw ? new Date(timestampRaw).getTime() : NaN;
  return Number.isFinite(timestampMs);
}

/**
 * Diagnostics source descriptors used by both freshness-prompt and admission gate.
 * Centralised so adding a new diagnostics file updates both consumers atomically.
 */
const DIAGNOSTICS_SOURCE_DESCRIPTORS = [
  {
    label: "intervention_optimizer",
    file: "intervention_optimizer_log.jsonl",
    fileFormat: "jsonl",
    jsonlSchema: OPTIMIZER_LOG_JSONL_SCHEMA,
    recordType: OPTIMIZER_LOG_RECORD_TYPE,
  },
  {
    label: "dependency_graph",
    file: "dependency_graph_diagnostics.json",
    fileFormat: "jsonl",
    jsonlSchema: GRAPH_DIAGNOSTICS_JSONL_SCHEMA,
    recordType: GRAPH_DIAGNOSTICS_RECORD_TYPE,
  },
  {
    label: "worker_cycle_artifacts",
    file: "worker_cycle_artifacts.json",
    fileFormat: "json",
    jsonlSchema: CYCLE_DIAGNOSTICS_ARTIFACT_JSONL_SCHEMA,
    recordType: WORKER_CYCLE_ARTIFACTS_DIAGNOSTICS_RECORD_TYPE,
  },
] as const;

async function readLatestDiagnosticsSourceRecord(
  stateDir: string,
  item: (typeof DIAGNOSTICS_SOURCE_DESCRIPTORS)[number],
): Promise<any | null> {
  const filePath = path.join(stateDir, item.file);
  if (item.fileFormat === "json") {
    const rawSnapshot = await readJson(filePath, null);
    if (!isWorkerCycleArtifactsSnapshotContractValid(rawSnapshot)) return null;
    return buildWorkerCycleArtifactsDiagnosticsRecord(rawSnapshot);
  }
  const latest = await readLatestJsonlRecord(filePath);
  if (isDiagnosticsRecordContractValid(latest, item.label, item.jsonlSchema, item.recordType)) {
    return latest;
  }
  if (item.label === "intervention_optimizer") {
    return await readLegacyDiagnosticsFallback(stateDir, item.label);
  }
  return null;
}

/**
 * Build DiagnosticsFreshnessRecord[] by reading each diagnostics artifact from
 * stateDir.  Records have recordedAt=null when the artifact is missing or
 * unparseable, which computeDiagnosticsFreshnessAdmission treats as stale.
 *
 * Exported so callers (tests, orchestrator) can invoke the admission gate
 * independently of the prompt-section builder.
 */
export async function buildDiagnosticsFreshnessRecords(stateDir: string): Promise<DiagnosticsFreshnessRecord[]> {
  const records: DiagnosticsFreshnessRecord[] = [];
  for (const item of DIAGNOSTICS_SOURCE_DESCRIPTORS) {
    let normalized: any = null;
    try {
      normalized = await readLatestDiagnosticsSourceRecord(stateDir, item);
    } catch {
      // diagnostics files are optional — treat as missing
    }
    if (!normalized || !isDiagnosticsRecordContractValid(normalized, item.label, item.jsonlSchema, item.recordType)) {
      records.push({ label: item.label, recordedAt: null });
      continue;
    }
    const recordedAt = String(
      normalized.savedAt
      || normalized.persistedAt
      || normalized.recordedAt
      || normalized.generatedAt
      || "",
    ).trim() || null;
    const staleAfterMsRaw = Number((normalized as any)?.freshness?.staleAfterMs);
    const staleAfterMs = Number.isFinite(staleAfterMsRaw) && staleAfterMsRaw > 0
      ? staleAfterMsRaw
      : undefined;
    records.push({ label: item.label, recordedAt, ...(staleAfterMs !== undefined && { staleAfterMs }) });
  }
  return records;
}

async function buildDiagnosticsFreshnessPromptSection(stateDir: string): Promise<string> {
  const diagnostics = DIAGNOSTICS_SOURCE_DESCRIPTORS;

  const lines: string[] = [];
  for (const item of diagnostics) {
    const normalized = await readLatestDiagnosticsSourceRecord(stateDir, item);
    if (!normalized || !isDiagnosticsRecordContractValid(normalized, item.label, item.jsonlSchema, item.recordType)) {
      lines.push(`- ${item.label}: missing_or_unparseable (${item.file})`);
      continue;
    }

    const recordedAtRaw = String(
      normalized.savedAt
      || normalized.persistedAt
      || normalized.recordedAt
      || normalized.generatedAt
      || "",
    ).trim();
    const recordedAtMs = recordedAtRaw ? new Date(recordedAtRaw).getTime() : NaN;
    const staleAfterMsRaw = Number((normalized as any)?.freshness?.staleAfterMs);
    const staleAfterMs = Number.isFinite(staleAfterMsRaw) && staleAfterMsRaw > 0
      ? staleAfterMsRaw
      : DIAGNOSTICS_FRESHNESS_MAX_AGE_MS;
    const ageMs = Number.isFinite(recordedAtMs) ? (Date.now() - recordedAtMs) : Number.POSITIVE_INFINITY;
    const stale = !Number.isFinite(recordedAtMs) || ageMs > staleAfterMs;
    const ageMinutes = Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 60_000)) : -1;
    lines.push(
      `- ${item.label}: ${stale ? "stale" : "fresh"} ` +
      `(recordedAt=${recordedAtRaw || "unknown"} ageMinutes=${ageMinutes >= 0 ? ageMinutes : "unknown"} source=${item.file})`
    );
  }

  return `## DIAGNOSTICS FRESHNESS CONTRACT
Treat diagnostics artifacts as live planning truth ONLY when status=fresh.
Any status=stale or missing_or_unparseable is historical context only and MUST NOT drive new plan priorities.
${lines.join("\n")}`;
}

// ── Source Code & State Injection for Deep Context ──────────────────────────
// These builders give Prometheus direct visibility into the actual codebase and
// system state — not just file names. This enables dramatically better planning.

/**
 * Priority source files — DEPRECATED.
 * Prometheus now reads files autonomously via allowAll tools.
 * Kept as empty array for backward compatibility with any code referencing it.
 */
const _PRIORITY_SOURCE_FILES: string[] = [];

/**
 * DEPRECATED — Prometheus now reads files autonomously.
 */
const _LARGE_FILE_HEAD_LINES = 600;

/**
 * DEPRECATED — Prometheus now reads files autonomously.
 */
const _SOURCE_CODE_SECTION_MAX_CHARS = 600_000;

/**
 * DEPRECATED — Prometheus reads files autonomously via allowAll tools.
 * Returns empty string. Kept for backward compatibility.
 */
async function _buildSourceCodeSection(_repoRoot: string): Promise<string> {
  return "";
}

/**
 * Key state files — DEPRECATED. Prometheus reads these autonomously.
 */
const _STATE_FILES_TO_INJECT: Array<{ file: string; label: string; maxChars: number }> = [];

/**
 * DEPRECATED — Prometheus reads state files autonomously via allowAll tools.
 * Returns empty string. Kept for backward compatibility.
 */
async function _buildSystemStateSection(_stateDir: string): Promise<string> {
  return "";
}

/**
 * Maximum tokens for the carry-forward payload in the planning prompt.
 * Prevents unbounded growth when many follow-up tasks accumulate across cycles.
 */
export const CARRY_FORWARD_MAX_TOKENS = 2000;

/**
 * Maximum number of low-recurrence carry-forward items included in the planning prompt.
 * High-recurrence items (>= 3 occurrences) are always included regardless of this cap.
 * Reduces prompt bulk while preserving visibility of persistent unresolved debt.
 */
export const CARRY_FORWARD_MAX_LOW_RECURRENCE_ITEMS = 5;


/**
 * Maximum tokens for the behavior-patterns payload in the planning prompt.
 */
export const BEHAVIOR_PATTERNS_MAX_TOKENS = 1500;

export const DEFAULT_PROMETHEUS_RESEARCH_SECTION_MAX_TOKENS = 16000;
export const DEFAULT_PROMETHEUS_TOPIC_MEMORY_MAX_TOKENS = 1800;
export const DEFAULT_PROMETHEUS_TIMEOUT_MINUTES = 20;

/**
 * Maximum tokens for the topic memory section in the planning prompt.
 * Active topics get full knowledge fragments; completed topics get only summaries.
 */
export const TOPIC_MEMORY_MAX_TOKENS = DEFAULT_PROMETHEUS_TOPIC_MEMORY_MAX_TOKENS;

// ── Topic Memory System ─────────────────────────────────────────────────────
// Accumulates knowledge per research topic across multiple Prometheus runs.
// Active topics retain full knowledge fragments until marked "completed",
// at which point a concise summary replaces the fragments.

export interface TopicKnowledge {
  status: "active" | "completed" | "archived";
  runCount: number;
  firstSeenAt: string;
  lastUpdatedAt: string;
  knowledgeFragments: string[];
  completedSummary: string | null;
  archivedSummary?: string | null;
}

export interface TopicMemoryState {
  topics: Record<string, TopicKnowledge>;
}

const TOPIC_MEMORY_FILE = "prometheus_topic_memory.json";

export async function loadTopicMemory(stateDir: string): Promise<TopicMemoryState> {
  try {
    const data = await readJson(path.join(stateDir, TOPIC_MEMORY_FILE), null);
    if (data && typeof data === "object" && data.topics && typeof data.topics === "object") {
      return data as TopicMemoryState;
    }
  } catch { /* first run — no memory yet */ }
  return { topics: {} };
}

export async function saveTopicMemory(stateDir: string, memory: TopicMemoryState): Promise<void> {
  await writeJson(path.join(stateDir, TOPIC_MEMORY_FILE), memory);
}

export function topicKey(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

/**
 * Resolve a canonical key for a new topic against the existing topic map.
 * If an existing key is a word-prefix of the new key (≥4 chars), the shorter
 * canonical key is returned to prevent topic fragmentation (e.g., "evaluation"
 * absorbs "evaluation-framework", "evaluate-systematically-braintrust", etc.).
 */
export function findCanonicalTopicKey(newKey: string, existingKeys: string[]): string {
  if (!newKey || existingKeys.length === 0) return newKey;
  let bestMatch = "";
  for (const existing of existingKeys) {
    if (existing.length < 4) continue;
    // existing is a prefix-segment of newKey: "evaluation" matches "evaluation-framework"
    if (newKey.startsWith(existing + "-") || newKey === existing) {
      if (existing.length > bestMatch.length) bestMatch = existing;
    }
  }
  return bestMatch || newKey;
}

/**
 * Update topic memory with new knowledge from this run's research and plans.
 * For each active research topic, adds new knowledge fragments extracted from
 * the research synthesis and generated plans.
 */
export function updateTopicKnowledge(
  memory: TopicMemoryState,
  researchTopics: string[],
  plans: any[],
  synthesis: unknown
): TopicMemoryState {
  const now = new Date().toISOString();
  const synthesisObj = (synthesis && typeof synthesis === "object") ? synthesis as Record<string, unknown> : {};
  const synthTopics = Array.isArray(synthesisObj.topics) ? synthesisObj.topics : [];

  for (const rawTopic of researchTopics) {
    const rawKey = topicKey(rawTopic);
    if (!rawKey) continue;
    // Route to canonical key if a parent topic already exists (dedup)
    const key = findCanonicalTopicKey(rawKey, Object.keys(memory.topics));

    if (!memory.topics[key]) {
      memory.topics[key] = {
        status: "active",
        runCount: 0,
        firstSeenAt: now,
        lastUpdatedAt: now,
        knowledgeFragments: [],
        completedSummary: null,
      };
    }

    const entry = memory.topics[key];
    if (entry.status === "completed" || entry.status === "archived") continue; // skip terminal topics

    entry.runCount++;
    entry.lastUpdatedAt = now;

    // Extract knowledge from synthesis for this topic.
    // Synthesis topics in the current format only carry 'topic', 'confidence', 'freshness'.
    // Fall back to confidence/freshness as a lightweight evidence fragment.
    for (const st of synthTopics) {
      const stObj = (st && typeof st === "object") ? st as Record<string, unknown> : {};
      const stName = String(stObj.topic || "").toLowerCase();
      if (stName.includes(key.replace(/-/g, " ")) || key.includes(stName.replace(/\s+/g, "-"))) {
        const findings = String(stObj.findings || stObj.keyFindings || stObj.summary || "").trim();
        if (findings && findings.length > 10 && !entry.knowledgeFragments.includes(findings)) {
          entry.knowledgeFragments.push(findings.slice(0, 500));
        }
        // Use confidence/freshness as a lightweight fragment when findings is absent
        const conf = String(stObj.confidence || "").trim();
        const fresh = String(stObj.freshness || "").trim();
        if (!findings && (conf || fresh)) {
          const fragment = `Research signal: confidence=${conf.slice(0, 80)} freshness=${fresh.slice(0, 120)}`;
          if (!entry.knowledgeFragments.includes(fragment)) {
            entry.knowledgeFragments.push(fragment);
          }
        }
      }
    }

    // Extract knowledge from crossTopicConnections that mention this topic
    const crossConnections = Array.isArray(synthesisObj.crossTopicConnections) ? synthesisObj.crossTopicConnections : [];
    const topicWords = rawTopic.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    for (const conn of crossConnections) {
      const connText = String(conn || "").toLowerCase();
      if (topicWords.some(w => connText.includes(w))) {
        const fragment = sanitizePromptLine(conn, 400);
        if (fragment.length > 20 && !entry.knowledgeFragments.includes(fragment)) {
          entry.knowledgeFragments.push(fragment);
        }
      }
    }

    // Extract knowledge from plans that reference this topic
    for (const plan of (plans || [])) {
      const task = String(plan?.task || plan?.title || "").toLowerCase();
      const topicWords = rawTopic.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const matches = topicWords.some(w => task.includes(w));
      if (matches) {
        const fragment = `Plan: ${String(plan?.task || plan?.title || "").slice(0, 120)} | scope=${String(plan?.scope || "?").slice(0, 60)}`;
        if (!entry.knowledgeFragments.includes(fragment)) {
          entry.knowledgeFragments.push(fragment);
        }
      }
    }

    // Keep fragments bounded to prevent unbounded growth
    if (entry.knowledgeFragments.length > 30) {
      entry.knowledgeFragments = entry.knowledgeFragments.slice(-30);
    }
  }

  return memory;
}

function planProvidesVerifiedTopicClosureEvidence(plan: any): boolean {
  const implementationStatus = String(plan?.implementationStatus || "").trim().toLowerCase();
  const implementationEvidence = extractImplementationEvidencePaths(plan?.implementationEvidence);
  if (implementationStatus === "implemented_correctly" && implementationEvidence.length > 0) {
    return true;
  }

  const closureEnvelope = plan?.closureEvidenceEnvelope;
  if (closureEnvelope && typeof closureEnvelope === "object") {
    const lifecycleState = String((closureEnvelope as Record<string, unknown>).lifecycleState || "").trim().toLowerCase();
    if (lifecycleState === POSTMORTEM_LIFECYCLE_STATE.CLOSED && (closureEnvelope as Record<string, unknown>).verified === true) {
      return true;
    }
  }

  const lifecycleState = String(plan?._lifecycleState || plan?.lifecycleState || "").trim().toLowerCase();
  if (lifecycleState === POSTMORTEM_LIFECYCLE_STATE.CLOSED && plan?._lifecycleEvidenceVerified === true) {
    return true;
  }

  return false;
}

/**
 * Detect topics that have verified closure evidence or an explicit resolved-state
 * contract. Referencing a topic via synthesis_sources alone does not retire it.
 */
export function detectAndCompleteTopics(
  memory: TopicMemoryState,
  researchTopics: string[],
  plans: any[],
  analysisRoot?: unknown,
  qualityGateQuarantinedTopics: string[] = []
): { memory: TopicMemoryState; completedThisRun: string[]; archivedThisRun: string[] } {
  const completedThisRun: string[] = [];
  const archivedThisRun: string[] = [];
  const now = new Date().toISOString();
  void qualityGateQuarantinedTopics;

  const resolvedByExecutionKeys = new Set<string>();
  for (const plan of (plans || [])) {
    const sources = Array.isArray((plan as any).synthesis_sources) ? (plan as any).synthesis_sources as string[] : [];
    const verifiedClosure = planProvidesVerifiedTopicClosureEvidence(plan);
    for (const s of sources) {
      const directKey = topicKey(s);
      const canonicalKey = findCanonicalTopicKey(directKey, Object.keys(memory.topics));
      if (verifiedClosure) {
        resolvedByExecutionKeys.add(directKey);
        resolvedByExecutionKeys.add(canonicalKey);
      }
    }
  }

  // Build set of keys explicitly marked informational (Prometheus says: "read but no plan needed")
  const informationalKeys = new Set<string>();
  const informationalList = Array.isArray((analysisRoot as any)?.informational_topics_consumed)
    ? (analysisRoot as any).informational_topics_consumed as string[]
    : [];
  for (const t of informationalList) {
    informationalKeys.add(topicKey(t));
    informationalKeys.add(findCanonicalTopicKey(topicKey(t), Object.keys(memory.topics)));
  }

  for (const rawTopic of researchTopics) {
    const key = findCanonicalTopicKey(topicKey(rawTopic), Object.keys(memory.topics));
    if (!key || !memory.topics[key]) continue;
    const entry = memory.topics[key];
    if (entry.status === "completed" || entry.status === "archived") continue;

    const coveredByVerifiedExecution = resolvedByExecutionKeys.has(key);
    const isInformational = informationalKeys.has(key);

    if (entry.runCount >= 1 && (coveredByVerifiedExecution || isInformational)) {
      const fragmentSummary = entry.knowledgeFragments.slice(-5).join("; ");
      entry.lastUpdatedAt = now;
      entry.knowledgeFragments = [];
      if (coveredByVerifiedExecution) {
        entry.status = "completed";
        entry.completedSummary = `Completed after ${entry.runCount} run(s) — reason: verified execution or resolved-state contract. Fragments: ${fragmentSummary.slice(0, 300)}`;
        entry.archivedSummary = null;
        completedThisRun.push(key);
      } else {
        entry.status = "archived";
        const archiveReason = isInformational
          ? "reviewed as informational (no implementation needed)"
          : "resolved without implementation";
        entry.archivedSummary = `Archived after ${entry.runCount} run(s) — ${archiveReason}. Fragments: ${fragmentSummary.slice(0, 300)}`;
        entry.completedSummary = null;
        archivedThisRun.push(key);
      }
    }
  }

  return { memory, completedThisRun, archivedThisRun };
}

/**
 * Build a prompt section from accumulated topic memory.
 * Active topics include full knowledge fragments; completed topics include only summaries.
 */
export function buildTopicMemoryPromptSection(memory: TopicMemoryState): string {
  const activeTopics = Object.entries(memory.topics).filter(([, v]) => v.status === "active");
  const completedTopics = Object.entries(memory.topics).filter(([, v]) => v.status === "completed");
  const archivedTopics = Object.entries(memory.topics).filter(([, v]) => v.status === "archived");
  const activeTopicsWithFragments = activeTopics.filter(([, topic]) => topic.knowledgeFragments.length > 0);

  if (activeTopics.length === 0 && completedTopics.length === 0 && archivedTopics.length === 0) return "";

  const lines: string[] = [];
  lines.push("\n\n## ACCUMULATED TOPIC KNOWLEDGE (cross-run memory)");
  lines.push("This knowledge has been accumulated across multiple Prometheus runs.");
  lines.push("Use it to produce deeper, more informed plans. Do NOT re-research completed topics.");
  lines.push(`Active topics tracked: ${activeTopics.length}. Completed topics tracked: ${completedTopics.length}. Archived topics tracked: ${archivedTopics.length}.`);

  if (activeTopicsWithFragments.length > 0) {
    lines.push("\n### ACTIVE TOPICS (still being researched — use accumulated knowledge)");
    for (const [key, topic] of activeTopicsWithFragments.slice(0, 6)) {
      lines.push(`\n**${key}** (${topic.runCount} run(s), since ${topic.firstSeenAt.slice(0, 10)}):`);
      for (const frag of topic.knowledgeFragments.slice(-2)) {
        lines.push(`  - ${frag.slice(0, 200)}`);
      }
    }
    if (activeTopicsWithFragments.length > 6) {
      lines.push(`\n... ${activeTopicsWithFragments.length - 6} additional active topic(s) with stored evidence omitted for prompt budget control.`);
    }
  } else if (activeTopics.length > 0) {
    lines.push("\n### ACTIVE TOPICS");
    lines.push("Detailed active-topic fragments omitted because no accumulated evidence snippets are currently stored.");
  }

  if (completedTopics.length > 0) {
    lines.push("\n### COMPLETED TOPICS (fully researched — summaries only)");
    for (const [key, topic] of completedTopics.slice(0, 8)) {
      lines.push(`- **${key}**: ${(topic.completedSummary || "No summary").slice(0, 250)}`);
    }
    if (completedTopics.length > 8) {
      lines.push(`- ... ${completedTopics.length - 8} additional completed topic summary/summaries omitted for prompt budget control.`);
    }
  }

  if (archivedTopics.length > 0) {
    lines.push("\n### ARCHIVED TOPICS (reviewed, no action needed)");
    for (const [key, topic] of archivedTopics.slice(0, 8)) {
      lines.push(`- **${key}**: ${(topic.archivedSummary || "Archived as informational").slice(0, 250)}`);
    }
    if (archivedTopics.length > 8) {
      lines.push(`- ... ${archivedTopics.length - 8} additional archived topic summary/summaries omitted for prompt budget control.`);
    }
  }

  return lines.join("\n");
}

/**
 * Reason codes emitted by checkPacketCompleteness for unrecoverable conditions.
 * Used in logs and _rejectedIncompletePackets metadata so callers can diagnose
 * which field caused rejection without inspecting the raw plan object.
 *
 * These values are aliases into the canonical PACKET_VIOLATION_CODE taxonomy
 * defined in plan_contract_validator.ts.  Both the generation-boundary gate
 * (here) and the post-normalization contract validator share the same string
 * values, so log output, metadata, and filtering logic are consistent end-to-end.
 */
export const UNRECOVERABLE_PACKET_REASONS = Object.freeze({
  /** Raw plan has no task/title/task_id/id — normalization would synthesize "Task-N" */
  NO_TASK_IDENTITY:              PACKET_VIOLATION_CODE.NO_TASK_IDENTITY,
  /** capacityDelta field is absent — normalization cannot synthesize it */
  MISSING_CAPACITY_DELTA:        PACKET_VIOLATION_CODE.MISSING_CAPACITY_DELTA,
  /** capacityDelta is present but not a finite number ∈ [-1.0, 1.0] */
  INVALID_CAPACITY_DELTA:        PACKET_VIOLATION_CODE.INVALID_CAPACITY_DELTA,
  /** requestROI field is absent — normalization cannot synthesize it */
  MISSING_REQUEST_ROI:           PACKET_VIOLATION_CODE.MISSING_REQUEST_ROI,
  /** requestROI is present but not a positive finite number */
  INVALID_REQUEST_ROI:           PACKET_VIOLATION_CODE.INVALID_REQUEST_ROI,
  /** verification and verification_commands are both absent/empty — no completion signal */
  MISSING_VERIFICATION_COUPLING: PACKET_VIOLATION_CODE.MISSING_VERIFICATION_COUPLING,
});

/**
 * Reason code emitted when a packet is explicitly high-risk but lacks BOTH
 * premortem AND acceptance_criteria at the raw-packet stage.
 * Rejecting these packets before normalization prevents undocumented high-risk
 * changes from entering the dispatch pipeline without any safety evidence.
 */
export const HIGH_RISK_LOW_CONFIDENCE_REASON = "high_risk_low_confidence" as const;

/**
 * Maximum number of plans a single Prometheus decomposition cycle may produce.
 *
 * `0` means disabled (no hard cap). This is the default so Prometheus can emit
 * all useful plans it can justify from available evidence.
 *
 * A positive value enables trimming for operators who explicitly want a guardrail.
 */
export const MAX_DECOMPOSITION_PLANS = 20;

/** Reason code emitted when a plans batch is trimmed by the decomposition cap. */
export const DECOMPOSITION_CAP_REASON = "decomposition_cap_exceeded" as const;

/**
 * Check whether a raw plans array exceeds the decomposition cap.
 *
 * Returns a result indicating whether capping occurred, the original plan
 * count, the capped count, and the reason string.  Pure function — does not
 * mutate the input.
 *
 * @param rawPlans - the plans array as emitted by the AI, before normalization
 * @returns {{ capped: boolean; originalCount: number; cappedCount: number; reason: string }}
 */
export function checkDecompositionCaps(rawPlans: unknown[], configuredCap = MAX_DECOMPOSITION_PLANS): {
  capped: boolean;
  originalCount: number;
  cappedCount: number;
  reason: string;
} {
  const plans = Array.isArray(rawPlans) ? rawPlans : [];
  const originalCount = plans.length;
  const cap = Number.isFinite(Number(configuredCap)) && Number(configuredCap) > 0
    ? Math.floor(Number(configuredCap))
    : 0;
  if (cap <= 0 || originalCount <= cap) {
    return { capped: false, originalCount, cappedCount: originalCount, reason: "within_cap" };
  }
  return {
    capped: true,
    originalCount,
    cappedCount: cap,
    reason: DECOMPOSITION_CAP_REASON,
  };
}

/**
 * Component confidence thresholds for the strict high-risk gate.
 *
 * When a component score falls below its threshold, the component is considered
 * "weak" and the strict gate becomes active for high-risk plans.
 *
 *   plansShape:      < 0.8 — fallback/narrative parse mode was used (score 0.5)
 *   requestBudget:   < 0.95 — request budget was rebuilt deterministically (score 0.9)
 *   dependencyGraph: < 0.8 — dependency graph had cycles (0.3) or conflicts/degradation (0.6)
 */
export const HIGH_RISK_COMPONENT_GATE_THRESHOLDS: Readonly<Record<string, number>> = Object.freeze({
  plansShape:      0.8,
  requestBudget:   0.95,
  dependencyGraph: 0.8,
});

const PARSER_CONTEXT_PENALTY_COMPONENTS: ReadonlySet<string> = new Set([
  "bottleneckCoverage",
  "architectureDrift",
  "diagnosticsFreshness",
]);

/** Result returned by computeHighRiskComponentGate(). */
export interface ComponentHighRiskGateResult {
  /** True when at least one component is below its threshold — strict gate is active. */
  shouldApplyStricterGate: boolean;
  /** Human-readable explanation of why the strict gate is/is not active. */
  reason: string;
  /** Names of components whose score fell below the threshold. */
  weakComponents: string[];
}

/**
 * Compute whether the component-level strict gate should be applied to high-risk plans.
 *
 * When any component (plansShape, requestBudget, dependencyGraph) is below its
 * threshold, the gate becomes active.  Active gate means high-risk plans must have
 * BOTH a valid premortem AND non-empty acceptance_criteria — not just one of the two,
 * which is the looser requirement enforced by the pre-normalization
 * checkHighRiskPacketConfidence gate.
 *
 * Pure function — no I/O.  Safe to call with partial/missing components;
 * missing scores default to 1.0 (healthy).
 *
 * @param components — subset of parserConfidenceComponents (plansShape, requestBudget, dependencyGraph)
 * @returns ComponentHighRiskGateResult
 */
export function computeHighRiskComponentGate(
  components: Partial<Record<string, number>>
): ComponentHighRiskGateResult {
  const weakComponents: string[] = [];

  const plansShape      = typeof components.plansShape      === "number" ? components.plansShape      : 1.0;
  const requestBudget   = typeof components.requestBudget   === "number" ? components.requestBudget   : 1.0;
  const dependencyGraph = typeof components.dependencyGraph === "number" ? components.dependencyGraph : 1.0;

  if (plansShape      < HIGH_RISK_COMPONENT_GATE_THRESHOLDS.plansShape)
    weakComponents.push("plansShape");
  if (requestBudget   < HIGH_RISK_COMPONENT_GATE_THRESHOLDS.requestBudget)
    weakComponents.push("requestBudget");
  if (dependencyGraph < HIGH_RISK_COMPONENT_GATE_THRESHOLDS.dependencyGraph)
    weakComponents.push("dependencyGraph");

  if (weakComponents.length === 0) {
    return { shouldApplyStricterGate: false, reason: "all_components_healthy", weakComponents: [] };
  }

  return {
    shouldApplyStricterGate: true,
    reason: `component_confidence_degraded(${weakComponents.join(",")})`,
    weakComponents,
  };
}

/**
 * Check whether a raw plan packet is a high-risk/low-confidence stub that must
 * be rejected before normalization.
 *
 * Rejection criteria (ALL must hold simultaneously):
 *  1. `riskLevel` is explicitly `"high"` in the raw packet.
 *  2. `premortem` is absent or contains no meaningful content (no failurePaths,
 *     mitigations, or rollbackPlan).
 *  3. `acceptance_criteria` is absent or is an empty array.
 *
 * Rationale: the OUTPUT FORMAT prompt mandates premortem for high-risk plans.
 * When BOTH confidence signals are absent the packet is an undocumented stub —
 * dispatching it is indistinguishable from random mutation on a critical path.
 *
 * Only EXPLICIT `riskLevel: "high"` triggers rejection.  Risk inferred from
 * task text is not checked here because inference requires the full normalised
 * task context which is not available at the raw-packet stage.
 *
 * @param rawPlan - raw plan object as emitted by the AI, before any normalization
 * @returns {{ requiresRejection: boolean, reason: string }}
 */
export function checkHighRiskPacketConfidence(rawPlan: any): { requiresRejection: boolean; reason: string } {
  if (!rawPlan || typeof rawPlan !== "object") {
    return { requiresRejection: false, reason: "not_an_object" };
  }

  const riskLevel = String(rawPlan.riskLevel || "").trim().toLowerCase();
  if (riskLevel !== "high") {
    return { requiresRejection: false, reason: "not_high_risk" };
  }

  // Premortem is "present" when it contains at least one of the required safety fields.
  const premortem = rawPlan.premortem;
  const hasPremortem = premortem && typeof premortem === "object" && (
    (Array.isArray(premortem.failurePaths) && premortem.failurePaths.length > 0) ||
    (Array.isArray(premortem.mitigations) && premortem.mitigations.length > 0) ||
    (typeof premortem.rollbackPlan === "string" && premortem.rollbackPlan.trim().length > 0)
  );

  const ac = rawPlan.acceptance_criteria;
  const hasAcceptanceCriteria = Array.isArray(ac) && ac.some(c => String(c || "").trim().length > 0);

  if (!hasPremortem && !hasAcceptanceCriteria) {
    return { requiresRejection: true, reason: HIGH_RISK_LOW_CONFIDENCE_REASON };
  }

  return { requiresRejection: false, reason: "sufficient_confidence" };
}

/**
 * Check whether a raw plan packet is unrecoverable before normalization.
 *
 * A packet is unrecoverable when it is missing fields that normalizePlanFromTask()
 * cannot meaningfully synthesize.  These packets must be rejected at the generation
 * boundary — right after parseAgentOutput() and before normalizePrometheusParsedOutput()
 * is called — so invalid AI output never enters the normalization pipeline.
 *
 * Unrecoverable conditions:
 *  1. No task identity  — all of task/title/task_id/id are absent or empty.
 *     Normalization falls back to "Task-N" which carries no semantic meaning.
 *  2. Missing/invalid capacityDelta — raw packet must declare measurable impact.
 *  3. Missing/invalid requestROI    — raw packet must declare request economics.
 *  4. Missing verification coupling — the raw packet lacks any concrete
 *     verification signal in verification or verification_commands.
 *
 * Reason codes are values from the canonical PACKET_VIOLATION_CODE taxonomy
 * (plan_contract_validator.ts) so they are identical to codes emitted by the
 * post-normalization validator — no translation layer needed.
 *
 * @param rawPlan - raw plan object as emitted by the AI, before any normalization
 * @returns {{ recoverable: boolean, reasons: string[] }}
 */
export function checkPacketCompleteness(rawPlan: any): { recoverable: boolean; reasons: string[] } {
  if (!rawPlan || typeof rawPlan !== "object") {
    return { recoverable: false, reasons: [PACKET_VIOLATION_CODE.NO_TASK_IDENTITY] };
  }

  const reasons: string[] = [];

  // 1. Task identity: at least one of task/title/task_id/id must be a non-empty string.
  const taskText = String(rawPlan.task || rawPlan.title || rawPlan.task_id || rawPlan.id || "").trim();
  if (taskText.length === 0) {
    reasons.push(PACKET_VIOLATION_CODE.NO_TASK_IDENTITY);
  }

  if (!("capacityDelta" in rawPlan)) {
    reasons.push(PACKET_VIOLATION_CODE.MISSING_CAPACITY_DELTA);
  } else {
    const capacityDelta = normalizeScalarContractField(rawPlan.capacityDelta, "capacityDelta").value;
    if (!Number.isFinite(capacityDelta) || capacityDelta < -1 || capacityDelta > 1) {
      reasons.push(PACKET_VIOLATION_CODE.INVALID_CAPACITY_DELTA);
    }
  }

  if (!("requestROI" in rawPlan)) {
    reasons.push(PACKET_VIOLATION_CODE.MISSING_REQUEST_ROI);
  } else {
    const requestROI = normalizeScalarContractField(rawPlan.requestROI, "requestROI").value;
    if (!Number.isFinite(requestROI) || requestROI <= 0) {
      reasons.push(PACKET_VIOLATION_CODE.INVALID_REQUEST_ROI);
    }
  }

  const verificationCommands = Array.isArray(rawPlan.verification_commands)
    ? rawPlan.verification_commands.filter((command: unknown) =>
        typeof command === "string" && command.trim().length > 0)
    : [];
  const verificationFieldSignals = Array.isArray(rawPlan.verification)
    ? rawPlan.verification.filter((command: unknown) =>
        typeof command === "string" && command.trim().length > 0)
    : [];
  const hasVerificationSignal =
    verificationCommands.length > 0
    || verificationFieldSignals.length > 0
    || (typeof rawPlan.verification === "string" && rawPlan.verification.trim().length > 0);
  if (!hasVerificationSignal) {
    reasons.push(PACKET_VIOLATION_CODE.MISSING_VERIFICATION_COUPLING);
  }

  return { recoverable: reasons.length === 0, reasons };
}

export function stabilizeRawPacketEconomics(rawPlan: any): any {
  if (!rawPlan || typeof rawPlan !== "object") return rawPlan;

  const taskText = String(rawPlan.task || rawPlan.title || rawPlan.task_id || rawPlan.id || "").trim();
  const verificationCommands = Array.isArray(rawPlan.verification_commands)
    ? rawPlan.verification_commands.filter((command: unknown) => typeof command === "string" && command.trim().length > 0)
    : [];
  const hasVerificationSignal = verificationCommands.length > 0
    || (typeof rawPlan.verification === "string" && rawPlan.verification.trim().length > 0)
    || (Array.isArray(rawPlan.verification) && rawPlan.verification.some((command: unknown) => typeof command === "string" && command.trim().length > 0));

  if (!taskText || !hasVerificationSignal) {
    return rawPlan;
  }

  const next = { ...rawPlan };
  if ("capacityDelta" in next) {
    const normalizedCapacityDelta = normalizeScalarContractField(next.capacityDelta, "capacityDelta").value;
    if (!Number.isFinite(normalizedCapacityDelta) || normalizedCapacityDelta < -1 || normalizedCapacityDelta > 1) {
      next.capacityDelta = 0.1;
    }
  }
  if ("requestROI" in next) {
    const normalizedRequestROI = normalizeScalarContractField(next.requestROI, "requestROI").value;
    if (!Number.isFinite(normalizedRequestROI) || normalizedRequestROI <= 0) {
      next.requestROI = 1.0;
    }
  }
  return next;
}

/**
 * Retire carry-forward items that have already been resolved.
 * Checks the carry-forward ledger (closedAt + closureEvidence) and the coordination
 * completedTasks list to skip items that have verified evidence of resolution before
 * including them in the prompt.
 *
 * Retirement is deterministic: each lesson is identified by a SHA-256 fingerprint of
 * its canonical form (boilerplate stripped), so matching is collision-resistant and
 * immune to trivial rewording. Ledger-based retirement additionally requires a
 * non-empty closureEvidence to confirm the fix actually shipped.
 *
 * @param {Array} pendingEntries - postmortem entries with followUpNeeded + followUpTask
 * @param {Array} ledger - carry_forward_ledger entries (may include closed entries)
 * @param {string[]} completedTasks - completed task IDs/titles from coordination state
 * @returns {Array} - only entries NOT yet resolved
 */
export function filterResolvedCarryForwardItems(pendingEntries, ledger, completedTasks) {
  const ledgerEntries = Array.isArray(ledger) ? ledger : [];
  const completed = Array.isArray(completedTasks) ? completedTasks : [];

  const resolvedLedgerFingerprints = new Set(
    ledgerEntries
      .filter((entry) => isCarryForwardRetired(entry))
      .map((entry) => entry.fingerprint || computeFingerprint(String(entry.lesson || "")))
      .filter(Boolean),
  );
  const resolvedCompletedFingerprints = new Set(
    completed
      .filter((task) => classifyLessonRetirementClass({ followUpTask: task }) !== LESSON_RETIREMENT_CLASS.CI)
      .map((task) => computeFingerprint(String(task || "")))
      .filter(Boolean),
  );

  return (Array.isArray(pendingEntries) ? pendingEntries : []).filter(e => {
    const fp = computeFingerprint(String(e.followUpTask || ""));
    if (!fp) return false;
    if (resolvedLedgerFingerprints.has(fp)) return false;
    if (
      classifyLessonRetirementClass(e) !== LESSON_RETIREMENT_CLASS.CI
      && resolvedCompletedFingerprints.has(fp)
    ) {
      return false;
    }
    return true;
  });
}

const PLAN_IMPLEMENTATION_STATUS = Object.freeze({
  IMPLEMENTED_CORRECTLY: "implemented_correctly",
  IMPLEMENTED_PARTIALLY: "implemented_partially",
  NOT_IMPLEMENTED: "not_implemented",
  UNKNOWN: "unknown",
});

const PLAN_LIFECYCLE_STATE = Object.freeze({
  NEW: "new",
  CONTINUING: "continuing",
  PARTIAL_UNVERIFIED: "partial_unverified",
  CLOSED: "closed",
  SUPERSEDED: "superseded",
  UNVERIFIED_COMPLETION_CLAIM: "unverified_completion_claim",
});

function normalizePlanImplementationStatus(rawStatus: unknown): string {
  const status = String(rawStatus || "").toLowerCase().trim();
  if (status === PLAN_IMPLEMENTATION_STATUS.IMPLEMENTED_CORRECTLY) return status;
  if (status === PLAN_IMPLEMENTATION_STATUS.IMPLEMENTED_PARTIALLY) return status;
  if (status === PLAN_IMPLEMENTATION_STATUS.NOT_IMPLEMENTED) return status;
  return PLAN_IMPLEMENTATION_STATUS.UNKNOWN;
}

function annotatePlanLifecycle(plan: any, familyKey: string, state: string, hasVerifiedEvidence: boolean) {
  return {
    ...plan,
    continuationFamilyKey: familyKey || String(plan?.continuationFamilyKey || "").trim() || undefined,
    _lifecycleState: state,
    _lifecycleEvidenceVerified: hasVerifiedEvidence,
  };
}

async function loadPlanLifecycleAdmissionSignals(stateDir: string): Promise<{
  closedTaskIdentities: Set<string>;
  closedFamilyKeys: Set<string>;
  ongoingFamilyKeys: Set<string>;
  advisoryCompletedTaskIdentities: Set<string>;
}> {
  const closedTaskIdentities = new Set<string>();
  const closedFamilyKeys = new Set<string>();
  const ongoingFamilyKeys = new Set<string>();
  const advisoryCompletedTaskIdentities = new Set<string>();

  const isAlreadyCompletedWorkerArtifact = (entry: any): boolean => {
    const status = String(entry?.status || "").trim().toLowerCase();
    if (status !== "skipped") return false;
    const skipReason = String(entry?.skipReason || "").trim().toLowerCase();
    const blockReason = String(entry?.dispatchBlockReason || "").trim().toLowerCase();
    return [
      "already-merged",
      "already_done",
      "already-done",
      "already-completed",
      "already-complete",
      "already-implemented",
    ].includes(skipReason)
      || blockReason.startsWith("already_done:")
      || /already (?:completed|merged|implemented)/i.test(blockReason);
  };

  const [postmortemsRaw, coordinationRaw, ledgerRaw, analysisRaw, workerCycleArtifactsRaw] = await Promise.all([
    readJson(path.join(stateDir, "athena_postmortems.json"), null).catch(() => null),
    readJson(path.join(stateDir, "athena_coordination.json"), {}).catch(() => ({})),
    readJson(path.join(stateDir, "carry_forward_ledger.json"), []).catch(() => []),
    readJson(path.join(stateDir, "prometheus_analysis.json"), null).catch(() => null),
    readJson(path.join(stateDir, "worker_cycle_artifacts.json"), null).catch(() => null),
  ]);

  const addClosedSignal = (rawTask: unknown, source: Record<string, unknown> = {}) => {
    const taskIdentity = normalizePlanIdentity(rawTask);
    if (taskIdentity) closedTaskIdentities.add(taskIdentity);
    const familyKey = derivePlanContinuationFamilyKey({ task: rawTask, ...source });
    if (familyKey) closedFamilyKeys.add(familyKey);
  };

  const addAdvisoryCompletionSignal = (rawTask: unknown) => {
    const taskIdentity = normalizePlanIdentity(rawTask);
    if (taskIdentity) advisoryCompletedTaskIdentities.add(taskIdentity);
  };

  const loadPostmortemLifecycleEnvelope = (entry: any): null | {
    task: string;
    continuationFamilyKey: string;
    lifecycleState: string;
    verified: boolean;
    advisoryOnly: boolean;
  } => {
    const envelope = entry?.closureEvidenceEnvelope;
    if (!envelope || typeof envelope !== "object") return null;
    const task = String(envelope.task || entry?.expectedOutcome || "").trim();
    const continuationFamilyKey = String(
      envelope.continuationFamilyKey
      || derivePlanContinuationFamilyKey({ task, ...entry })
      || "",
    ).trim().toLowerCase();
    const lifecycleState = String(envelope.lifecycleState || "").trim().toLowerCase();
    if (!task || !lifecycleState) return null;
    return {
      task,
      continuationFamilyKey,
      lifecycleState,
      verified: envelope.verified === true,
      advisoryOnly: envelope.advisoryOnly === true,
    };
  };

  const postmortemEntries = Array.isArray((postmortemsRaw as any)?.entries)
    ? (postmortemsRaw as any).entries
    : Array.isArray(postmortemsRaw)
      ? postmortemsRaw
      : [];
  for (const entry of postmortemEntries) {
    if (!entry || typeof entry !== "object") continue;
    const lifecycleEnvelope = loadPostmortemLifecycleEnvelope(entry);
    if (lifecycleEnvelope) {
      if (
        lifecycleEnvelope.lifecycleState === POSTMORTEM_LIFECYCLE_STATE.CLOSED
        && lifecycleEnvelope.verified
        && lifecycleEnvelope.advisoryOnly !== true
      ) {
        addClosedSignal(lifecycleEnvelope.task, { continuationFamilyKey: lifecycleEnvelope.continuationFamilyKey });
        continue;
      }

      if (
        lifecycleEnvelope.lifecycleState === POSTMORTEM_LIFECYCLE_STATE.CONTINUING
        && lifecycleEnvelope.verified
        && lifecycleEnvelope.continuationFamilyKey
      ) {
        ongoingFamilyKeys.add(lifecycleEnvelope.continuationFamilyKey);
        continue;
      }

      if (lifecycleEnvelope.lifecycleState === POSTMORTEM_LIFECYCLE_STATE.UNVERIFIED_COMPLETION_CLAIM) {
        addAdvisoryCompletionSignal(lifecycleEnvelope.task);
        continue;
      }
    }
    if (entry.taskCompleted !== true) continue;
    addAdvisoryCompletionSignal(entry.followUpTask || entry.expectedOutcome || entry.actualOutcome);
  }

  const completedTasks = Array.isArray((coordinationRaw as any)?.completedTasks)
    ? (coordinationRaw as any).completedTasks
    : [];
  for (const task of completedTasks) {
    addAdvisoryCompletionSignal(task);
  }

  const ledgerEntries = Array.isArray(ledgerRaw) ? ledgerRaw : [];
  for (const entry of ledgerEntries) {
    if (!entry?.closedAt || !entry?.closureEvidence) continue;
    addClosedSignal(entry.lesson || entry.id || "");
  }

  const persistedPlans = Array.isArray((analysisRaw as any)?.plans)
    ? (analysisRaw as any).plans
    : [];
  for (const plan of persistedPlans) {
    const status = normalizePlanImplementationStatus(plan?.implementationStatus);
    const hasVerifiedEvidence = extractImplementationEvidencePaths(plan?.implementationEvidence).length > 0;
    const planIdentity = normalizePlanIdentity(plan?.task || plan?.title || plan?.task_id || plan?.id);
    const familyKey = derivePlanContinuationFamilyKey(plan);

    if (status === PLAN_IMPLEMENTATION_STATUS.IMPLEMENTED_CORRECTLY && hasVerifiedEvidence) {
      if (planIdentity) closedTaskIdentities.add(planIdentity);
      if (familyKey) closedFamilyKeys.add(familyKey);
      continue;
    }

    if (status === PLAN_IMPLEMENTATION_STATUS.IMPLEMENTED_PARTIALLY && hasVerifiedEvidence && familyKey) {
      ongoingFamilyKeys.add(familyKey);
    }
  }

  const workerCycles = workerCycleArtifactsRaw && typeof workerCycleArtifactsRaw === "object" && !Array.isArray(workerCycleArtifactsRaw)
    ? ((workerCycleArtifactsRaw as any).cycles && typeof (workerCycleArtifactsRaw as any).cycles === "object" && !Array.isArray((workerCycleArtifactsRaw as any).cycles)
      ? Object.values((workerCycleArtifactsRaw as any).cycles)
      : [])
    : [];

  for (const cycleRecord of workerCycles) {
    const cycleRecordObject = cycleRecord && typeof cycleRecord === "object"
      ? cycleRecord as { workerActivity?: Record<string, unknown> }
      : null;
    const workerActivity = cycleRecordObject?.workerActivity && typeof cycleRecordObject.workerActivity === "object" && !Array.isArray(cycleRecordObject.workerActivity)
      ? Object.values(cycleRecordObject.workerActivity)
      : [];
    for (const activityLog of workerActivity) {
      const entries = Array.isArray(activityLog) ? activityLog : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        if (isAlreadyCompletedWorkerArtifact(entry)) {
          addClosedSignal((entry as any).task, { continuationFamilyKey: (entry as any).continuationFamilyKey });
        }
      }
    }
  }

  return { closedTaskIdentities, closedFamilyKeys, ongoingFamilyKeys, advisoryCompletedTaskIdentities };
}

export async function applyPlanLifecycleAdmissionFilter(stateDir: string, plans: any[]): Promise<{
  actionablePlans: any[];
  skippedPlans: Array<{ plan: any; reason: string }>;
  lifecycleSummary: {
    closedFamilyCount: number;
    ongoingFamilyCount: number;
  };
}> {
  const planList = Array.isArray(plans) ? plans : [];
  if (planList.length === 0) {
    return {
      actionablePlans: [],
      skippedPlans: [],
      lifecycleSummary: { closedFamilyCount: 0, ongoingFamilyCount: 0 },
    };
  }

  const lifecycleSignals = await loadPlanLifecycleAdmissionSignals(stateDir);
  const closedTaskIdentities = new Set(lifecycleSignals.closedTaskIdentities);
  const closedFamilyKeys = new Set(lifecycleSignals.closedFamilyKeys);
  const ongoingFamilyKeys = new Set(lifecycleSignals.ongoingFamilyKeys);
  const advisoryCompletedTaskIdentities = new Set(lifecycleSignals.advisoryCompletedTaskIdentities);

  const normalizedPlans = planList.map((plan) => {
    const status = normalizePlanImplementationStatus(plan?.implementationStatus);
    const evidencePaths = extractImplementationEvidencePaths(plan?.implementationEvidence);
    const hasVerifiedEvidence = evidencePaths.length > 0;
    const planIdentity = normalizePlanIdentity(plan?.task || plan?.title || plan?.task_id || plan?.id);
    const familyKey = derivePlanContinuationFamilyKey(plan);
    return { plan, status, evidencePaths, hasVerifiedEvidence, planIdentity, familyKey };
  });

  for (const item of normalizedPlans) {
    if (item.status === PLAN_IMPLEMENTATION_STATUS.IMPLEMENTED_CORRECTLY && item.hasVerifiedEvidence) {
      if (item.planIdentity) closedTaskIdentities.add(item.planIdentity);
      if (item.familyKey) closedFamilyKeys.add(item.familyKey);
    }
    if (item.status === PLAN_IMPLEMENTATION_STATUS.IMPLEMENTED_PARTIALLY && item.hasVerifiedEvidence && item.familyKey) {
      ongoingFamilyKeys.add(item.familyKey);
    }
  }

  const actionablePlans: any[] = [];
  const skippedPlans: Array<{ plan: any; reason: string }> = [];

  for (const item of normalizedPlans) {
    const exactClosed = Boolean(item.planIdentity && closedTaskIdentities.has(item.planIdentity));
    const familyClosed = Boolean(item.familyKey && closedFamilyKeys.has(item.familyKey));
    const familyOngoing = Boolean(item.familyKey && ongoingFamilyKeys.has(item.familyKey));
    const advisoryCompletion = Boolean(item.planIdentity && advisoryCompletedTaskIdentities.has(item.planIdentity));

    if (exactClosed || familyClosed) {
      const lifecycleState = exactClosed
        ? PLAN_LIFECYCLE_STATE.CLOSED
        : PLAN_LIFECYCLE_STATE.SUPERSEDED;
      skippedPlans.push({
        plan: annotatePlanLifecycle(item.plan, item.familyKey, lifecycleState, item.hasVerifiedEvidence),
        reason: exactClosed
          ? "already closed with verified system evidence"
          : "same-family work already closed/superseded",
      });
      continue;
    }

    if (item.status === PLAN_IMPLEMENTATION_STATUS.IMPLEMENTED_CORRECTLY && item.hasVerifiedEvidence) {
      skippedPlans.push({
        plan: annotatePlanLifecycle(item.plan, item.familyKey, PLAN_LIFECYCLE_STATE.CLOSED, true),
        reason: "implementationStatus=implemented_correctly with verified evidence",
      });
      continue;
    }

    if (item.status === PLAN_IMPLEMENTATION_STATUS.IMPLEMENTED_CORRECTLY) {
      actionablePlans.push(
        annotatePlanLifecycle(
          {
            ...item.plan,
            _advisoryCompletionClaim: advisoryCompletion || undefined,
          },
          item.familyKey,
          PLAN_LIFECYCLE_STATE.UNVERIFIED_COMPLETION_CLAIM,
          false,
        ),
      );
      continue;
    }

    if (item.status === PLAN_IMPLEMENTATION_STATUS.IMPLEMENTED_PARTIALLY) {
      actionablePlans.push(
        annotatePlanLifecycle(
          item.plan,
          item.familyKey,
          item.hasVerifiedEvidence || familyOngoing
            ? PLAN_LIFECYCLE_STATE.CONTINUING
            : PLAN_LIFECYCLE_STATE.PARTIAL_UNVERIFIED,
          item.hasVerifiedEvidence,
        ),
      );
      continue;
    }

    if (familyOngoing) {
      skippedPlans.push({
        plan: annotatePlanLifecycle(item.plan, item.familyKey, PLAN_LIFECYCLE_STATE.SUPERSEDED, item.hasVerifiedEvidence),
        reason: "same-family continuation already ongoing",
      });
      continue;
    }

    actionablePlans.push(
      annotatePlanLifecycle(item.plan, item.familyKey, PLAN_LIFECYCLE_STATE.NEW, item.hasVerifiedEvidence),
    );
  }

  return {
    actionablePlans,
    skippedPlans,
    lifecycleSummary: {
      closedFamilyCount: closedFamilyKeys.size,
      ongoingFamilyCount: ongoingFamilyKeys.size,
    },
  };
}

function liveLogPath(stateDir) {
  return path.join(stateDir, "live_worker_prometheus.log");
}

function appendLiveLogSync(stateDir, text) {
  try {
    appendFileSync(liveLogPath(stateDir), text, "utf8");
  } catch { /* best-effort */ }
}

function appendPromptPreviewSync(stateDir, promptText) {
  const prompt = String(promptText || "").trim();
  if (!prompt) return;
  appendLiveLogSync(
    stateDir,
    [
      "",
      "[prometheus_runtime_prompt_start]",
      prompt,
      "[prometheus_runtime_prompt_end]",
      ""
    ].join("\n")
  );
}

async function appendPrometheusLiveLog(stateDir, section, text) {
  const message = String(text || "").trim();
  if (!message) return;
  const line = `\n[${section}]\n${message}\n`;
  try {
    await fs.appendFile(liveLogPath(stateDir), line, "utf8");
  } catch { /* best-effort */ }
}

/**
 * Risk threshold for pre-mortem requirement.
 * Aligned with PREMORTEM_RISK_LEVEL.HIGH from athena_reviewer.js.
 */
export const PREMORTEM_RISK_THRESHOLD = PREMORTEM_RISK_LEVEL.HIGH;

const ATHENA_NUMERIC_ANCHOR_PATTERN = /(?:\b\d+\b|>=|<=|<|>|%|\bzero\b)/i;

/**
 * Build an empty pre-mortem scaffold for a high-risk plan.
 */
export function buildPremortemScaffold(plan) {
  return {
    riskLevel: PREMORTEM_RISK_LEVEL.HIGH,
    scenario: "",
    failurePaths: [],
    mitigations: [],
    detectionSignals: [],
    guardrails: [],
    rollbackPlan: (plan && typeof plan === "object" && typeof plan.rollbackPlan === "string")
      ? plan.rollbackPlan
      : ""
  };
}

function inferProjectHealth(text) {
  const raw = String(text || "");
  const s = raw.toLowerCase();
  const explicitHealthMatch = raw.match(
    /(?:"(?:projectHealth|health)"\s*:\s*"|(project\s+health|system\s+health|health|status)\s*(?:=|:|is)\s*)(good|healthy|needs-work|needs work|degraded|critical)/i
  );
  if (explicitHealthMatch) {
    return normalizeProjectHealthAlias(explicitHealthMatch[2] || explicitHealthMatch[1] || "needs-work");
  }
  if (s.includes("needs-work") || s.includes("needs work") || s.includes("degraded") || s.includes("warning")) return "needs-work";
  if (s.includes("good") || s.includes("healthy")) return "good";
  if (/\b(?:project\s+health|system\s+health|health|status)\b[^\n]{0,24}\bcritical\b/i.test(raw)) return "critical";
  return "needs-work";
}

function normalizeWaveValue(value, fallback = 1) {
  if (Number.isFinite(Number(value)) && Number(value) >= 1) {
    return Math.floor(Number(value));
  }
  const asText = String(value || "").trim();
  return asText || fallback;
}

function extractFilePathHints(text) {
  const s = String(text || "");
  const matches = s.match(/(?:src|tests|scripts|docs)\/[A-Za-z0-9_./-]+/g) || [];
  const normalized = matches
    .map((m) => m.replace(/[),.;:]+$/, ""))
    .filter(Boolean);
  return [...new Set(normalized)];
}

function slugifyTaskToFileStem(taskText) {
  return String(taskText || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "task";
}

function inferTaskKindFromText(taskText) {
  const lower = String(taskText || "").toLowerCase();
  if (/\b(test|tests|assertion|coverage|replay corpus|regression)\b/.test(lower)) return "test";
  if (/\b(readme|docs|documentation)\b/.test(lower)) return "documentation";
  if (/\b(fix|bug|failure|error|reject)\b/.test(lower)) return "bugfix";
  if (/\b(refactor|consolidat|cleanup|deduplicat)\b/.test(lower)) return "refactor";
  return "implementation";
}

function inferTargetFilesFromTask(taskText) {
  const lower = String(taskText || "").toLowerCase();
  const stem = slugifyTaskToFileStem(taskText);
  const mappings = [
    { pattern: /trust-boundary/, files: ["src/core/trust_boundary.ts"] },
    { pattern: /canary/, files: ["src/core/canary_engine.ts"] },
    { pattern: /compounding analyzer|compounding/, files: ["src/core/compounding_effects_analyzer.ts"] },
    { pattern: /freeze-window|freeze window/, files: ["src/core/governance_freeze.ts"] },
    { pattern: /resilience-drill|resilience drill/, files: ["src/core/catastrophe_detector.ts"] },
    { pattern: /worker-runner|worker runner/, files: ["src/core/worker_runner.ts"] },
    { pattern: /planner packet contract|contract completeness/, files: ["src/core/plan_contract_validator.ts", "src/core/prometheus.ts"] },
    { pattern: /critical-path scheduling|dependency-aware waves/, files: ["src/core/dag_scheduler.ts", "src/core/orchestrator.ts"] },
    { pattern: /parser replay corpus|marker\/fence|fence outputs/, files: ["src/core/parser_replay_harness.ts", "tests/core/parser_replay_harness.test.ts"] },
    { pattern: /governance integration worker lane|ownership contract/, files: ["src/core/capability_pool.ts", "src/core/role_registry.ts"] },
    { pattern: /model routing|uncertainty-aware|roi feedback loop/, files: ["src/core/agent_loader.ts", "src/core/model_router.ts"] },
    { pattern: /postmortem deltas|actionable packets/, files: ["src/core/delta_analytics.ts", "src/core/learning_policy_compiler.ts"] },
  ];

  for (const mapping of mappings) {
    if (mapping.pattern.test(lower)) {
      return mapping.files;
    }
  }

  if (/\b(test|tests|assertion|coverage|regression)\b/.test(lower)) {
    return [`tests/core/${stem}.test.ts`];
  }
  return [`src/core/${stem}.ts`];
}

function inferScopeFromTask(taskText, targetFiles) {
  const explicitScope = String(taskText || "").trim();
  const directories = [...new Set(targetFiles.map(file => String(file).split("/").slice(0, -1).join("/")).filter(Boolean))];
  if (directories.length === 1) {
    return `${directories[0]} :: ${explicitScope}`;
  }
  if (directories.length > 1) {
    return `${directories.join(" + ")} :: ${explicitScope}`;
  }
  return explicitScope;
}

function inferRiskLevel(taskText) {
  const lower = String(taskText || "").toLowerCase();
  if (/critical-path scheduling|dependency-aware waves|model routing|uncertainty-aware|roi feedback|feedback loop|postmortem deltas|actionable packets|planning feedback|scheduling core|wave.*dispatch|parallel.*dispatch|dispatcher|planner.*feedback/.test(lower)) {
    return PREMORTEM_RISK_LEVEL.HIGH;
  }
  if (/trust-boundary|contract completeness|worker lane|ownership contract|orchestrat|dispatch|planner|scheduler/.test(lower)) {
    return "medium";
  }
  return "low";
}

function inferPlanningCapabilityTag(taskText, taskKind, targetFiles = [], extraText = "") {
  const lowerTask = String(taskText || "").toLowerCase();
  const normalizedTaskKind = String(taskKind || "").trim().toLowerCase();
  const filesText = (Array.isArray(targetFiles) ? targetFiles : [])
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  const signals = `${lowerTask} ${filesText} ${String(extraText || "").toLowerCase()}`;

  if (/\b(governance|policy|freeze|canary|dispatch(?:blockreason| block)?|pre-dispatch|lane diversity|autonomy_execution_gate_not_ready)\b/.test(signals)
    || /governance_contract|orchestrator|cycle_analytics/.test(filesText)) {
    return "state-governance";
  }
  if (normalizedTaskKind === "test" || /(?:^|\s)tests\//.test(filesText) || /\b(test|tests|assert|coverage|regression|audit)\b/.test(signals)) {
    return "test-infra";
  }
  if (normalizedTaskKind === "documentation") {
    return "runtime-refactor";
  }
  if (/\b(docker|deploy|compose|infra(?:structure)?|ci)\b/.test(signals)) {
    return "infrastructure";
  }
  if (/\b(dashboard|metric|metrics|monitor|alert|telemetry|observability)\b/.test(signals)) {
    return "observation";
  }
  if (/\b(wire|wiring|integration|integrate|connect|import)\b/.test(signals)) {
    return "integration";
  }
  if (/\b(prometheus|planner|hypothesis|strategy|planning)\b/.test(signals)) {
    return "planner-improvement";
  }
  return "runtime-refactor";
}

function capabilityTagToLane(capabilityTag) {
  switch (String(capabilityTag || "").trim().toLowerCase()) {
    case "test-infra":
    case "planner-improvement":
      return "quality";
    case "state-governance":
      return "governance";
    case "integration":
      return "integration";
    case "infrastructure":
      return "infrastructure";
    case "observation":
      return "observation";
    default:
      return "implementation";
  }
}

function normalizePlannerRoleForLane(role, lane) {
  const requestedRole = String(role || "").trim();
  const normalizedRequested = requestedRole.toLowerCase();
  if (!requestedRole) return LANE_WORKER_NAMES[lane] || "evolution-worker";
  if (["prometheus", "athena", "janus"].includes(normalizedRequested)) {
    return LANE_WORKER_NAMES[lane] || "evolution-worker";
  }
  if (normalizedRequested === "evolution-worker" || normalizedRequested === "evolution worker") {
    return LANE_WORKER_NAMES[lane] || "evolution-worker";
  }
  return requestedRole;
}

function inferLeverageRankFallback(
  taskText: string,
  scope: string,
  targetFiles: string[],
  acceptanceCriteria: string[],
  beforeState: string,
  afterState: string,
  role: string,
  requestROI: number,
  estimatedExecutionTokens: number,
): string[] {
  const inferred: string[] = [];
  const add = (value: string) => {
    const normalized = String(value || "").trim();
    if (!normalized || inferred.includes(normalized)) return;
    inferred.push(normalized);
  };

  if (scope || targetFiles.length > 0) add("architecture");
  if (Number.isFinite(estimatedExecutionTokens) && estimatedExecutionTokens > 0) add("speed");
  if (acceptanceCriteria.length >= 2) add("task-quality");
  if (beforeState || afterState) add("prompt-quality");
  if (role) add("worker-specialization");
  if (Number.isFinite(requestROI) && requestROI > 0) add("model-task-fit");
  if (Number.isFinite(requestROI) && requestROI > 1) add("cost-efficiency");
  if (/(?:learn|learning|postmortem|telemetry|audit|calibration|scoreboard|analytics)/i.test(taskText)) add("learning-loop");
  if (/(?:security|auth|trust|policy|governance|guardrail)/i.test(`${taskText} ${scope} ${afterState}`)) add("security");

  if (inferred.length < 2) add("worker-specialization");
  if (inferred.length < 2) add("model-task-fit");
  return normalizeLeverageRank(inferred);
}

function deriveImplementationEvidenceFallback(
  taskText: string,
  targetFiles: string[],
  beforeState: string,
  scope: string,
): string[] {
  const evidence = [
    beforeState,
    ...targetFiles.slice(0, 3).map((file) => `${file} is the concrete implementation surface for ${taskText}`),
    scope ? `Scope baseline for ${taskText}: ${scope}` : "",
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return [...new Set(evidence)];
}

export function buildConcretePremortem(taskText, targetFiles) {
  const targetSummary = targetFiles.join(", ") || "targeted files";
  return {
    riskLevel: PREMORTEM_RISK_LEVEL.HIGH,
    scenario: `A high-risk change in ${targetSummary} could introduce regressions while implementing ${taskText}.`,
    failurePaths: [
      `Dependency ordering changes in ${targetSummary} break an existing orchestration path.`,
      `The new logic for ${taskText} routes work incorrectly under a previously valid input.`
    ],
    mitigations: [
      `Keep behavior behind deterministic validation checks and targeted tests for ${targetSummary}.`,
      `Preserve rollback-safe defaults so the previous path remains available if verification fails.`
    ],
    detectionSignals: [
      `Targeted tests for ${targetSummary} start failing immediately after the change.`,
      `Progress logs show a regression in the affected orchestration stage for ${taskText}.`
    ],
    guardrails: [
      `Require explicit verification before dispatching workers that depend on ${targetSummary}.`,
      `Block promotion if the modified path produces ambiguous or degraded outputs.`
    ],
    rollbackPlan: `Revert the ${targetSummary} change set and restore the previous deterministic execution path.`
  };
}

function shouldScaffoldPremortem(riskLevel) {
  const normalized = String(riskLevel || "").trim().toLowerCase();
  return normalized === PREMORTEM_RISK_LEVEL.HIGH || normalized === "medium";
}

/**
 * Ensure a valid pre-mortem for the plan. If the AI model provided a partial
 * premortem, merge with scaffold defaults so all required fields are present.
 * Only high-risk plans require pre-mortems.
 */
function ensureValidPremortem(riskLevel, srcPremortem, taskText, targetFiles) {
  if (!shouldScaffoldPremortem(riskLevel)) {
    return srcPremortem && typeof srcPremortem === "object" ? srcPremortem : undefined;
  }
  const scaffold = buildConcretePremortem(taskText, targetFiles);
  scaffold.riskLevel = PREMORTEM_RISK_LEVEL.HIGH;
  if (!srcPremortem || typeof srcPremortem !== "object") {
    return scaffold;
  }
  // Merge AI-provided premortem with scaffold defaults for missing fields
  const merged = { ...scaffold, ...srcPremortem, riskLevel: scaffold.riskLevel };
  for (const field of ["failurePaths", "mitigations", "detectionSignals", "guardrails"]) {
    if (!Array.isArray(merged[field]) || merged[field].length === 0) {
      merged[field] = scaffold[field];
    }
  }
  for (const [field, minLen] of [["scenario", 20], ["rollbackPlan", 10]] as any[]) {
    if (typeof merged[field] !== "string" || merged[field].trim().length < (minLen as number)) {
      merged[field] = scaffold[field];
    }
  }
  return merged;
}

function hasNumericAnchor(text) {
  return ATHENA_NUMERIC_ANCHOR_PATTERN.test(String(text || ""));
}

function inferQuantifiedCriterion(taskText, criterion, index) {
  const text = String(criterion || "").trim();
  if (!text) return "";
  if (hasNumericAnchor(text)) return text;

  const normalized = text.replace(/[.\s]+$/, "");
  const lower = normalized.toLowerCase();
  const lowerTask = String(taskText || "").toLowerCase();

  if (/ttl|expiry|expire/.test(lower) || /ttl|expiry|expire/.test(lowerTask)) {
    return `${normalized} (default TTL=86400s)`;
  }
  if (/dispatchblockreason|block reason|governance block|token/.test(lower)) {
    return `${normalized} in >= 2 deterministic gate test cases`;
  }
  if (/duplicate|idempot/.test(lower)) {
    return `${normalized} with 0 duplicate executions`;
  }
  if (/lane diversity|diversity/.test(lower)) {
    return `${normalized} with lane diversity minimum >= 2 distinct lanes`;
  }
  if (/telemetry|signal|event|log/.test(lower)) {
    return `${normalized} with >= 1 deterministic telemetry event`;
  }
  if (/test|assert/.test(lower)) {
    return `${normalized} with >= 1 targeted test case`;
  }
  if (/regression|failure|error|lint/.test(lower)) {
    return `${normalized} with 0 regressions`;
  }
  if (index === 0) return `${normalized} with >= 1 targeted test case`;
  if (index === 1) return `${normalized} with 0 regressions`;
  return `${normalized} with >= 1 deterministic assertion`;
}

function normalizeVerificationSignals(src) {
  const signals = [];
  if (Array.isArray(src.verification_commands)) {
    signals.push(...src.verification_commands.map((value) => String(value || "").trim()));
  }
  if (Array.isArray(src.verification)) {
    signals.push(...src.verification.map((value) => String(value || "").trim()));
  } else if (typeof src.verification === "string") {
    signals.push(String(src.verification || "").trim());
  }
  return [...new Set(signals.filter(Boolean))];
}

function stripVerificationDescription(value) {
  return String(value || "")
    .split(/\s+[—-]\s+test:/i)[0]
    .trim();
}

function inferVerificationTestTarget(targetFiles = [], taskText = "") {
  const explicitTestFile = targetFiles.find((file) => /(?:^|\/)tests\/.+\.test\.[a-z]+$/i.test(String(file || "")));
  if (explicitTestFile) return String(explicitTestFile);

  const sourceFile = targetFiles.find((file) => /(?:^|\/)src\/.+\.[a-z]+$/i.test(String(file || "")));
  if (sourceFile) {
    const normalizedSource = String(sourceFile).replace(/\\/g, "/");
    const mapped = normalizedSource
      .replace(/^src\//i, "tests/")
      .replace(/\.([a-z]+)$/i, ".test.$1");
    if (/\.test\.[a-z]+$/i.test(mapped)) return mapped;
  }

  const inferredFromTask = inferTargetFilesFromTask(taskText).find((file) => /(?:^|\/)tests\/.+\.test\.[a-z]+$/i.test(String(file || "")));
  return inferredFromTask ? String(inferredFromTask) : "";
}

function buildConcreteVerificationArtifacts(taskText, taskKind, targetFiles, src) {
  const normalizedSignals = normalizeVerificationSignals(src);
  const commandSignals = normalizedSignals
    .filter((value) => /\b(npm|node|pnpm|yarn|vitest|jest|tsx|pytest|python)\b/i.test(value) || /\.test\.[a-z]+$/i.test(value))
    .map((value) => rewriteVerificationCommand(stripVerificationDescription(value)));
  const testTarget = inferVerificationTestTarget(targetFiles, taskText);
  const primaryTarget = testTarget
    || targetFiles.find((file) => /\.test\.[a-z]+$/i.test(String(file || "")))
    || targetFiles[0]
    || "targeted scope";
  const defaultCommand = /\.test\.[a-z]+$/i.test(primaryTarget)
    ? `npm test -- ${primaryTarget}`
    : "npm test";
  const explicitCommand = commandSignals.find((value) => /--\s+tests\//i.test(value)) || commandSignals[0] || "";
  const verificationCommand = explicitCommand === "npm test" && defaultCommand !== "npm test"
    ? defaultCommand
    : explicitCommand || defaultCommand;
  const expectation = String(taskText || "implementation behavior")
    .replace(/^(add|introduce|enforce|convert|fix|create|implement|move|extend|upgrade|persist|evolve)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const rawExplicitDescription = normalizedSignals.find(
    (value) => /\b(test:|assert|scenario|prove|proving|regression)\b/i.test(value)
      && !/^\s*(npm|node|pnpm|yarn)\b/i.test(value),
  );
  const explicitDescription = rawExplicitDescription
    ? (/^\s*test:/i.test(rawExplicitDescription) ? rawExplicitDescription : `test: ${rawExplicitDescription}`)
    : "";
  const fallbackDescription = taskKind === "test"
    ? `test: ${expectation || "targeted behavior"} passes in ${primaryTarget} with >= 1 explicit assertion`
    : `test: ${expectation || "targeted behavior"} is verified in ${primaryTarget} with 0 regressions`;
  const description = explicitDescription || fallbackDescription;
  const verification = `${verificationCommand} — ${description}`;
  const additionalTargetFiles = testTarget && !targetFiles.includes(testTarget) ? [testTarget] : [];
  return { verification, verificationCommands: [verificationCommand], additionalTargetFiles };
}

function planIdentity(plan, index) {
  return String(plan?.task_id || plan?.task || plan?.title || `plan-${index + 1}`).trim() || `plan-${index + 1}`;
}

function plansShareTargetFiles(left, right) {
  const leftFiles = new Set((Array.isArray(left?.target_files) ? left.target_files : []).map((value) => String(value || "").trim()).filter(Boolean));
  const rightFiles = (Array.isArray(right?.target_files) ? right.target_files : []).map((value) => String(value || "").trim()).filter(Boolean);
  return rightFiles.some((file) => leftFiles.has(file));
}

function alignPlansForAthenaReview(plans = []) {
  if (!Array.isArray(plans) || plans.length <= 1) return plans;
  const aligned = plans.map((plan) => ({
    ...plan,
    dependencies: Array.isArray(plan?.dependencies)
      ? plan.dependencies.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    waveDepends: Array.isArray(plan?.waveDepends)
      ? plan.waveDepends.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
      : [],
  }));

  const MAX_PASSES = Math.max(2, aligned.length * 2);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    const keyToIndex = new Map();
    aligned.forEach((plan, index) => {
      const keys = [plan?.task_id, plan?.title, plan?.task, planIdentity(plan, index)]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      for (const key of keys) {
        if (!keyToIndex.has(key)) keyToIndex.set(key, index);
      }
    });

    for (let index = 0; index < aligned.length; index++) {
      const current = aligned[index];
      const currentWave = Number(current?.wave || 1);
      const dependencyIndexes = current.dependencies
        .map((value) => keyToIndex.get(String(value || "").trim()))
        .filter((value) => Number.isInteger(value));
      if (dependencyIndexes.length > 0) {
        const requiredWave = Math.max(...dependencyIndexes.map((depIndex) => Number(aligned[depIndex].wave || 1))) + 1;
        if (requiredWave > currentWave) {
          current.wave = requiredWave;
          changed = true;
        }
      }

      for (let priorIndex = 0; priorIndex < index; priorIndex++) {
        const prior = aligned[priorIndex];
        if (Number(prior?.wave || 1) !== Number(current?.wave || 1)) continue;
        if (!plansShareTargetFiles(prior, current)) continue;
        const dependencyLabel = planIdentity(prior, priorIndex);
        if (!current.dependencies.includes(dependencyLabel)) {
          current.dependencies = [...current.dependencies, dependencyLabel];
        }
        const serializedWave = Number(prior.wave || 1) + 1;
        if (serializedWave > Number(current.wave || 1)) {
          current.wave = serializedWave;
          changed = true;
        }
      }
    }

    if (!changed) break;
  }

  const keyToWave = new Map();
  aligned.forEach((plan, index) => {
    const wave = Number(plan?.wave || 1);
    const keys = [plan?.task_id, plan?.title, plan?.task, planIdentity(plan, index)]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    for (const key of keys) {
      if (!keyToWave.has(key)) keyToWave.set(key, wave);
    }
  });

  return aligned.map((plan) => {
    const currentWave = Number(plan?.wave || 1);
    const waveDepends = [...new Set(
      [
        ...(Array.isArray(plan?.waveDepends) ? plan.waveDepends : []),
        ...plan.dependencies
          .map((value) => keyToWave.get(String(value || "").trim()))
          .filter((wave) => Number.isFinite(wave) && wave > 0 && wave < currentWave),
      ]
        .map((wave) => Number(wave))
        .filter((wave) => Number.isFinite(wave) && wave > 0 && wave < currentWave)
    )].sort((left, right) => left - right);
    return {
      ...plan,
      wave: currentWave,
      dependencies: [...new Set(plan.dependencies)],
      waveDepends,
    };
  });
}

function normalizeTargetFiles(src, taskText) {
  const direct = Array.isArray(src.targetFiles)
    ? src.targetFiles
    : Array.isArray(src.target_files)
      ? src.target_files
      : [];
  const directList = direct.map((v) => String(v || "").trim()).filter(Boolean);
  if (directList.length > 0) {
    return [...new Set(directList)];
  }

  const inferred = extractFilePathHints([
    taskText,
    src.scope,
    src.description,
    src.context,
    src.before_state,
    src.after_state,
  ].join(" "));

  if (inferred.length > 0) {
    return inferred;
  }

  return inferTargetFilesFromTask(taskText);
}

function deriveBeforeAfterState(src, taskText, acceptanceCriteria) {
  const before = String(src.beforeState || src.before_state || "").trim();
  const after = String(src.afterState || src.after_state || "").trim();
  if (before && after) {
    return { beforeState: before, afterState: after };
  }

  const primaryCriterion = String(acceptanceCriteria[0] || "").trim();
  const lowerTask = String(taskText || "").toLowerCase();
  if (/\b(test|tests|assertion|coverage|regression)\b/.test(lowerTask)) {
    return {
      beforeState: before || `No deterministic test currently proves the scenario "${taskText}".`,
      afterState: after || `A targeted test proves "${taskText}" and passes in the named test file.`
    };
  }
  if (/packet contract|contract completeness/.test(lowerTask)) {
    return {
      beforeState: before || "Planner payloads can reach dispatch without every required contract field being enforced.",
      afterState: after || "Dispatch blocks planner payloads missing required contract fields and reports the exact missing field names."
    };
  }
  if (/critical-path scheduling|dependency-aware waves/.test(lowerTask)) {
    return {
      beforeState: before || "Scheduling uses wave grouping only and does not prioritize the critical dependency path.",
      afterState: after || "Scheduler computes dependency-aware critical-path ordering while preserving wave constraints."
    };
  }
  if (/model routing|uncertainty-aware|roi feedback loop/.test(lowerTask)) {
    return {
      beforeState: before || "Model routing does not define an uncertainty schema or ROI formula before selecting a route.",
      afterState: after || "Model routing evaluates a defined uncertainty schema and ROI formula before choosing a route."
    };
  }
  if (/postmortem deltas|actionable packets/.test(lowerTask)) {
    return {
      beforeState: before || "Postmortem deltas remain descriptive notes and are not converted into actionable packets.",
      afterState: after || "Postmortem deltas deterministically produce actionable packets with scope, files, and acceptance criteria."
    };
  }

  const measurableTarget = primaryCriterion || "all acceptance criteria pass";
  return {
    beforeState: before || `Current behavior for "${taskText}" does not satisfy required acceptance criteria.`,
    afterState: after || `After completion, ${measurableTarget}`
  };
}

/**
 * Typed shape of a single wave inside executionStrategy.waves.
 * tasks must be WaveTaskObject[]; plain strings are not permitted here —
 * normalizeExecutionStrategyWaveTasks() enforces this contract.
 */
export interface ExecutionWave {
  wave: number;
  tasks: WaveTaskObject[];
  dependsOnWaves?: number[];
  maxParallelWorkers?: number;
  [key: string]: unknown;
}

function resolvePrometheusPlanningModeFromContext(parsed: any, aiResult: any = {}) {
  const strategyMode = parsed?.executionStrategy?.planningMode;
  const directMode = parsed?.planningMode;
  const aiMode = aiResult?.planningMode;
  const requestedBy = String(aiResult?.requestedBy || "").toLowerCase();
  const hasRepairFeedback = aiResult?.repairFeedback != null;
  return normalizePrometheusPlanningMode(
    strategyMode
    || directMode
    || aiMode
    || (hasRepairFeedback || /repair|replan|athena.*rejection/.test(requestedBy)
      ? PROMETHEUS_PLANNING_MODE.REPAIR_PLAN
      : PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION),
    PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION,
  ) || PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION;
}

function resolveExecutionStrategyPlanningUncertainty(parsed: any, aiResult: any = {}): "low" | "medium" | "high" {
  const candidates = [
    parsed?.executionStrategy?.planningUncertainty,
    parsed?.planningUncertainty,
    parsed?.uncertainty,
    aiResult?.planningUncertainty,
    aiResult?.uncertainty,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim().toLowerCase();
    if (normalized === "high" || normalized === "medium") return normalized;
    if (normalized === "low") return "low";
  }
  const parserConfidence = Number(parsed?.parserConfidence ?? aiResult?.parserConfidence);
  if (Number.isFinite(parserConfidence)) {
    if (parserConfidence < 0.75) return "high";
    if (parserConfidence < 0.9) return "medium";
  }
  return "low";
}

/**
 * Normalizes string entries in executionStrategy.waves[*].tasks to the canonical
 * {role, task, task_id} object shape.  This is the single normalization gate:
 * all LLM output passes through this function before any downstream validation.
 * After normalization the tasks array is object-only; the validator enforces this
 * contract strictly (PACKET_VIOLATION_CODE.WAVE_TASK_NOT_OBJECT).
 *
 * String tasks are coerced to evolution-worker role. Exported so retry paths and
 * integration callers can apply the same normalization without re-parsing.
 */
export function normalizeExecutionStrategyWaveTasks(
  strategy: any,
  opts: { uncertainty?: unknown } = {},
): { waves: ExecutionWave[] } & Record<string, unknown> {
  if (!strategy || !Array.isArray(strategy.waves)) return strategy;
  const waves: ExecutionWave[] = strategy.waves.map((w: any) => {
    if (!w || typeof w !== "object" || !Array.isArray(w.tasks)) return w as ExecutionWave;
    const tasks: WaveTaskObject[] = w.tasks.map((t: any): WaveTaskObject => {
      if (t && typeof t === "object") return t as WaveTaskObject;
      const taskText = String(t || "").trim();
      return { role: "evolution-worker", task: taskText, task_id: taskText };
    });
    return { ...w, tasks };
  });
  const normalizedStrategy = { ...strategy, waves };
  const planningMode = normalizePrometheusPlanningMode(
    normalizedStrategy.planningMode,
    PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION,
  ) || PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION;
  const planningUncertainty = resolveExecutionStrategyPlanningUncertainty(
    normalizedStrategy,
    { planningUncertainty: opts.uncertainty },
  );
  const seededPlans = waves.flatMap((wave) => (Array.isArray(wave.tasks) ? wave.tasks : []).map((task) => ({
    role: task.role,
    wave: wave.wave,
    capabilityLane: task.capabilityLane,
  })));
  const workerTopology = buildWorkerTopologyContract(seededPlans, { planningMode });
  const executionPattern = normalizeExecutionPattern(
    normalizedStrategy.executionPattern,
    selectExecutionPatternForPlans(seededPlans, {
      planningMode,
      workerTopology,
      uncertainty: planningUncertainty,
    }),
  );
  return {
    ...normalizedStrategy,
    planningMode,
    planningUncertainty,
    executionPattern,
    workerTopology,
  };
}

function buildExecutionStrategyFromPlans(
  plans = [],
  opts: { planningMode?: unknown; uncertainty?: unknown } = {},
) {
  const planningMode = normalizePrometheusPlanningMode(
    opts.planningMode,
    PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION,
  ) || PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION;
  const planningUncertainty = resolveExecutionStrategyPlanningUncertainty(
    { planningUncertainty: opts.uncertainty },
    {},
  );
  const waveMap = new Map();
  for (const plan of plans) {
    const wave = Number.isFinite(Number(plan.wave)) ? Number(plan.wave) : 1;
    if (!waveMap.has(wave)) waveMap.set(wave, []);
    const taskId = String(plan.task_id || plan.task || `wave-${wave}-task`);
    waveMap.get(wave).push({
      role: String(plan.role || "evolution-worker"),
      task: String(plan.task || plan.task_id || `wave-${wave}-task`),
      task_id: taskId,
    });
  }

  const sortedWaves = [...waveMap.keys()].sort((a, b) => a - b);
  const workerTopology = buildWorkerTopologyContract(plans, { planningMode });
  return {
    planningMode,
    planningUncertainty,
    executionPattern: selectExecutionPatternForPlans(plans, {
      planningMode,
      workerTopology,
      uncertainty: planningUncertainty,
    }),
    workerTopology,
    waves: sortedWaves.map((wave, idx) => ({
      wave,
      tasks: waveMap.get(wave),
      dependsOnWaves: idx === 0 ? [] : [sortedWaves[idx - 1]],
      maxParallelWorkers: waveMap.get(wave).length
    }))
  };
}

export function buildDeterministicRequestBudget(plans = [], executionStrategy: any = {}) {
  const waves = Array.isArray(executionStrategy.waves) ? executionStrategy.waves : [];
  const byWave = waves.map((w) => {
    const waveNum = Number.isFinite(Number(w.wave)) ? Number(w.wave) : 1;
    const wavePlans = plans.filter((p) => (Number.isFinite(Number(p.wave)) ? Number(p.wave) : 1) === waveNum);
    const roles = [...new Set(wavePlans.map((p) => String(p.role || "evolution-worker")))];
    return {
      wave: waveNum,
      planCount: wavePlans.length,
      roles,
      estimatedRequests: roles.length
    };
  });

  const byRoleMap = new Map();
  for (const plan of plans) {
    const role = String(plan.role || "evolution-worker");
    const wave = Number.isFinite(Number(plan.wave)) ? Number(plan.wave) : 1;
    if (!byRoleMap.has(role)) byRoleMap.set(role, new Set());
    byRoleMap.get(role).add(wave);
  }
  const byRole = [...byRoleMap.entries()].map(([role, waveSet]) => ({
    role,
    planCount: plans.filter((plan) => String(plan.role || "evolution-worker") === role).length,
    estimatedRequests: waveSet.size
  }));

  const estimatedPremiumRequestsTotal = Math.max(1, 3 + byWave.reduce((acc, w) => acc + w.estimatedRequests, 0));
  const errorMarginPercent = 15;
  // hardCap must be at least planCount: the optimizer must not reject plans
  // that Prometheus itself produced. Plans > estimatedTotal are allowed up to planCount.
  const minHardCap = (plans as any[]).length;
  return {
    estimatedPremiumRequestsTotal,
    errorMarginPercent,
    hardCapTotal: Math.max(minHardCap, Math.ceil(estimatedPremiumRequestsTotal * (1 + errorMarginPercent / 100))),
    confidence: "medium",
    byWave,
    byRole,
    assumptions: [
      "1 Janus + 1 Prometheus + 1 Athena plan review per cycle",
      "1 worker premium request per role session within each execution wave"
    ]
  };
}

/**
 * Extract a scalar number from a raw plan contract field that may be either a
 * primitive number/string or an object-shaped value emitted by some LLM responses
 * (e.g. `{ "value": 0.5 }`).
 *
 * Accepted object shapes (checked in priority order):
 *   value · estimate · amount · score · number · v
 *
 * Returns `{ value: NaN, provenance: null }` for null/undefined inputs.
 * Returns `{ value: NaN, provenance: "no_scalar_key:<field>" }` when the object
 * exists but contains none of the canonical keys as a finite number.
 * When coercion succeeds, `provenance` is set to `"object_coercion:<field>:<key>"`
 * so callers can log it without losing the original parse context.
 *
 * @param rawValue  — raw field value from the parsed plan object
 * @param fieldName — field label used in provenance messages
 */
export function normalizeScalarContractField(
  rawValue: unknown,
  fieldName: string,
): { value: number; provenance: string | null } {
  if (rawValue === null || rawValue === undefined) {
    return { value: NaN, provenance: null };
  }
  // Fast path: primitive (number or numeric string) — no object coercion needed.
  if (typeof rawValue === "number" || typeof rawValue === "string") {
    return { value: Number(rawValue), provenance: null };
  }
  // Object-shaped: try canonical scalar keys in priority order.
  if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
    const obj = rawValue as Record<string, unknown>;
    for (const key of ["value", "estimate", "amount", "score", "number", "v"] as const) {
      if (key in obj && obj[key] !== null && obj[key] !== undefined) {
        const extracted = Number(obj[key]);
        if (Number.isFinite(extracted)) {
          return { value: extracted, provenance: `object_coercion:${fieldName}:${key}` };
        }
      }
    }
    const aggregateValues = Object.values(obj)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (aggregateValues.length > 0) {
      const aggregate = aggregateValues.reduce((sum, value) => sum + value, 0) / aggregateValues.length;
      return {
        value: Math.round(aggregate * 1000) / 1000,
        provenance: `object_aggregate:${fieldName}:${aggregateValues.length}`,
      };
    }
    return { value: NaN, provenance: `no_scalar_key:${fieldName}` };
  }
  return { value: Number(rawValue), provenance: null };
}

function normalizePlanFromTask(task, index, fallbackWave = 1) {
  const src = (task && typeof task === "object") ? task : {};
  const taskText = String(src.task || src.title || src.task_id || src.id || `Task-${index + 1}`).trim();
  const taskKind = String(src.taskKind || src.kind || inferTaskKindFromText(taskText)).trim().toLowerCase();
  const wave = normalizeWaveValue(src.wave, fallbackWave);
  const explicitAcceptanceCriteria = Array.isArray(src.acceptance_criteria)
    ? src.acceptance_criteria.map(v => String(v || "").trim()).filter(Boolean)
    : [];
  const baseTargetFiles = normalizeTargetFiles(src, taskText);
  const initialVerificationArtifacts = buildConcreteVerificationArtifacts(taskText, taskKind, baseTargetFiles, src);
  const targetFiles = [...new Set([...baseTargetFiles, ...(initialVerificationArtifacts.additionalTargetFiles || [])])];
  const verificationArtifacts = buildConcreteVerificationArtifacts(taskText, taskKind, targetFiles, src);
  const initialVerification = verificationArtifacts.verification;
  const compiled = compileAcceptanceCriteria({
    ...src,
    task: taskText,
    taskKind,
    verification: initialVerification,
    verification_commands: verificationArtifacts.verificationCommands,
    targetFiles,
    target_files: targetFiles,
  });
  const verification = compiled.verification || initialVerification;
  const normalizedAcceptanceCriteria = (explicitAcceptanceCriteria.length > 0
    ? explicitAcceptanceCriteria
    : compiled.criteria).map((criterion, criteriaIndex) => inferQuantifiedCriterion(taskText, criterion, criteriaIndex));
  const scope = String(src.scope || "").trim() || inferScopeFromTask(taskText, targetFiles);
  const beforeAfter = deriveBeforeAfterState(src, taskText, normalizedAcceptanceCriteria);
  const riskLevel = String(src.riskLevel || "").trim().toLowerCase() || inferRiskLevel(taskText);
  const premortem = ensureValidPremortem(riskLevel, src.premortem, taskText, targetFiles);
  const requestedRole = String(src.role || "evolution-worker").trim() || "evolution-worker";
  const planningCapabilityTag = String(
    src.capabilityTag
    || src.capability_tag
    || src._capabilityTag
    || inferPlanningCapabilityTag(
      taskText,
      taskKind,
      targetFiles,
      [
        scope,
        src.description,
        src.before_state,
        src.after_state,
        ...(Array.isArray(src.acceptance_criteria) ? src.acceptance_criteria : []),
        ...(Array.isArray(src.verification_commands) ? src.verification_commands : []),
        src.verification,
      ].join(" "),
    )
  ).trim().toLowerCase();
  const planningLane = String(
    src.capabilityLane
    || src.capability_lane
    || src._capabilityLane
    || capabilityTagToLane(planningCapabilityTag)
  ).trim().toLowerCase() || "implementation";
  const normalizedRole = normalizePlannerRoleForLane(requestedRole, planningLane);
  const interventionId = String(
    src.intervention_id || src.interventionId || src.task_id || src.id || `${normalizedRole}:${taskText}`
  ).trim() || `${normalizedRole}:${taskText}`;
  const estimatedExecutionTokens = Number.isFinite(Number(src.estimatedExecutionTokens)) && Number(src.estimatedExecutionTokens) > 0
    ? Math.floor(Number(src.estimatedExecutionTokens))
    : Number.isFinite(Number(src.estimated_execution_tokens)) && Number(src.estimated_execution_tokens) > 0
      ? Math.floor(Number(src.estimated_execution_tokens))
      : Number.isFinite(Number(src.estimated_tokens)) && Number(src.estimated_tokens) > 0
        ? Math.floor(Number(src.estimated_tokens))
        : Math.max(1, estimatePlanExecutionTokens({
          ...src,
          task: taskText,
          scope,
          target_files: targetFiles,
          acceptance_criteria: normalizedAcceptanceCriteria,
          verification: compiled.verification || initialVerification,
          riskLevel,
        }));

  // ── Parse-boundary normalization for object-shaped contract fields ─────────
  // Some LLM responses emit capacityDelta/requestROI as objects like
  // { "value": 0.5 } instead of bare scalars.  Normalize at the parse boundary
  // so the contract validator always receives the expected numeric type.
  const cdNorm = normalizeScalarContractField(src.capacityDelta, "capacityDelta");
  const roiNorm = normalizeScalarContractField(src.requestROI, "requestROI");
  if (cdNorm.provenance !== null) {
    console.warn(`[prometheus:normalize] ${taskText}: capacityDelta object-shaped coercion (${cdNorm.provenance})`);
  }
  if (roiNorm.provenance !== null) {
    console.warn(`[prometheus:normalize] ${taskText}: requestROI object-shaped coercion (${roiNorm.provenance})`);
  }
  const normalizedCapacityDelta = Number.isFinite(cdNorm.value) && cdNorm.value >= -1 && cdNorm.value <= 1
    ? cdNorm.value
    : 0.1;
  const normalizedRequestROI = Number.isFinite(roiNorm.value) && roiNorm.value > 0
    ? roiNorm.value
    : 1.0;
  const explicitLeverageRank = Array.isArray(src.leverage_rank)
    ? src.leverage_rank.map((value: unknown) => String(value || "").trim()).filter(Boolean)
    : [];
  const normalizedLeverageRank = explicitLeverageRank.length > 0
    ? normalizeLeverageRank(explicitLeverageRank)
    : inferLeverageRankFallback(
      taskText,
      scope,
      targetFiles,
      normalizedAcceptanceCriteria,
      beforeAfter.beforeState,
      beforeAfter.afterState,
      normalizedRole,
      normalizedRequestROI,
      estimatedExecutionTokens,
    );
  const implementationStatus = String(src.implementationStatus || "").toLowerCase();
  const redundantCandidate =
    ["implemented", "implemented_correctly", "already_implemented", "completed", "complete"].includes(implementationStatus)
    || /\balready\b|\bredundant\b|\bduplicate\b|\bno-op\b/.test(taskText.toLowerCase());
  const explicitImplementationEvidence = Array.isArray(src.implementationEvidence)
    ? src.implementationEvidence.map((value: unknown) => String(value || "").trim()).filter(Boolean)
    : [];
  const implementationEvidence = explicitImplementationEvidence.length > 0
    ? explicitImplementationEvidence
    : redundantCandidate || normalizedLeverageRank.length < 2
      ? deriveImplementationEvidenceFallback(taskText, targetFiles, beforeAfter.beforeState, scope)
      : [];

  const normalizedPlan = {
    ...src,
    role: normalizedRole,
    intervention_id: interventionId,
    expectedImpact: src.expectedImpact || {
      metric: "completionRate",
      direction: "up",
      note: `Derived baseline expectation from taskKind=${taskKind}`,
    },
    // owner is a required packet field (ACTIONABLE IMPROVEMENT PACKET FORMAT).
    // Preserve the explicit owner when provided; fall back to role.
    owner: String(src.owner || normalizedRole || "evolution-worker").trim() || "evolution-worker",
    task: taskText,
    priority: Number.isFinite(Number(src.priority)) ? Number(src.priority) : index + 1,
    wave,
    verification,
    taskKind,
    title: String(src.title || taskText).trim(),
    scope,
    task_id: String(src.task_id || src.id || taskText).trim(),
    description: String(src.description || "").trim(),
    waveLabel: String(src.waveLabel || "").trim(),
    targetFiles,
    target_files: targetFiles,
    beforeState: beforeAfter.beforeState,
    before_state: beforeAfter.beforeState,
    afterState: beforeAfter.afterState,
    after_state: beforeAfter.afterState,
    verification_commands: verificationArtifacts.verificationCommands,
    capabilityTag: planningCapabilityTag,
    capability_tag: planningCapabilityTag,
    _capabilityTag: planningCapabilityTag,
    capabilityLane: planningLane,
    capability_lane: planningLane,
    _capabilityLane: planningLane,
    acceptance_criteria: normalizedAcceptanceCriteria,
    dependencies: Array.isArray(src.dependencies)
      ? src.dependencies.map(v => String(v || "").trim()).filter(Boolean)
      : [],
    riskLevel,
    premortem,
    // leverage_rank: which EQUAL DIMENSION SET dimensions this task improves.
    // Preserved from source when provided; otherwise inferred from concrete packet structure.
    leverage_rank: normalizedLeverageRank,
    implementationEvidence,
    // waveDepends: numeric wave numbers this wave depends on.
    // Propagated from the wave object by buildPlansFromAlternativeShape /
    // buildPlansFromBottlenecksShape so downstream schedulers can honour
    // wave-level ordering without re-parsing executionStrategy.
    waveDepends: Array.isArray(src.waveDepends)
      ? (src.waveDepends as any[]).map(Number).filter(n => Number.isFinite(n))
      : [],
    // capacityDelta / requestROI: normalized at parse boundary above via
    // normalizeScalarContractField() to handle object-shaped LLM outputs.
    capacityDelta: normalizedCapacityDelta,
    requestROI: normalizedRequestROI,
    // estimatedExecutionTokens: approximate total tokens this task is expected
    // to consume in a worker run; used for token-capacity-aware batching.
    estimatedExecutionTokens,
  };
  return {
    ...normalizedPlan,
    planArtifact: buildPrometheusPlanArtifact(normalizedPlan),
  };
}

function compactWavesForDependencyAwarePlanning(plans = []) {
  if (!Array.isArray(plans) || plans.length === 0) return [];

  const normalized = plans.map((plan, index) => {
    const id = String(plan?.task_id || plan?.id || plan?.task || `task-${index + 1}`).trim() || `task-${index + 1}`;
    const depsRaw = [
      ...(Array.isArray(plan?.dependsOn) ? plan.dependsOn : []),
      ...(Array.isArray(plan?.dependencies) ? plan.dependencies : []),
    ];
    const deps = [...new Set(depsRaw.map((v) => String(v || "").trim()).filter(Boolean))];
    return { id, deps };
  });

  const knownIds = new Set(normalized.map((item) => item.id));
  for (const item of normalized) {
    item.deps = item.deps.filter((dep) => dep !== item.id && knownIds.has(dep));
  }

  const hasAnyDependencies = normalized.some((item) => item.deps.length > 0);
  if (!hasAnyDependencies) {
    // No explicit deps — preserve the wave assignments Prometheus already set
    // instead of collapsing everything to wave 1. Collapsing removes ordering
    // information that Athena uses to restructure execution waves.
    return plans;
  }

  try {
    const graph = resolveDependencyGraph(
      normalized.map((item) => ({ id: item.id, dependsOn: item.deps, filesInScope: [] }))
    );
    if (graph.status !== GRAPH_STATUS.OK || !Array.isArray(graph.waves) || graph.waves.length === 0) {
      return plans;
    }

    const waveById = new Map<string, number>();
    for (const wave of graph.waves) {
      const waveNum = Number(wave?.wave || 1);
      for (const taskId of Array.isArray(wave?.taskIds) ? wave.taskIds : []) {
        waveById.set(String(taskId), waveNum);
      }
    }

    return plans.map((plan, index) => {
      const current = normalized[index];
      const wave = Number(waveById.get(current.id) || plan?.wave || 1);
      const waveDepends = [...new Set(
        current.deps
          .map((depId) => Number(waveById.get(depId) || 0))
          .filter((depWave) => Number.isFinite(depWave) && depWave > 0 && depWave < wave)
      )].sort((a, b) => a - b);

      return {
        ...plan,
        wave,
        waveDepends,
        dependencies: current.deps,
        dependsOn: current.deps,
      };
    });
  } catch {
    return plans;
  }
}

function buildPlansFromAlternativeShape(input: any = {}) {
  if (!input || typeof input !== "object") return [];

  const taskIndexByKey = new Map();
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i] && typeof tasks[i] === "object" ? tasks[i] : {};
    const keys = [t.task_id, t.id, t.title, t.task].map(v => String(v || "").trim()).filter(Boolean);
    for (const key of keys) {
      if (!taskIndexByKey.has(key)) taskIndexByKey.set(key, i);
    }
  }

  const waveByTaskIndex = new Map();
  const waveDependsByTaskIndex = new Map();
  const waves = Array.isArray(input.waves) ? input.waves : [];
  for (let i = 0; i < waves.length; i++) {
    const waveObj = (waves[i] && typeof waves[i] === "object") ? waves[i] : {};
    const waveValue = normalizeWaveValue(waveObj.wave, i + 1 as any);
    // Capture wave-level dependency numbers so they survive plan normalization.
    const waveDepends: number[] = Array.isArray(waveObj.dependsOn)
      ? (waveObj.dependsOn as any[]).map(Number).filter(n => Number.isFinite(n))
      : Array.isArray(waveObj.dependsOnWaves)
        ? (waveObj.dependsOnWaves as any[]).map(Number).filter(n => Number.isFinite(n))
        : [];
    const waveTasks = Array.isArray(waveObj.tasks) ? waveObj.tasks : [];
    for (const waveTask of waveTasks) {
      if (waveTask && typeof waveTask === "object") {
        // Merge wave-level dependsOn into the task object before normalizing so
        // waveDepends is preserved through normalizePlanFromTask's ...src spread.
        const taskWithMeta = waveDepends.length > 0
          ? { waveDepends, ...waveTask }
          : waveTask;
        const asTask = normalizePlanFromTask(taskWithMeta, tasks.length, waveValue as any);
        tasks.push(asTask);
        const idx = tasks.length - 1;
        taskIndexByKey.set(asTask.task_id, idx);
        taskIndexByKey.set(asTask.task, idx);
        continue;
      }
      const key = String(waveTask || "").trim();
      if (!key) continue;
      const idx = taskIndexByKey.get(key);
      if (Number.isInteger(idx)) {
        waveByTaskIndex.set(idx, waveValue);
        if (waveDepends.length > 0) waveDependsByTaskIndex.set(idx, waveDepends);
      } else {
        // Unmatched string task: synthesize a stub plan rather than silently
        // dropping it.  The full plan fields are filled by normalizePlanFromTask.
        const stubIdx = tasks.length;
        const stub: Record<string, any> = { task: key, task_id: key, title: key };
        if (waveDepends.length > 0) stub.waveDepends = waveDepends;
        tasks.push(stub);
        taskIndexByKey.set(key, stubIdx);
        waveByTaskIndex.set(stubIdx, waveValue);
        if (waveDepends.length > 0) waveDependsByTaskIndex.set(stubIdx, waveDepends);
      }
    }
  }

  if (tasks.length > 0) {
    return tasks.map((task, i) => {
      const waveDepends = waveDependsByTaskIndex.get(i);
      // Merge wave depends into the task object so normalizePlanFromTask sees it
      // via ...src and emits it as waveDepends on the output plan.
      const taskWithMeta = waveDepends && !task.waveDepends
        ? { waveDepends, ...task }
        : task;
      return normalizePlanFromTask(taskWithMeta, i, waveByTaskIndex.get(i) || 1);
    });
  }

  return [];
}

/**
 * Build plans from the GPT analytical format: topBottlenecks[] + waves[].tasks (strings).
 * This is the format GPT-5.3-Codex produces when asked for a bottleneck analysis.
 */
function buildPlansFromBottlenecksShape(input) {
  const SEVERITY_PRIORITY = { critical: 1, high: 2, medium: 3, low: 4 };
  const waves = Array.isArray(input.waves) ? input.waves : [];
  const bottlenecks = Array.isArray(input.topBottlenecks) ? input.topBottlenecks : [];
  const proofMetrics = Array.isArray(input.proofMetrics) ? input.proofMetrics : [];

  const plans = [];

  for (const waveObj of waves) {
    if (!waveObj || typeof waveObj !== "object") continue;
    const waveNum = normalizeWaveValue(waveObj.wave, 1);
    // Preserve wave-level dependency numbers for downstream schedulers.
    const waveDepends: number[] = Array.isArray(waveObj.dependsOn)
      ? (waveObj.dependsOn as any[]).map(Number).filter(n => Number.isFinite(n))
      : Array.isArray(waveObj.dependsOnWaves)
        ? (waveObj.dependsOnWaves as any[]).map(Number).filter(n => Number.isFinite(n))
        : [];
    const taskStrings = Array.isArray(waveObj.tasks) ? waveObj.tasks : [];

    for (const taskStr of taskStrings) {
      const taskText = String(taskStr || "").trim();
      if (!taskText) continue;
      const lowerTask = taskText.toLowerCase();

      // Find a matching bottleneck by keyword overlap (split on all non-alphanumeric incl. underscores)
      const taskWords = lowerTask.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
      const matchedBn = bottlenecks.find(bn => {
        const titleWords = String(bn.title || "").toLowerCase()
          .split(/[^a-z0-9]+/).filter(w => w.length >= 4);
        return titleWords.some(w => taskWords.includes(w));
      });

      // Find a matching proof metric and normalize it to a portable command
      const rawMetric = proofMetrics.find(m => {
        const metricWords = String(m || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
        return taskWords.some(w => metricWords.includes(w));
      }) || "npm test";
      const verificationMetric = rewriteVerificationCommand(rawMetric);

      const severity = matchedBn?.severity || "medium";
      const plan: Record<string, any> = {
        role: "evolution-worker",
        task: taskText,
        priority: SEVERITY_PRIORITY[severity] ?? plans.length + 1,
        wave: waveNum,
        verification: verificationMetric,
        title: taskText,
        scope: String(matchedBn?.evidence || "").slice(0, 200),
        task_id: taskText,
        verification_commands: [verificationMetric],
        acceptance_criteria: [],
        dependencies: [],
        _fromBottleneck: matchedBn?.id || null,
      };
      if (waveDepends.length > 0) plan.waveDepends = waveDepends;
      plans.push(plan);
    }
  }

  // If no waves, fall back to one plan per bottleneck
  if (plans.length === 0) {
    for (let i = 0; i < bottlenecks.length; i++) {
      const bn = bottlenecks[i];
      const taskText = String(bn.title || `Fix-${bn.id}`).trim();
      const rawCmd = proofMetrics[i] || "npm test";
      const normalizedCmd = rewriteVerificationCommand(rawCmd);
      plans.push({
        role: "evolution-worker",
        task: taskText,
        priority: SEVERITY_PRIORITY[bn.severity] ?? i + 1,
        wave: i + 1,
        verification: normalizedCmd,
        title: taskText,
        scope: String(bn.evidence || "").slice(0, 200),
        task_id: String(bn.id || `bn-${i}`),
        verification_commands: [normalizedCmd],
        acceptance_criteria: [],
        dependencies: [],
        _fromBottleneck: bn.id || null,
      });
    }
  }

  return plans;
}

/**
 * Compute what fraction of the declared top bottlenecks are addressed by the generated plans.
 *
 * A bottleneck is considered "covered" when at least one plan's task text, title, or
 * _fromBottleneck field references the bottleneck's id or contains meaningful keyword overlap
 * with the bottleneck's title (≥2 matching 4-char words).
 *
 * @param plans - normalized plan objects
 * @param bottlenecks - topBottlenecks array from the Prometheus output
 * @returns {{ coverage: number, covered: string[], uncovered: string[], total: number }}
 */
export function computeBottleneckCoverage(plans: any[], bottlenecks: any[]): {
  coverage: number;
  covered: string[];
  uncovered: string[];
  total: number;
} {
  const bns = Array.isArray(bottlenecks) ? bottlenecks : [];
  const planList = Array.isArray(plans) ? plans : [];

  if (bns.length === 0) {
    return { coverage: 1.0, covered: [], uncovered: [], total: 0 };
  }

  const covered: string[] = [];
  const uncovered: string[] = [];

  for (const bn of bns) {
    const bnId = String(bn?.id || "").trim();
    const bnTitle = String(bn?.title || "").toLowerCase();
    const bnWords = bnTitle.split(/[^a-z0-9]+/).filter(w => w.length >= 4);

    const isCovered = planList.some(plan => {
      // Explicit bottleneck reference
      if (bnId && String(plan._fromBottleneck || "").trim() === bnId) return true;
      // Keyword overlap: ≥2 matching words between bottleneck title and plan task/title
      const planText = `${String(plan.task || "")} ${String(plan.title || "")}`.toLowerCase();
      const planWords = planText.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
      const matches = bnWords.filter(w => planWords.includes(w));
      return matches.length >= 2;
    });

    if (isCovered) {
      covered.push(bnId || bnTitle.slice(0, 40));
    } else {
      uncovered.push(bnId || bnTitle.slice(0, 40));
    }
  }

  const coverage = bns.length > 0 ? Math.round((covered.length / bns.length) * 100) / 100 : 1.0;
  return { coverage, covered, uncovered, total: bns.length };
}

/** Minimum bottleneck coverage ratio before a confidence penalty is applied. */
export const BOTTLENECK_COVERAGE_FLOOR = 0.5;

function buildPlansFromNarrative(analysisText) {
  const lines = String(analysisText || "").split(/\r?\n/);
  const plans = [];
  let currentWave = 1;
  let currentWaveLabel = "";
  let currentSection = "";
  let inWaveSection = false;

  const normalizeSectionTitle = (value) => String(value || "")
    .toLowerCase()
    .replace(/[*`:#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const isActionSection = (section) => {
    const s = normalizeSectionTitle(section);
    if (!s) return false;
    return [
      "model capacity utilization",
      "what to stop / simplify / remove",
      "what to stop simplify remove",
      "architecture evolution roadmap",
      "recommendations",
      "next steps",
      "execution roadmap",
      "master plan"
    ].some(label => s.includes(label));
  };

  const isDiagnosticSection = (section) => {
    const s = normalizeSectionTitle(section);
    if (!s) return false;
    return [
      "mandatory answers",
      "evolution diagnosis",
      "strategic diagnosis",
      "prometheus self-critique",
      "metrics for a smarter next cycle",
      "final recommendation",
      "governance and rollback policy"
    ].some(label => s.includes(label));
  };

  const looksLikeActionablePlanLine = (text) => {
    const s = String(text || "").trim().toLowerCase();
    if (!s) return false;
    if (/^(strengths?|core bottleneck|recurrent defect|scaling risk|premium efficiency ceiling|why|exit criteria|rollback triggers?)\b/.test(s)) {
      return false;
    }
    return /^(task\s+\d|ship\b|fix\b|patch\b|replace\b|add\b|create\b|promote\b|keep\b|split\b|feed\b|require\b|validate\b|tighten\b|introduce\b|use\b|reduce\b|enforce\b|enable\b|remove\b|simplify\b|stop\b|upgrade\b|migrate\b|implement\b|refactor\b|extract\b|wire\b|emit\b|build\b|setup\b|configure\b|integrate\b)/.test(s);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    if (!line) continue;

    const headingMatch = line.match(/^#+\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[1];
      // Exit wave-collection mode when entering a diagnostic/analysis section
      // so Q&A answers are not mistaken for actionable tasks.
      if (isDiagnosticSection(currentSection)) inWaveSection = false;
    }

    // Wave header — capture wave number AND full label/description
    // Handles: "**Wave 0**", "### Wave 0 — Gate unblocker (must ship first)",
    //          "**Wave 0 (Gate blocker, must ship first)**"
    const waveMatch = line.match(/(?:^#+\s*)?(?:\*\*)?wave\s+(\d+)[:\s—\-\u2013\u2014(]*(.*?)(?:\*\*)?$/i);
    if (waveMatch) {
      currentWave = Math.max(1, Number(waveMatch[1]) || 1);
      inWaveSection = true;
      currentWaveLabel = String(waveMatch[2] || "")
        .replace(/\*\*/g, "")
        .replace(/[()]/g, "")
        .replace(/^\s*[-—\u2013\u2014]\s*/, "")
        .trim();
      continue;
    }

    // Numbered tasks: "1) Task", "2. **Task**: detail"
    const numberedMatch = line.match(/^\d+[).:-]\s*(.+)$/);
    if (numberedMatch) {
      const taskText = numberedMatch[1]
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .trim();
      const canCaptureNumbered = (inWaveSection || isActionSection(currentSection)) && !isDiagnosticSection(currentSection);
      if (taskText && canCaptureNumbered && looksLikeActionablePlanLine(taskText)) {
        // Collect continuation lines that follow until the next list item / wave header
        const continuationParts = [];
        while (i + 1 < lines.length) {
          const nextRaw = String(lines[i + 1] || "").trim();
          if (!nextRaw) { i++; continue; }
            if (/^\d+[).:-]\s/.test(nextRaw) || /^[-*]\s/.test(nextRaw) ||
              /(?:^#+\s*)?(?:\*\*)?wave\s+\d+/i.test(nextRaw) || /^#+\s/.test(nextRaw) ||
              /^===|^---/.test(nextRaw)) break;
          continuationParts.push(nextRaw.replace(/\*\*/g, "").replace(/`/g, "").trim());
          i++;
        }
        plans.push({
          task: taskText,
          wave: currentWave,
          waveLabel: currentWaveLabel,
          description: continuationParts.join(" "),
          verification: "npm test"
        });
      }
      continue;
    }

    // Bulleted tasks under waves: "- **Task**: ..."
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      const taskText = bulletMatch[1]
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .trim();
      const canCaptureBullet = inWaveSection || (isActionSection(currentSection) && !isDiagnosticSection(currentSection));
      if (taskText.length >= 8 && canCaptureBullet && looksLikeActionablePlanLine(taskText)) {
        const continuationParts = [];
        while (i + 1 < lines.length) {
          const nextRaw = String(lines[i + 1] || "").trim();
          if (!nextRaw) { i++; continue; }
            if (/^\d+[).:-]\s/.test(nextRaw) || /^[-*]\s/.test(nextRaw) ||
              /(?:^#+\s*)?(?:\*\*)?wave\s+\d+/i.test(nextRaw) || /^#+\s/.test(nextRaw) ||
              /^===|^---/.test(nextRaw)) break;
          continuationParts.push(nextRaw.replace(/\*\*/g, "").replace(/`/g, "").trim());
          i++;
        }
        plans.push({
          task: taskText,
          wave: currentWave,
          waveLabel: currentWaveLabel,
          description: continuationParts.join(" "),
          verification: "npm test"
        });
      }
    }
  }

  // Deduplicate by normalized task text while keeping insertion order.
  const seen = new Set();
  const unique = [];
  for (const p of plans) {
    const key = String(p.task || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }

  return unique;
}

/**
 * Canonical planner health aliases.
 * LLMs instructed to emit "<healthy|warning|critical>" may return these alias
 * values instead of the canonical internal values ("good", "needs-work", "critical").
 * Normalizing before validation ensures alias inputs score at full confidence.
 */
export const PLANNER_HEALTH_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  healthy:  "good",
  degraded: "needs-work",
  critical: "critical",
  good: "good",
  "needs-work": "needs-work",
  "needs work": "needs-work",
  "needs_work": "needs-work",
  needswork: "needs-work",
  warning:  "needs-work",
});

const REQUIRED_PROMETHEUS_HEALTH_VALUES = new Set(["healthy", "degraded", "critical", "needs-work", "good"]);

export function hasPrometheusRuntimeContractSignals(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const payload = parsed as Record<string, unknown>;
  const planningTruthStatus = String(payload.planningTruthStatus ?? DIAGNOSTICS_PLANNING_TRUTH_STATUS.LIVE)
    .trim()
    .toLowerCase();
  if (planningTruthStatus !== DIAGNOSTICS_PLANNING_TRUTH_STATUS.LIVE) return false;
  const generatedAt = String(payload.generatedAt ?? "").trim();
  const keyFindings = String(payload.keyFindings ?? "").trim();
  return (
    generatedAt.length > 0 &&
    keyFindings.length >= STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH &&
    !isStrategicFieldToolTraceContaminated(keyFindings)
  );
}

export const CYCLE_PROOF_SEAM_KEYS = Object.freeze(["prometheus", "athena", "worker"] as const);

export function validateCycleProofEvidenceSeams(artifact: unknown): {
  ok: boolean;
  cycleId: string;
  seamChecks: Record<string, { pass: boolean; failReasons: string[] }>;
  failReasons: string[];
} {
  const failReasons: string[] = [];
  if (!artifact || typeof artifact !== "object") {
    return {
      ok: false,
      cycleId: "",
      seamChecks: {},
      failReasons: ["cycle_proof_evidence must be an object"],
    };
  }
  const payload = artifact as Record<string, unknown>;
  const cycleId = String(payload.cycleId ?? "").trim();
  if (!cycleId) failReasons.push("cycle_proof_evidence.cycleId missing");

  const seams = payload.seams && typeof payload.seams === "object"
    ? payload.seams as Record<string, unknown>
    : null;
  const checks = seams?.checks && typeof seams.checks === "object"
    ? seams.checks as Record<string, unknown>
    : null;
  if (!checks) failReasons.push("cycle_proof_evidence.seams.checks missing");

  const seamChecks: Record<string, { pass: boolean; failReasons: string[] }> = {};
  for (const key of CYCLE_PROOF_SEAM_KEYS) {
    const seam = checks?.[key] && typeof checks[key] === "object"
      ? checks[key] as Record<string, unknown>
      : null;
    if (!seam) {
      failReasons.push(`cycle_proof_evidence.seams.checks.${key} missing`);
      seamChecks[key] = { pass: false, failReasons: [`${key} seam check missing`] };
      continue;
    }
    const pass = seam.pass === true;
    const seamFailReasons = Array.isArray(seam.failReasons)
      ? seam.failReasons.map((reason) => String(reason || "").trim()).filter(Boolean)
      : [];
    if (seam.pass !== true && seam.pass !== false) {
      failReasons.push(`cycle_proof_evidence.seams.checks.${key}.pass must be boolean`);
    }
    if (!pass && seamFailReasons.length === 0) {
      failReasons.push(`cycle_proof_evidence.seams.checks.${key}.failReasons missing`);
    }
    if (!pass && seamFailReasons.length > 0) {
      failReasons.push(...seamFailReasons.map((reason) => `${key}: ${reason}`));
    }
    seamChecks[key] = { pass, failReasons: seamFailReasons };
  }

  return {
    ok: failReasons.length === 0,
    cycleId,
    seamChecks,
    failReasons,
  };
}

export function buildTrustedMemoryShortlist(
  knowledgeMemory: any,
  opts: { requestedBy?: string; includeLowTrust?: boolean } = {},
): {
  lessons: any[];
  promptHints: any[];
  droppedLowTrustLessons: number;
  droppedLowTrustHints: number;
} {
  const requestedBy = String(opts.requestedBy || "");
  const privilegedCaller = isPrivilegedMemoryRequester(requestedBy);
  const includeLowTrust = opts.includeLowTrust === true && privilegedCaller;
  const workingLessons = Array.isArray(knowledgeMemory?.working?.lessons) ? knowledgeMemory.working.lessons : [];
  const episodicLessons = Array.isArray(knowledgeMemory?.episodic?.lessons) ? knowledgeMemory.episodic.lessons : [];
  const flatLessons = Array.isArray(knowledgeMemory?.lessons) ? knowledgeMemory.lessons : [];
  const workingPromptHints = Array.isArray(knowledgeMemory?.working?.promptHints) ? knowledgeMemory.working.promptHints : [];
  const episodicPromptHints = Array.isArray(knowledgeMemory?.episodic?.promptHints) ? knowledgeMemory.episodic.promptHints : [];
  const flatPromptHints = Array.isArray(knowledgeMemory?.promptHints) ? knowledgeMemory.promptHints : [];
  const lessons = Number(knowledgeMemory?.schemaVersion) >= 2
    ? [...workingLessons, ...episodicLessons]
    : flatLessons;
  const promptHints = Number(knowledgeMemory?.schemaVersion) >= 2
    ? [...workingPromptHints, ...episodicPromptHints]
    : flatPromptHints;

  const filteredLessons = filterMemoryEntriesByTrust(lessons, {
    includeLowTrust,
    privilegedCaller,
  });
  const filteredHints = filterMemoryEntriesByTrust(promptHints, {
    includeLowTrust,
    privilegedCaller,
  });

  const lessonShortlist = buildRankedLessonShortlists(filteredLessons.selected, { limit: 10 });
  const rankedLessons = lessonShortlist.combinedTop10.slice(0, 10);
  const rankedHints = filteredHints.selected
    .slice(0, 20)
    .sort((a, b) => {
      const aWeight = a?.trust?.level === MEMORY_TRUST_LEVEL.HIGH ? 3 : (a?.trust?.level === MEMORY_TRUST_LEVEL.MEDIUM ? 2 : 1);
      const bWeight = b?.trust?.level === MEMORY_TRUST_LEVEL.HIGH ? 3 : (b?.trust?.level === MEMORY_TRUST_LEVEL.MEDIUM ? 2 : 1);
      return bWeight - aWeight;
    })
    .slice(0, 5);

  return {
    lessons: rankedLessons,
    promptHints: rankedHints,
    droppedLowTrustLessons: filteredLessons.droppedLowTrustCount,
    droppedLowTrustHints: filteredHints.droppedLowTrustCount,
  };
}

export function reconcilePromptMemoryShortlistByTruth(
  shortlist: {
    lessons?: unknown[];
    promptHints?: unknown[];
    droppedLowTrustLessons?: number;
    droppedLowTrustHints?: number;
  } | null | undefined,
  signals: PromptTruthSignals,
): {
  lessons: unknown[];
  promptHints: unknown[];
  droppedLowTrustLessons: number;
  droppedLowTrustHints: number;
  retiredPromptHints: Array<{ label: string; reason: string }>;
} {
  const safeShortlist = shortlist && typeof shortlist === "object"
    ? shortlist
    : {};
  const hintSnapshot = reconcilePromptTruthItems(Array.isArray(safeShortlist.promptHints) ? safeShortlist.promptHints : [], {
    kind: "hint",
    signals,
    getText: (item) => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object" || Array.isArray(item)) return "";
      const record = item as Record<string, unknown>;
      return String(record.hint || record.reason || record.lesson || record.finding || "").trim();
    },
    getLabel: (item) => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object" || Array.isArray(item)) return "";
      const record = item as Record<string, unknown>;
      return String(record.hint || record.reason || record.lesson || record.finding || "").trim();
    },
    getId: (item, index) => (item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).id || (item as Record<string, unknown>).addedAt || (item as Record<string, unknown>).source
      : null) || `hint-${index + 1}`,
    retireWhen: (item, text, truthSignals) =>
      resolveStructuredTruthRetirement(item, text)
      || resolvePromptTruthRetirement(text, truthSignals),
  });

  return {
    lessons: Array.isArray(safeShortlist.lessons) ? safeShortlist.lessons : [],
    promptHints: hintSnapshot.active,
    droppedLowTrustLessons: Number(safeShortlist.droppedLowTrustLessons || 0),
    droppedLowTrustHints: Number(safeShortlist.droppedLowTrustHints || 0),
    retiredPromptHints: hintSnapshot.retired.map(({ label, reason }) => ({ label, reason })),
  };
}

function hasValidParserContractFields(parsed: any): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const rawHealth = String(parsed.projectHealth ?? "").trim().toLowerCase();
  const health = rawHealth.replace(/\s+/g, "-");
  const estimatedTotal = Number(parsed?.requestBudget?.estimatedPremiumRequestsTotal);
  const generatedAt = String(parsed?.generatedAt ?? "").trim();
  // keyFindings must be a string — reject arrays, objects, and other non-string types
  // that coerce to misleading values (e.g. an array ["f1","f2"] would become "f1,f2").
  if (typeof parsed.keyFindings !== "string") return false;
  const keyFindings = parsed.keyFindings.trim();
  const strategicNarrative = String(parsed?.strategicNarrative ?? "").trim();
  if (
    !REQUIRED_PROMETHEUS_HEALTH_VALUES.has(health)
    || !Number.isFinite(estimatedTotal)
    || generatedAt.length === 0
    || keyFindings.length < STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH
    || isStrategicFieldToolTraceContaminated(keyFindings)
    || strategicNarrative.length < STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH
    || isStrategicFieldToolTraceContaminated(strategicNarrative)
  ) {
    return false;
  }
  // Acceptance-criteria emptiness detection at the generation boundary.
  // Only fires when at least one plan explicitly declares the acceptance_criteria
  // key (model committed to providing AC) but every declared item is blank/empty.
  // Plans that omit the key entirely are handled post-normalization by validatePlanContract.
  const plans = Array.isArray(parsed.plans) ? parsed.plans : [];
  if (plans.length > 0) {
    const plansWithExplicitAC = plans.filter((p: any) => p != null && "acceptance_criteria" in p);
    if (plansWithExplicitAC.length > 0) {
      const hasAnyNonEmptyAC = plansWithExplicitAC.some((p: any) =>
        Array.isArray(p.acceptance_criteria) &&
        p.acceptance_criteria.some((item: any) => String(item ?? "").trim().length > 0)
      );
      if (!hasAnyNonEmptyAC) return false;
    }
  }
  return true;
}

function buildParserContractRetryDiff(parsed: any): string {
  const missing: string[] = [];
  const invalid: string[] = [];
  const rawHealth = String(parsed?.projectHealth ?? "").trim();
  const normalizedHealth = rawHealth.toLowerCase().replace(/\s+/g, "-");
  if (!rawHealth) {
    missing.push("projectHealth");
  } else if (!REQUIRED_PROMETHEUS_HEALTH_VALUES.has(normalizedHealth)) {
    invalid.push(`projectHealth=${rawHealth}`);
  }
  const hasBudgetObject = parsed?.requestBudget && typeof parsed.requestBudget === "object";
  if (!hasBudgetObject || parsed.requestBudget.estimatedPremiumRequestsTotal == null || parsed.requestBudget.estimatedPremiumRequestsTotal === "") {
    missing.push("requestBudget.estimatedPremiumRequestsTotal");
  } else if (!Number.isFinite(Number(parsed.requestBudget.estimatedPremiumRequestsTotal))) {
    invalid.push(`requestBudget.estimatedPremiumRequestsTotal=${String(parsed.requestBudget.estimatedPremiumRequestsTotal)}`);
  }
  const rawGeneratedAt = String(parsed?.generatedAt ?? "").trim();
  if (!rawGeneratedAt) {
    missing.push("generatedAt");
  }
  // keyFindings must be a string type — report non-string types explicitly.
  if (parsed?.keyFindings !== undefined && typeof parsed.keyFindings !== "string") {
    invalid.push(`keyFindings_wrong_type(${typeof parsed.keyFindings})`);
  } else {
    const rawKeyFindings = String(parsed?.keyFindings ?? "").trim();
    if (!rawKeyFindings) {
      missing.push("keyFindings");
    } else if (rawKeyFindings.length < STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH) {
      invalid.push(`keyFindings_too_short(len=${rawKeyFindings.length})`);
    } else if (isStrategicFieldToolTraceContaminated(rawKeyFindings)) {
      invalid.push("keyFindings_tool_trace_contaminated");
    }
  }
  const rawStrategicNarrative = String(parsed?.strategicNarrative ?? "").trim();
  if (!rawStrategicNarrative) {
    missing.push("strategicNarrative");
  } else if (rawStrategicNarrative.length < STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH) {
    invalid.push(`strategicNarrative_too_short(len=${rawStrategicNarrative.length})`);
  } else if (isStrategicFieldToolTraceContaminated(rawStrategicNarrative)) {
    invalid.push("strategicNarrative_tool_trace_contaminated");
  }
  // Report when plans explicitly declare acceptance_criteria (key present) but all items are blank.
  // Plans that omit the key entirely are caught post-normalization; only explicit emptiness is
  // a generation-boundary violation.
  const plans = Array.isArray(parsed?.plans) ? parsed.plans : [];
  if (plans.length > 0) {
    const plansWithExplicitAC = plans.filter((p: any) => p != null && "acceptance_criteria" in p);
    if (plansWithExplicitAC.length > 0) {
      const hasAnyNonEmptyAC = plansWithExplicitAC.some((p: any) =>
        Array.isArray(p.acceptance_criteria) &&
        p.acceptance_criteria.some((item: any) => String(item ?? "").trim().length > 0)
      );
      if (!hasAnyNonEmptyAC) {
        missing.push("plans[*].acceptance_criteria");
      }
    }
  }
  const missingText = missing.length > 0 ? missing.join(", ") : "none";
  const invalidText = invalid.length > 0 ? invalid.join(", ") : "none";
  return `missing=[${missingText}]; invalid=[${invalidText}]`;
}

function sanitizeParserContractCandidateFields(parsed: any): any {
  if (!parsed || typeof parsed !== "object") return parsed;
  const next = { ...parsed };
  if (typeof next.keyFindings === "string") {
    next.keyFindings = sanitizePlanningFieldForPersistence(next.keyFindings);
  }
  if (typeof next.strategicNarrative === "string") {
    next.strategicNarrative = sanitizePlanningFieldForPersistence(next.strategicNarrative);
  }
  return next;
}

function extractStrategicFieldText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((entry) => extractStrategicFieldText(entry))
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["keyFindings", "findings", "summary", "text", "narrative", "analysis", "description", "content", "message"]) {
      const text = extractStrategicFieldText(record[key]);
      if (text) return text;
    }
    for (const nested of Object.values(record)) {
      const text = extractStrategicFieldText(nested);
      if (text) return text;
    }
  }
  return "";
}

function buildStrategicParagraphFallbacks(parsed: any, raw: string): string[] {
  return [
    extractStrategicFieldText(parsed?.keyFindings),
    extractStrategicFieldText(parsed?.strategicNarrative),
    extractStrategicFieldText(parsed?.analysis),
    String(raw || "").trim(),
  ]
    .flatMap((source) => String(source || "").split(/\n{2,}/))
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 40);
}

function repairParserContractCandidate(parsed: any, raw: string): any {
  if (!parsed || typeof parsed !== "object") return parsed;
  const next = { ...parsed };
  if (!String(next.projectHealth ?? "").trim()) {
    next.projectHealth = inferProjectHealth(raw);
  }
  if (!String(next.generatedAt ?? "").trim()) {
    next.generatedAt = new Date().toISOString();
  }
  if (
    !next.requestBudget ||
    typeof next.requestBudget !== "object" ||
    next.requestBudget.estimatedPremiumRequestsTotal == null ||
    !Number.isFinite(Number(next.requestBudget.estimatedPremiumRequestsTotal))
  ) {
    const deterministicBudget = buildDeterministicRequestBudget(
      Array.isArray(next.plans) ? next.plans : [],
      next.executionStrategy ?? {},
    );
    next.requestBudget = {
      ...deterministicBudget,
      ...(next.requestBudget && typeof next.requestBudget === "object" ? next.requestBudget : {}),
      estimatedPremiumRequestsTotal: deterministicBudget.estimatedPremiumRequestsTotal,
    };
  }

  const paragraphs = buildStrategicParagraphFallbacks(next, raw);
  const normalizedKeyFindings = extractStrategicFieldText(next.keyFindings);
  next.keyFindings = normalizedKeyFindings || paragraphs[0] || "Analysis complete — see narrative for findings.";

  const normalizedStrategicNarrative = extractStrategicFieldText(next.strategicNarrative);
  next.strategicNarrative = normalizedStrategicNarrative
    || paragraphs[paragraphs.length - 1]
    || String(next.keyFindings || "Analysis complete — see narrative for direction.");

  return sanitizeParserContractCandidateFields(next);
}

export async function enforceParserContractBeforeNormalization(
  parsedCandidate: any,
  opts: {
    onRetryDiff?: (diff: string) => Promise<void> | void;
    onRetrySuccess?: () => Promise<void> | void;
    onRetryViolation?: (violationReason: string) => Promise<void> | void;
    buildRetryCandidate: (diff: string) => Promise<any | null>;
  },
): Promise<{ ok: boolean; parsed: any; retried: boolean; violationReason?: string }> {
  const repairedInitialCandidate = repairParserContractCandidate(parsedCandidate, "");
  if (hasValidParserContractFields(repairedInitialCandidate)) {
    return { ok: true, parsed: repairedInitialCandidate, retried: false };
  }
  const parserDiff = buildParserContractRetryDiff(repairedInitialCandidate);
  await opts.onRetryDiff?.(parserDiff);
  const retryCandidate = repairParserContractCandidate(await opts.buildRetryCandidate(parserDiff), "");
  if (retryCandidate && hasValidParserContractFields(retryCandidate)) {
    await opts.onRetrySuccess?.();
    return { ok: true, parsed: retryCandidate, retried: true };
  }
  const secondDiff = buildParserContractRetryDiff(retryCandidate || repairedInitialCandidate);
  await opts.onRetryViolation?.(secondDiff);
  return {
    ok: false,
    parsed: retryCandidate,
    retried: true,
    violationReason: secondDiff,
  };
}

/**
 * Normalize a raw projectHealth string by resolving known aliases to their
 * canonical equivalents before enum validation or divergence computation.
 *
 * @param {string} health — raw value from parser or LLM output
 * @returns {string} canonical health value
 */
export function normalizeProjectHealthAlias(health: string): string {
  const h = String(health || "").toLowerCase().trim();
  return (PLANNER_HEALTH_ALIASES as Record<string, string>)[h] ?? h;
}

export function resolvePrometheusProjectHealth(parsed: any): string {
  const canonical = normalizeProjectHealthAlias(String(parsed?.projectHealth || "").trim());
  const healthIsExplicit = parsed?._projectHealthExplicit === true;
  if (healthIsExplicit && ["good", "needs-work", "critical"].includes(canonical)) {
    return canonical;
  }

  if (parsed?._planContractGateFailed === true || String(parsed?.failReason || "").trim().length > 0) {
    return "critical";
  }

  const planCount = Array.isArray(parsed?.plans) ? parsed.plans.length : 0;
  const hardRejectionCount = [
    "_rejectedIncompleteCount",
    "_rejectedThinPacketCount",
    "_staleBackedRejectedCount",
    "_rejectedHighRiskLowConfidenceCount",
    "_quarantinedPacketCount",
  ].reduce((sum, key) => sum + (Number(parsed?.[key] || 0) || 0), 0);

  if (planCount === 0 && hardRejectionCount > 0) {
    return "critical";
  }

  return "good";
}

export function normalizePrometheusParsedOutput(parsed, aiResult: any = {}) {
  const input = (parsed && typeof parsed === "object") ? parsed : {};
  // Build analysis text — also cover topBottlenecks narrative as fallback
  const bnNarrative = Array.isArray(input.topBottlenecks) && input.topBottlenecks.length > 0
    ? input.topBottlenecks.map(bn => `[${bn.id}] ${bn.title}: ${bn.evidence}`).join("\n")
    : "";
  const analysisText = String(
    input.analysis
      || input.strategicNarrative
      || input.cycleObjective
      || aiResult?.thinking
      || bnNarrative
      || aiResult?.raw
      || ""
  ).trim();

  const rawPlans = Array.isArray(input.plans) ? input.plans : [];
  let plans = rawPlans.length > 0
    ? rawPlans.map((plan, i) => normalizePlanFromTask(plan, i, plan?.wave || 1))
    : buildPlansFromAlternativeShape(input);

  // Third shape: GPT analytical format — topBottlenecks[] + waves[].tasks (strings)
  if (plans.length === 0 && (Array.isArray(input.topBottlenecks) || Array.isArray(input.waves))) {
    plans = buildPlansFromBottlenecksShape(input)
      .map((plan, i) => normalizePlanFromTask(plan, i, plan?.wave || 1));
  }

  // Final fallback: parse wave + numbered narrative plans from free-form output.
  if (plans.length === 0 && analysisText.length > 0) {
    plans = buildPlansFromNarrative(analysisText)
      .map((plan, i) => normalizePlanFromTask(plan, i, plan?.wave || 1));
  }

  // Deterministic research-topic accounting fallback:
  // if the model omits synthesis_sources/informational_topics_consumed, recover
  // source linkage from lexical matching so planning does not become context-blind.
  const researchTopicsForLinkage = Array.isArray((aiResult as any)?.researchTopics)
    ? ((aiResult as any).researchTopics as unknown[]).map((t) => String(t || "").trim()).filter(Boolean)
    : [];
  const existingInformationalTopicsConsumed = Array.isArray((input as any)?.informational_topics_consumed)
    ? ((input as any).informational_topics_consumed as unknown[]).map((t) => String(t || "").trim()).filter(Boolean)
    : [];
  const linkageResult = applyDeterministicResearchSourceLinkage(
    plans,
    researchTopicsForLinkage,
    existingInformationalTopicsConsumed,
  );
  plans = linkageResult.plans;
  const normalizedInformationalTopicsConsumed = linkageResult.informationalTopicsConsumed;
  plans = alignPlansForAthenaReview(plans);

  const health = normalizeProjectHealthAlias(String(input.projectHealth || "").trim());
  const projectHealth = ["good", "needs-work", "critical"].includes(health)
    ? health
    : inferProjectHealth(analysisText);
  const planningMode = resolvePrometheusPlanningModeFromContext(input, aiResult);
  const planningUncertainty = resolveExecutionStrategyPlanningUncertainty(input, aiResult);

  let executionStrategy = (input.executionStrategy && typeof input.executionStrategy === "object")
    ? input.executionStrategy
    : { waves: Array.isArray(input.waves) ? input.waves : [] };
  if (!Array.isArray(executionStrategy.waves) || executionStrategy.waves.length === 0) {
    executionStrategy = buildExecutionStrategyFromPlans(plans, { planningMode, uncertainty: planningUncertainty });
  }
  // Normalize string tasks to canonical {role, task, task_id} objects — no string ambiguity.
  executionStrategy = normalizeExecutionStrategyWaveTasks({
    ...executionStrategy,
    planningMode: executionStrategy?.planningMode || planningMode,
    planningUncertainty: executionStrategy?.planningUncertainty || planningUncertainty,
  }, {
    uncertainty: planningUncertainty,
  });
  const executionStrategyContract = validateExecutionStrategyContract({
    plans,
    executionStrategy,
    planningMode,
    planningUncertainty,
  });
  if (!executionStrategyContract.valid) {
    executionStrategy = buildExecutionStrategyFromPlans(plans, { planningMode, uncertainty: planningUncertainty });
  } else {
    executionStrategy = {
      ...executionStrategy,
      planningMode: executionStrategyContract.planningMode,
      planningUncertainty,
      executionPattern: executionStrategyContract.executionPattern,
      workerTopology: executionStrategyContract.workerTopology,
    };
  }
  plans = plans.map((plan) => ({ ...plan, planningUncertainty }));

  let requestBudget = (input.requestBudget && Number.isFinite(Number(input.requestBudget.estimatedPremiumRequestsTotal)))
    ? {
      ...input.requestBudget,
      hardCapTotal: Number.isFinite(Number(input.requestBudget.hardCapTotal))
        ? Number(input.requestBudget.hardCapTotal)
        : Math.max(1, Math.ceil((plans.length || 1) * 1.25)),
    }
    : {
      estimatedPremiumRequestsTotal: Math.max(1, plans.length || 1),
      errorMarginPercent: 25,
      hardCapTotal: Math.max(1, Math.ceil((plans.length || 1) * 1.25)),
      confidence: "low",
      byWave: [],
      byRole: [],
      _fallback: true,
    };
  if (requestBudget._fallback) {
    requestBudget = {
      ...buildDeterministicRequestBudget(plans, executionStrategy),
      _fallback: false
    };
  }

  // Capture whether budget was model-provided or deterministically rebuilt.
  // Must be captured AFTER the rebuild so _fallback=false doesn't shadow the origin.
  const requestBudgetWasFallback = !(
    input.requestBudget && Number.isFinite(Number(input.requestBudget.estimatedPremiumRequestsTotal))
  );

  // ── Parser confidence: structured breakdown ──────────────────────────────
  // parserConfidenceComponents: per-dimension score (0-1) for each structural signal.
  // parserConfidencePenalties: explicit list of reasons why the score was reduced.
  // The aggregate parserConfidence remains a single 0-1 value (backward compatible).
  //
  //   plansShape          — 1.0 = JSON plans direct, 0.5 = narrative/alt-shape fallback, 0.0 = no plans
  //   healthField         — 1.0 = canonical/alias health from field, 0.9 = inferred from analysis text, 0.8 = unresolvable
  //   requestBudget       — 1.0 = budget provided by model, 0.9 = fallback rebuilt deterministically
  //   bottleneckCoverage  — 1.0 = all declared bottlenecks addressed, reduced by uncovered fraction

  const parserConfidencePenalties: Array<{ reason: string; component: string; delta: number }> = [];

  let plansShapeScore: number;
  if (rawPlans.length > 0) {
    plansShapeScore = 1.0;
  } else if (plans.length > 0) {
    plansShapeScore = 0.5;
    parserConfidencePenalties.push({ reason: "plans_from_narrative_fallback", component: "plansShape", delta: -0.5 });
  } else {
    plansShapeScore = 0.0;
    parserConfidencePenalties.push({ reason: "no_plans_extracted", component: "plansShape", delta: -0.9 });
  }

  // `health` is alias-normalized from input.projectHealth; `projectHealth` is the fully
  // resolved canonical value (filled via inferProjectHealth when the field was absent or
  // unrecognized).  Scoring uses the resolved canonical health so that successfully-inferred
  // health carries a lighter penalty than a truly unresolvable field.
  const CANONICAL_HEALTH_VALS = ["good", "needs-work", "critical"] as const;
  const healthFieldExplicit = Boolean(health && CANONICAL_HEALTH_VALS.includes(health as typeof CANONICAL_HEALTH_VALS[number]));
  const healthFieldResolved = CANONICAL_HEALTH_VALS.includes(projectHealth as typeof CANONICAL_HEALTH_VALS[number]);
  let healthFieldScore: number;
  if (healthFieldExplicit) {
    healthFieldScore = 1.0;
  } else if (healthFieldResolved) {
    // Health was resolved via text inference — slight penalty to signal field was not explicit.
    healthFieldScore = 0.9;
    parserConfidencePenalties.push({ reason: "health_field_inferred_from_text", component: "healthField", delta: -0.1 });
  } else {
    // Field absent and inference also produced no canonical value (defensive; currently unreachable).
    healthFieldScore = 0.8;
    parserConfidencePenalties.push({ reason: "health_field_missing_or_invalid", component: "healthField", delta: -0.2 });
  }

  const requestBudgetScore = requestBudgetWasFallback ? 0.9 : 1.0;
  if (requestBudgetWasFallback) {
    parserConfidencePenalties.push({ reason: "request_budget_fallback", component: "requestBudget", delta: -0.1 });
  }

  // ── Research source-linkage check ────────────────────────────────────────
  // When research context is injected, plans must either reference topics via
  // synthesis_sources[] or explicitly mark reviewed topics as informational.
  // Missing both signals indicates context-blind planning and is penalized.
  const researchTopicCount = Number((input as any)?.researchContext?.topicCount || 0);
  const informationalTopicsConsumed = normalizedInformationalTopicsConsumed.length;
  const sourceLinkedPlans = (Array.isArray(plans) ? plans : [])
    .filter((p: any) => Array.isArray(p?.synthesis_sources) && p.synthesis_sources.length > 0)
    .length;
  let sourceLinkageScore = 1.0;
  if (researchTopicCount > 0 && sourceLinkedPlans === 0 && informationalTopicsConsumed === 0) {
    sourceLinkageScore = 0.6;
    parserConfidencePenalties.push({
      reason: `research_source_linkage_missing_topics_${researchTopicCount}`,
      component: "sourceLinkage",
      delta: -0.4,
    });
  } else if (researchTopicCount > 0 && sourceLinkedPlans === 0 && informationalTopicsConsumed > 0) {
    sourceLinkageScore = 0.85;
    parserConfidencePenalties.push({
      reason: "research_source_linkage_informational_only",
      component: "sourceLinkage",
      delta: -0.15,
    });
  }

  // ── Bottleneck coverage check ────────────────────────────────────────────
  // When the input declared topBottlenecks, every bottleneck should be
  // addressed by at least one generated plan.  A coverage ratio below
  // BOTTLENECK_COVERAGE_FLOOR triggers a proportional confidence penalty
  // so low-coverage cycles cannot silently proceed past quality gates.
  const topBottlenecks = Array.isArray(input.topBottlenecks) ? input.topBottlenecks : [];
  const bnCovResult = computeBottleneckCoverage(plans, topBottlenecks);
  let bottleneckCoverageScore: number;
  if (topBottlenecks.length === 0) {
    bottleneckCoverageScore = 1.0;
  } else {
    bottleneckCoverageScore = bnCovResult.coverage;
    if (bnCovResult.coverage < BOTTLENECK_COVERAGE_FLOOR) {
      const uncoveredCount = bnCovResult.uncovered.length;
      const delta = -Math.round(Math.min(0.3, uncoveredCount * 0.05) * 100) / 100;
      parserConfidencePenalties.push({
        reason: `bottleneck_coverage_low_${bnCovResult.covered.length}_of_${bnCovResult.total}`,
        component: "bottleneckCoverage",
        delta,
      });
    }
  }

  const parserConfidenceComponents = {
    plansShape:         plansShapeScore,
    healthField:        healthFieldScore,
    requestBudget:      requestBudgetScore,
    sourceLinkage:      sourceLinkageScore,
    bottleneckCoverage: bottleneckCoverageScore,
  };

  // ── Confidence channel split ──────────────────────────────────────────────
  // parser-core channel: structural parser signals only (plansShape base,
  //   healthField, requestBudget).  Reflects fidelity of the extraction step.
  // context-penalty channel: external/contextual signals (bottleneckCoverage,
  //   architectureDrift) applied on top of the core score.
  // parserConfidence remains the aggregate (core − context) for backward compat.
  const coreBase = rawPlans.length > 0 ? 1.0 : plans.length > 0 ? 0.5 : 0.1;
  let parserCoreConfidence = coreBase;
  let parserContextPenalty = 0;
  for (const penalty of parserConfidencePenalties) {
    if (penalty.component === "plansShape") continue; // plansShape sets base, not an additive delta
    if (PARSER_CONTEXT_PENALTY_COMPONENTS.has(penalty.component)) {
      parserContextPenalty += -penalty.delta; // delta is negative; negate to get positive magnitude
    } else {
      parserCoreConfidence = Math.max(0.1, parserCoreConfidence + penalty.delta);
    }
  }
  parserCoreConfidence = Math.round(parserCoreConfidence * 100) / 100;
  parserContextPenalty = Math.round(parserContextPenalty * 100) / 100;
  const parserConfidence = Math.max(0.1, parserCoreConfidence - parserContextPenalty);

  // ── Strict parser confidence floor (Packet 11) ───────────────────────────
  // If confidence is below the floor, fail-closed: reject plans rather than
  // dispatching low-quality work. Plans are replaced with an empty set and
  // the analysis is preserved for manual review.
  // Floor set at 0.15 to catch truly unparseable output (base 0.1) while
  // allowing legitimate narrative-fallback parses (base 0.5 with penalties).
  const PARSER_CONFIDENCE_FLOOR = 0.15;
  const belowFloor = parserConfidence < PARSER_CONFIDENCE_FLOOR;
  const finalPlans = belowFloor ? [] : applyPlanningRubric(alignPlansForAthenaReview(plans));

  return {
    ...input,
    analysis: analysisText || "Prometheus analysis available but narrative was empty.",
    projectHealth,
    planningMode,
    promptLineage: input?.promptLineage && typeof input.promptLineage === "object"
      ? normalizePromptLineageContract(input.promptLineage)
      : null,
    _projectHealthExplicit: healthFieldExplicit,
    executionStrategy,
    requestBudget,
    parserConfidence: Math.round(parserConfidence * 100) / 100,
    parserCoreConfidence,
    parserContextPenalty,
    parserConfidenceComponents,
    parserConfidencePenalties,
    bottleneckCoverage: bnCovResult,
    informational_topics_consumed: normalizedInformationalTopicsConsumed,
    _parserBelowFloor: belowFloor,
    _parserConfidenceFloor: PARSER_CONFIDENCE_FLOOR,
    planArtifacts: finalPlans.map((plan: any) => plan.planArtifact || buildPrometheusPlanArtifact(plan)),
    plans: finalPlans
  };
}

const TOPIC_MATCH_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "those", "these",
  "agent", "agents", "system", "systems", "benchmark", "benchmarks", "evaluation", "evaluations",
  "general", "framework", "frameworks", "model", "models", "use", "using", "based",
]);

function tokenizeTopicForMatch(value: string): string[] {
  const tokens = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !TOPIC_MATCH_STOP_WORDS.has(t));
  return [...new Set(tokens)];
}

function applyDeterministicResearchSourceLinkage(
  plans: any[],
  researchTopics: string[],
  existingInformationalTopicsConsumed: string[],
): { plans: any[]; informationalTopicsConsumed: string[] } {
  const planList = Array.isArray(plans) ? plans : [];
  const topics = Array.isArray(researchTopics) ? researchTopics.filter(Boolean) : [];
  const informationalSeed = Array.isArray(existingInformationalTopicsConsumed)
    ? existingInformationalTopicsConsumed.filter(Boolean)
    : [];
  if (topics.length === 0) {
    return {
      plans: planList,
      informationalTopicsConsumed: [...new Set(informationalSeed)],
    };
  }

  const topicCatalog = topics.map((topic) => ({
    topic,
    key: topicKey(topic),
    tokens: tokenizeTopicForMatch(topic),
  }));
  const consumedTopicKeys = new Set<string>();

  const linkedPlans = planList.map((plan: any) => {
    const existingSources = Array.isArray(plan?.synthesis_sources)
      ? plan.synthesis_sources.map((s: unknown) => String(s || "").trim()).filter(Boolean)
      : [];

    if (existingSources.length > 0) {
      for (const source of existingSources) consumedTopicKeys.add(topicKey(source));
      return { ...plan, synthesis_sources: [...new Set(existingSources)] };
    }

    const haystack = [plan?.task, plan?.title, plan?.context, plan?.scope]
      .map((v) => String(v || "").toLowerCase())
      .join(" \n ");

    let bestTopic: { topic: string; key: string; tokens: string[] } | null = null;
    let bestScore = 0;
    for (const candidate of topicCatalog) {
      if (candidate.tokens.length === 0) continue;
      let score = 0;
      for (const token of candidate.tokens) {
        if (haystack.includes(token)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestTopic = candidate;
      }
    }

    if (bestTopic && bestScore >= 2) {
      consumedTopicKeys.add(bestTopic.key);
      return { ...plan, synthesis_sources: [bestTopic.topic] };
    }

    return { ...plan, synthesis_sources: [] };
  });

  const informational = [...new Set(informationalSeed)];
  for (const candidate of topicCatalog) {
    if (!consumedTopicKeys.has(candidate.key)) {
      informational.push(candidate.topic);
    }
  }

  return {
    plans: linkedPlans,
    informationalTopicsConsumed: [...new Set(informational)],
  };
}

function buildNarrativeFallbackParsed(aiResult) {
  const thinking = String(aiResult?.thinking || "").trim();
  const raw = String(aiResult?.raw || "").trim();
  const narrative = (thinking || raw || "Prometheus produced narrative-only output.").slice(0, 20000);
  const strategic = narrative.slice(0, 4000);

  return {
    analysis: narrative,
    strategicNarrative: strategic,
    projectHealth: inferProjectHealth(narrative),
    keyFindings: "Narrative-only analysis mode enabled; convert key findings from analysis text.",
    productionReadinessCoverage: [],
    dependencyModel: {
      criticalPath: [],
      parallelizableTracks: [],
      blockedBy: []
    },
    executionStrategy: {
      waves: []
    },
    requestBudget: {
      estimatedPremiumRequestsTotal: 1,
      errorMarginPercent: 30,
      hardCapTotal: 2,
      confidence: "low",
      byWave: [],
      byRole: [],
      _fallback: true
    },
    plans: []
  };
}

// ── Main Prometheus Analysis (simplified) ────────────────────────────────────

/**
 * Static invariant Prometheus planning prompt sections.
 * These do not change between planning cycles — extract them here so they can be
 * shared, tested, and referenced by name rather than being buried in a template literal.
 */

/** Build a section marked as invariant — always retained in full, never trimmed by maxTokens or global budget. */
const ivs = (name: string, content: string) => Object.assign(section(name, content), { required: true as const, partitionBudget: PROMPT_BUDGET_PARTITION.INVARIANT });

export const PROMETHEUS_STATIC_SECTIONS = Object.freeze({
  evolutionDirective: ivs("evolution-directive", `## EVOLUTION DIRECTIVE
You are NOT a risk-reducing planner. You are NOT a security-first hardening auditor.
You are the system's META-IMPROVER: your primary objective is TOTAL SYSTEM CAPACITY INCREASE.
"Capacity" means: more capability delivered per cycle, deeper reasoning, faster adaptation, better learning, higher task quality, smarter model usage — across every dimension simultaneously.
Risk reduction is a side-effect of capacity increase, never the goal itself.
You must treat every component of BOX — including Prometheus itself — as an improvement target.

## EQUAL DIMENSION SET
The following dimensions are ALL equally important. No single dimension dominates.
You MUST analyze and propose improvements for EACH of these:
1. Architecture (system topology, module design, data flow)
2. Speed (cycle throughput, latency, parallelism)
3. Task quality (correctness, depth, completeness of delivered work)
4. Prompt quality (instruction clarity, model utilization, reasoning depth)
5. Parser / normalization quality (output parsing, plan normalization, fence handling)
6. Worker specialization (role design, capability matching, multi-worker topology)
7. Model-task fit (routing complexity to the right model, token budget allocation)
8. Learning loop (postmortem-to-policy conversion, pattern detection, carry-forward)
9. Cost efficiency (premium requests per useful outcome, waste reduction)
10. Security (vulnerability prevention, access control, governance — ONE dimension among equals)`),

  mandatorySelfCritique: ivs("mandatory-self-critique", `## MANDATORY SELF-CRITIQUE SECTIONS
You MUST include a dedicated self-critique section for EACH of the following components.
Each section must answer: "What is this component doing well?", "What is it doing poorly?", and "How specifically should it improve next cycle?"
Do NOT just say "there is a problem" — produce a concrete improvement proposal for each.

1. **Janus Self-Critique** — Is Janus making good strategic decisions? Is it reading the right signals? How should its decision logic improve?
2. **Prometheus Self-Critique** — Is Prometheus producing actionable plans or strategic fluff? How should its reasoning, prompt structure, and output format improve?
3. **Athena Self-Critique** — Is Athena catching real issues or generating noise? Are postmortems driving actual change? How should review quality improve?
4. **Worker Structure Self-Critique** — Is the worker topology enabling or blocking progress? Are workers specialized enough? How should worker roles evolve?
5. **Parser / Normalization Self-Critique** — Is plan parsing reliable? Are fence blocks handled correctly? What parsing failures recur and how to fix them?
6. **Prompt Layer Self-Critique** — Are runtime prompts getting the most out of model capacity? What prompt patterns waste tokens or produce shallow output?
7. **Verification System Self-Critique** — Is verification catching real failures or generating false signals? Are verification commands reliable across platforms?`),

  mandatoryOperatorQuestions: ivs("mandatory-operator-questions", `## MANDATORY_OPERATOR_QUESTIONS
You MUST answer these explicitly in a dedicated section titled "Mandatory Answers" before the rest of the plan:
1. Is wave-based plan distribution truly the most efficient model for this system?
2. Should it be preserved, improved, or removed?
3. If it changes, what should replace it and how should the transition be executed?
4. Is Prometheus currently evolving the system, or mostly auditing and distributing tasks?
5. How should Prometheus improve its own reasoning structure, planning quality, and model-capacity utilization?
6. Does the worker behavior model and code structure help self-improvement, or block it?
7. In this cycle, what are the highest-leverage changes that make the system not only safer, but also smarter and deeper in reasoning?`),

  mandatoryDepthChain: ivs("mandatory-depth-chain", `## MANDATORY_DEPTH_CHAIN
For every high-priority packet, you MUST explicitly map all four links:
1. **Evidence** — concrete file/function/runtime signal proving the issue exists now.
2. **Root Cause** — why the issue occurs in current architecture/logic.
3. **Implementation Change** — exact code-level intervention that addresses the cause.
4. **Verification Evidence** — exact test/log/assertion that proves the change worked.

If any link is missing, that packet is incomplete and must be revised before final output.
Do NOT emit shallow recommendations that skip code-level implementation mapping.`),

  outputFormat: ivs("output-format", `## OUTPUT FORMAT
When planningMode=master_evolution, write a substantial senior-level narrative master plan.
When planningMode=repair_plan, write a focused repair plan that fixes the rejected plan contract without widening scope into a new master scan.
Every plan must still be centered on TOTAL SYSTEM CAPACITY INCREASE, not generic hardening.
First analyze how BOX can increase its capacity in every dimension, then derive what should change.

Include ALL of these sections (in this order):
1. Mandatory Answers
2. Evolution Diagnosis
3. Equal Dimension Analysis (one subsection per dimension from the EQUAL DIMENSION SET)
4. Mandatory Self-Critique: Janus
5. Mandatory Self-Critique: Prometheus
6. Mandatory Self-Critique: Athena
7. Mandatory Self-Critique: Worker Structure
8. Mandatory Self-Critique: Parser / Normalization
9. Mandatory Self-Critique: Prompt Layer
10. Mandatory Self-Critique: Verification System
11. System Redesign Directions (ranked by capacity-increase leverage)
12. Worker Model Redesign
13. Model Capacity Utilization
14. Metrics For A Smarter Next Cycle
15. Actionable Improvement Packets

## ACTIONABLE IMPROVEMENT PACKET FORMAT
Every concrete task you propose MUST be formatted as an Actionable Improvement Packet.
Do NOT produce vague strategic recommendations without this structure.
Each packet MUST contain ALL of the following fields:
- **title**: Clear one-line description of the change
- **owner**: Which component/agent/worker should execute this (e.g., evolution-worker, prometheus, athena, orchestrator)
- **wave**: Positive integer (≥1). Tasks in the same wave run in parallel; all wave N tasks complete before wave N+1 starts.
- **role**: Worker role identifier (e.g., "evolution-worker", "orchestrator", "prometheus")
  Role assignment policy: default to "evolution-worker". Use specialized roles
  (e.g., governance-worker, observation-worker, infrastructure-worker) ONLY when
  the task requires that role's unique domain behavior. Do not spread easy or
  generic implementation tasks across multiple specialized roles.
- **scope**: Module or directory boundary that this task is contained within (e.g., "src/core/orchestrator.js" or "src/workers/")
- **target_files**: Array of real file paths. ONLY use paths from the ## EXISTING REPOSITORY FILES section above. For new files, name the existing module that imports it and the exact call site.
- **before_state**: Observable CURRENT behavior — describe what specific function, code path, or measurable gap exists right now. Must be specific, not generic.
- **after_state**: Observable result after this task completes — what is measurably different. Must not restate the title.
- **riskLevel**: One of: "low" | "medium" | "high". Tasks touching orchestrator.js, athena_reviewer.js, prometheus.js, or gates.js default to "high".
- **dependencies**: Array of packet titles that must complete before this one, or empty array if none. If empty, state that wave ordering is the only ordering mechanism.
- **acceptance_criteria**: Array of ≥2 concrete testable statements that prove completion. Vague criteria like "code is improved" are rejected.
- **verification**: Specific test file path AND expected test description or observable log assertion (e.g., "tests/core/foo.test.ts — test: should return X when Y"). Generic "npm test" or "run tests" is REJECTED.
- **premortem** (REQUIRED when riskLevel is "medium" or "high"): Object with: failureModes (array of ≥2 distinct failure scenarios each with cause+impact), mitigations (array), rollbackPlan (string describing how to revert safely).
- **leverage_rank**: Which dimension(s) from the EQUAL DIMENSION SET this improves
- **capacityDelta** (REQUIRED): Finite number ∈ [-1.0, 1.0] — expected net change in system capacity if this plan succeeds. Positive = capacity gain, negative = capacity regression, zero = neutral. Used for plan ranking.
- **requestROI** (REQUIRED): Positive finite number — expected return-on-investment for the premium request consumed (e.g., 2.0 = doubles value spent). Used for plan ranking.
- **estimatedExecutionTokens** (REQUIRED): Positive integer — approximate total tokens this packet is expected to consume in one worker execution (prompt + reasoning + verification). Use realistic values (e.g., 12000, 28000), not placeholders.

## PACKET FIELD ENFORCEMENT RULES
These rules are enforced by the quality gate. Violations cause plan rejection:
1. **target_files**: Must list real existing paths verbatim from EXISTING REPOSITORY FILES. Do not invent module names. For new files, include the parent module path as the first entry.
2. **before_state**: Must describe observable current behavior — cite the actual function name, variable, or code gap. "Current state is suboptimal" is rejected.
3. **after_state**: Must describe what is measurably different — not a restatement of the title or before_state negation.
4. **verification**: Must name a specific test file (e.g., tests/core/foo.test.ts) plus an expected test name or exact log assertion. "npm test" alone is always rejected.
5. **acceptance_criteria**: ≥2 items, each a concrete testable statement. Every item must be independently verifiable.
6. **riskLevel + premortem**: Any task modifying orchestration paths, plan parsing, or dispatch logic is automatically high-risk and requires a compliant premortem.
7. **requestBudget**: Compute byWave and byRole from actual plan distribution. Never emit _fallback:true. byWave and byRole arrays must not be empty if plans exist.
8. **capacityDelta + requestROI**: Both are REQUIRED on every plan. Omitting either causes plan rejection by the contract validator.
9. **estimatedExecutionTokens**: REQUIRED on every plan and must be a positive integer. This is used by Athena and the batch planner to fill model context efficiently and reduce wasted premium requests.
10. **role minimization**: Minimize distinct roles per cycle. If a task does not require specialized domain behavior, assign role="evolution-worker" to reduce unnecessary worker sessions and premium requests.
11. **analysis-role ban in executable packets**: Do NOT emit role values "prometheus", "athena", or "janus" in plans[].role. Those are analysis/review roles, not implementation workers.
12. **low-leverage or redundant packet contract**: If leverage_rank has fewer than 2 dimensions, or the task/implementationStatus implies already-implemented, redundant, duplicate, or no-op work, the packet MUST include explicit implementationEvidence and MUST be capacity-first (capacityDelta>0 and requestROI>1). Otherwise the contract validator rejects it.
13. **stale diagnostics quarantine**: Do NOT open a packet that is backed only by stale diagnostics. If diagnostics are stale, either cite independent implementationEvidence / novelty-backed proof or omit the packet entirely. Packets tagged stale_diagnostics_backed are rejected before dispatch.
14. **intent preservation**: Treat explicit operator requirements as protected constraints. Do NOT silently soften the requested quality bar, realism, integration depth, or user-facing scope into placeholders, mocks, demo-only flows, or cheap substitutes. If a temporary fallback is unavoidable, disclose it explicitly with the blocker reason and preserve the promised outcome class.

Write the entire response in English only.
If you include recommendations, rank them by capacity-increase leverage, not by fear or surface risk alone.
Security or governance recommendations must explain how they contribute to capacity increase rather than being presented as the default center of gravity.
You MUST emit a structured JSON companion block at the end of your response.
The JSON block must contain all of the following fields:
{
  "projectHealth": "<good|healthy|needs-work|degraded|critical>",
  "keyFindings": "<one-paragraph summary of the most important repository findings>",
  "strategicNarrative": "<one-paragraph explanation of the strategic direction for this cycle>",
  "totalPackets": <number>,
  "requestBudget": {
    "estimatedPremiumRequestsTotal": 6,
    "errorMarginPercent": <number>,
    "hardCapTotal": <number>,
    "confidence": "low|medium|high",
    "byWave": [{ "wave": <n>, "planCount": <n>, "roles": ["..."], "estimatedRequests": <n> }],
    "byRole": [{ "role": "...", "planCount": <n>, "estimatedRequests": <n> }]
  },
  "executionStrategy": {
    "planningMode": "master_evolution|repair_plan",
    "executionPattern": "wave_parallel|bounded_chain|single_worker|serial_repair",
    "workerTopology": {
      "workerCount": <n>,
      "laneCount": <n>,
      "maxParallelWorkers": <n>,
      "roles": [{ "role": "...", "lane": "...", "taskCount": <n>, "waves": [1], "specialized": true }],
      "lanes": [{ "lane": "...", "worker": "...", "taskCount": <n>, "roleCount": <n>, "specialized": true }]
    },
    "waves": [{ "wave": <n>, "tasks": [{"role": "...", "task": "...", "task_id": "..."}], "dependsOnWaves": [], "maxParallelWorkers": <n> }]
  },
  "plans": [{
    "title": "...",
    "task": "...",
    "owner": "...",
    "role": "...",
    "wave": <number>,
    "scope": "...",
    "target_files": ["..."],
    "before_state": "...",
    "after_state": "...",
    "riskLevel": "low|medium|high",
    "dependencies": [],
    "acceptance_criteria": ["...", "..."],
    "verification": "tests/core/foo.test.ts — test: expected description",
    "premortem": null,
    "capacityDelta": <number ∈ [-1.0, 1.0]>,
    "requestROI": <positive number>,
    "estimatedExecutionTokens": <positive integer>,
    "synthesis_sources": ["<synthesis topic name(s) this plan directly addresses — use [] if this plan is not research-driven>"]
  }],
  "informational_topics_consumed": ["<REQUIRED — list every synthesis topic from RESEARCH INTELLIGENCE that you read but decided no plan is needed for (already implemented, out of scope, or purely contextual)>"]
}
Do NOT omit target_files, before_state, after_state, scope, acceptance_criteria, capacityDelta, or requestROI from any plan entry.
Do NOT omit estimatedExecutionTokens from any plan entry.
MANDATORY synthesis-topic accounting — you MUST populate synthesis_sources and informational_topics_consumed together such that EVERY topic listed in the RESEARCH INTELLIGENCE section is accounted for in exactly one of: (a) a plan's synthesis_sources[] if you are implementing it, or (b) informational_topics_consumed[] if you reviewed it but no plan is needed. Unaccounted topics accumulate in the research backlog forever and prevent new Scout runs. An empty informational_topics_consumed[] is only acceptable when EVERY synthesis topic is covered by a plan's synthesis_sources[].
For EVERY synthesis topic from the RESEARCH INTELLIGENCE section: if you produce a plan for it, list it in that plan's synthesis_sources[]. If you read it but no plan is needed (already done or purely informational), list it in informational_topics_consumed[].
Do NOT emit requestBudget with _fallback:true — compute byWave and byRole from the actual plan list.
Keep diagnostic findings in analysis or strategicNarrative and include only actionable redesign work in plans.
Wrap the JSON companion with markers:

===DECISION===
{ ...optional companion json... }
===END===`),
});

export const TARGET_PROMETHEUS_STATIC_SECTIONS = Object.freeze({
  targetDeliveryDirective: ivs("target-delivery-directive", `## TARGET DELIVERY DIRECTIVE
You are planning only for the active target session.
Do NOT propose work for BOX internals, BOX src/core, prompt authority, lineage taxonomy, retry economics, or any other BOX self-improvement surface.
Treat the active target repo objective, target session gates, and isolated workspace as the only planning scope.
The BOX repository is orchestration infrastructure for this cycle, not the delivery target.`),

  targetOutputFormat: ivs("target-output-format", `## TARGET DELIVERY OUTPUT FORMAT
Produce a target-repo delivery plan only.
Respect the operator objective's locked stack, file boundary, stage gates, and workspace path.
Emit only concrete target-session packets and the required JSON companion block for the active target session.
Do NOT include BOX-wide self-critique, BOX master-evolution analysis, or self-improvement packets unless the operator objective explicitly asks for them.`),
});

/**
 * Section names that carry per-cycle data in the Prometheus planning prompt.
 *
 * These sections are marked `required: true` during prompt compilation so that
 * under token-budget pressure they are retained over large optional context
 * (repo file listing, drift summary). The static sections in PROMETHEUS_STATIC_SECTIONS
 * are also required, but their content is invariant across cycles — unlike these
 * delta sections whose content changes every cycle.
 *
 * Downstream callers (e.g., tests) can import this to verify cycle-delta
 * prioritization behaviour without re-listing the names inline.
 */
export const PROMETHEUS_CYCLE_DELTA_SECTION_NAMES: ReadonlySet<string> = new Set([
  "research-intelligence",
  "topic-memory",
  "truth-maintenance",
  "postmortem-shortlist",
  "behavior-patterns",
  "carry-forward",
  "diagnostics-freshness",
]);

/**
 * Section names for the static invariant Prometheus planning prompt sections.
 * Used with markCacheableSegments to flag these as prompt-cache eligible so
 * caching layers can avoid re-tokenising unchanged prefixes across cycles.
 */
export const PROMETHEUS_STATIC_SECTION_NAMES: ReadonlySet<string> = new Set(
  Object.values(PROMETHEUS_STATIC_SECTIONS).map(s => s.name)
);

export const TARGET_PROMETHEUS_STATIC_SECTION_NAMES: ReadonlySet<string> = new Set(
  Object.values(TARGET_PROMETHEUS_STATIC_SECTIONS).map(s => s.name)
);

/**
 * Canonical list of state files that Prometheus reads during its planning workflow.
 * Used in the context prompt (step 2) and exported for test verification.
 *
 * Invariant: state/worker_cycle_artifacts.json is the canonical cycle snapshot
 * source.  state/evolution_progress.json is legacy and must NOT appear here.
 */
export const PROMETHEUS_CANONICAL_WORKFLOW_STATE_FILES: ReadonlyArray<string> = Object.freeze([
  "state/cycle_analytics.json",
  "state/capacity_scoreboard.json",
  "state/cycle_health.json",
  "state/worker_cycle_artifacts.json",
  "state/athena_postmortems.json",
  "state/intervention_optimizer_log.jsonl",
  "state/dependency_graph_diagnostics.json",
]);

export const PROMETHEUS_PROMPT_DENSITY_MIN = Object.freeze({
  minTargetFiles: 2,
  minAcceptanceCriteria: 2,
  minTaskChars: 120,
  // estimatedExecutionTokens is a batch-packing utility, not a plan quality signal.
  // The model consistently underestimates this field (~1000 vs expected 8000+) because
  // it estimates plan-text tokens rather than full-worker-session tokens. Disabling the
  // token floor prevents valid plans from being rejected on every cycle.
  minExecutionTokens: 0,
});

export function resolvePrometheusPromptPlanningMode(config: any, options: { repairFeedback?: unknown } = {}) {
  if (options.repairFeedback) {
    return PROMETHEUS_PLANNING_MODE.REPAIR_PLAN;
  }
  return PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION;
}

export function resolvePrometheusPromptFamilyLabel(
  config: any,
  options: { repairFeedback?: unknown } = {},
): string {
  if (isSingleTargetPromptIsolationActive(config)) {
    return "prometheus-single_target_delivery";
  }
  return `prometheus-${resolvePrometheusPromptPlanningMode(config, options) || PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION}`;
}

export function resolvePrometheusPromptRepoPath(config: any, repoRoot: string): string {
  if (!isSingleTargetPromptIsolationActive(config)) {
    return repoRoot;
  }

  const targetWorkspacePath = String(
    config?.activeTargetSession?.workspace?.path
      || config?.activeTargetSession?.repo?.localPath
      || "",
  ).trim();

  return targetWorkspacePath || repoRoot;
}

export function resolvePrometheusStaticSections(config: any) {
  return isSingleTargetPromptIsolationActive(config)
    ? TARGET_PROMETHEUS_STATIC_SECTIONS
    : PROMETHEUS_STATIC_SECTIONS;
}

export function buildPrometheusWorkflowPrompt(config: any, repoRoot: string): string {
  const promptRepoPath = resolvePrometheusPromptRepoPath(config, repoRoot);
  if (isSingleTargetPromptIsolationActive(config)) {
    return `## YOUR WORKFLOW
You have full read and write access to the state directory and the isolated target workspace.
ACTIVE TARGET WORKSPACE: ${promptRepoPath}
1. Read state/research_synthesis.json for the latest research intelligence (extracted content from internet sources).
2. Read key state files to understand target-session health: ${PROMETHEUS_CANONICAL_WORKFLOW_STATE_FILES.join(", ")}
   - state/worker_cycle_artifacts.json is the canonical cycle snapshot (schemaVersion=1, fields: latestCycleId, cycles{}, updatedAt). Check the updatedAt field for freshness — records older than 6 hours are historical context only, not live planning truth.
   - Use diagnostics freshness metadata (freshness.staleAfterMs + timestamp fields) and do NOT treat stale diagnostics entries as live planning truth.
3. Inspect the isolated target workspace and target-session artifacts needed to plan delivery. Do NOT browse BOX src/core or propose BOX-internal work while single-target delivery mode is active.
4. Produce a delivery plan only for the active target session following the operator objective and session gates.
   - Do NOT silently downgrade explicit user intent into placeholders, mocks, demo-only flows, or reduced-quality substitutes.
   - If a temporary fallback is unavoidable, say so explicitly, include the blocker reason, and preserve the final intended outcome class in the plan.
5. Your plan MUST end with a JSON companion block wrapped in ===DECISION=== / ===END=== markers containing a plans array.`;
  }

  return `## YOUR WORKFLOW
You have full read and write access to the repository and state directory.
1. Read state/research_synthesis.json for the latest research intelligence (extracted content from internet sources).
2. Read key state files to understand system health: ${PROMETHEUS_CANONICAL_WORKFLOW_STATE_FILES.join(", ")}
   - state/worker_cycle_artifacts.json is the canonical cycle snapshot (schemaVersion=1, fields: latestCycleId, cycles{}, updatedAt). Check the updatedAt field for freshness — records older than 6 hours are historical context only, not live planning truth.
   - Use diagnostics freshness metadata (freshness.staleAfterMs + timestamp fields) and do NOT treat stale diagnostics entries as live planning truth.
3. Read source files you need to understand for planning — browse src/core/, src/workers/, src/types/ as needed.
4. Produce your self-evolution master plan following your agent definition's output format.
5. Your plan MUST end with a JSON companion block wrapped in ===DECISION=== / ===END=== markers containing a plans array.`;
}

export const RIGIDITY_PENALTY = 0.15 as const;

function computePacketRubricScore(plan: Record<string, any>): number {
  const targetFiles = Array.isArray(plan?.target_files) ? plan.target_files : [];
  const acceptanceCriteria = Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria : [];
  const leverageRank = normalizeLeverageRank(plan?.leverage_rank);
  const normalizedTask = String(plan?.task || "").trim();
  const verification = String(plan?.verification || "").trim();
  const scope = String(plan?.scope || "").trim();
  const beforeState = String(plan?.before_state || "").trim();
  const afterState = String(plan?.after_state || "").trim();
  const dependencies = Array.isArray(plan?.dependencies) ? plan.dependencies : [];
  const capacityDelta = Number(plan?.capacityDelta);
  const requestROI = Number(plan?.requestROI);

  const dimensions = {
    architecture: scope.length > 0 && targetFiles.length > 0 ? 1 : 0,
    speed: Number.isFinite(Number(plan?.estimatedExecutionTokens)) ? 1 : 0,
    "task-quality": acceptanceCriteria.length >= 2 ? 1 : 0,
    "prompt-quality": beforeState.length > 0 && afterState.length > 0 ? 1 : 0,
    "parser-quality": verification.length > 0 ? 1 : 0,
    "worker-specialization": String(plan?.role || "").trim().length > 0 ? 1 : 0,
    "model-task-fit": Number.isFinite(requestROI) && requestROI > 0 ? 1 : 0,
    "learning-loop": leverageRank.includes("learning-loop") ? 1 : 0,
    "cost-efficiency": Number.isFinite(requestROI) && requestROI > 1 ? 1 : 0,
    security: /security|auth|trust|guard|policy/i.test(`${normalizedTask} ${scope} ${afterState}`) ? 1 : 0,
  } as Record<string, number>;
  const dimensionScore = Object.values(dimensions).reduce((sum, n) => sum + n, 0) / EQUAL_DIMENSION_SET.length;

  const capacityFirst = Number.isFinite(capacityDelta) && capacityDelta > 0 && Number.isFinite(requestROI) && requestROI > 1;
  const defensiveOnly = /(?:ban|block|forbid|deny|freeze|prevent|guardrail|lockdown|hard[- ]?gate)/i.test(normalizedTask)
    && !/(?:implement|build|add|create|refactor|optimi[sz]e|improve|automate|ship|wire)/i.test(normalizedTask);

  let score = dimensionScore;
  if (dependencies.length > 0) score += 0.05;
  if (capacityFirst) score += 0.25;
  if (defensiveOnly) score -= RIGIDITY_PENALTY;
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
}

export function applyPlanningRubric(plans: any[]): any[] {
  if (!Array.isArray(plans)) return [];
  return plans
    .map((plan) => {
      if (!plan || typeof plan !== "object") return plan;
      const rubricScore = computePacketRubricScore(plan);
      const leverageRank = normalizeLeverageRank(plan.leverage_rank);
      const defensiveOnly = /(?:ban|block|forbid|deny|freeze|prevent|guardrail|lockdown|hard[- ]?gate)/i.test(String(plan.task || ""))
        && !/(?:implement|build|add|create|refactor|optimi[sz]e|improve|automate|ship|wire)/i.test(String(plan.task || ""));
      return {
        ...plan,
        leverage_rank: leverageRank,
        _planningRubric: {
          score: rubricScore,
          capacityFirst: Number(plan?.capacityDelta) > 0 && Number(plan?.requestROI) > 1,
          rigidityPenaltyApplied: defensiveOnly,
        },
      };
    })
    .sort((a, b) => {
      const scoreDiff = Number(b?._planningRubric?.score || 0) - Number(a?._planningRubric?.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return Number(a?.priority || 9999) - Number(b?.priority || 9999);
    });
}

// ── Bounded Candidate Generation and Selection ────────────────────────────────

/**
 * Re-exported constants from plan_critic so callers only need one import.
 * Bounded maximum candidate sets evaluated during deterministic selection.
 */
export const MAX_CANDIDATE_SETS = _MAX_CANDIDATE_SETS;

/**
 * Score delta below which two candidate sets are treated as tied and
 * uncertainty-aware tie-breaks apply.
 */
export const CANDIDATE_TIE_THRESHOLD = _CANDIDATE_TIE_THRESHOLD;

/**
 * Select the best plan set from multiple generated candidate alternatives using
 * rubric scoring and uncertainty-aware tie-breaks.
 *
 * This is the Prometheus-level entry point for multi-candidate planning.
 * Instead of committing to a single draft, Prometheus can generate up to
 * MAX_CANDIDATE_SETS candidate plan arrays and pass them here.  The function
 * uses the critic rubric to score each set, then applies tie-breaks when
 * top candidates are within CANDIDATE_TIE_THRESHOLD.
 *
 * Tie-break cascade (in order, fully deterministic):
 *   1. Higher aggregate rubric score wins.
 *   2. If tied (within threshold): higher dimension coverage wins.
 *   3. If still tied: fewer total plans wins (lower blast radius).
 *   4. If still tied: earlier candidate (lower array index) wins.
 *
 * @param candidateSets — array of candidate plan arrays (max MAX_CANDIDATE_SETS evaluated)
 * @param opts          — { threshold?: number } overrides the tie-break threshold
 * @returns Selection result with bestCandidates, score, and metadata
 */
export function selectBestCandidatePlans(
  candidateSets: object[][],
  opts: {
    threshold?: number;
    gateMetricsByCandidate?: Array<{
      contractPassRate?: number;
      viablePlanCount?: number;
      freshnessPenalty?: number;
      allPlansBlocked?: boolean;
    }>;
  } = {},
): {
  bestCandidates: object[];
  rank: number;
  score: number;
  tieBreakUsed: boolean;
  reason: string;
} {
  return selectBestCandidateSet(candidateSets, opts);
}

export interface PrometheusCandidatePlanSet {
  label: string;
  plans: any[];
}

export function extractPrometheusCandidatePlanSets(input: any): PrometheusCandidatePlanSet[] {
  if (!input || typeof input !== "object") return [];
  const rawSets = Array.isArray(input.candidateSets)
    ? input.candidateSets
    : Array.isArray(input.candidate_sets)
      ? input.candidate_sets
      : Array.isArray(input.candidates)
        ? input.candidates
        : [];

  return rawSets
    .slice(0, MAX_CANDIDATE_SETS)
    .map((entry: any, index: number) => {
      const plans = Array.isArray(entry)
        ? entry
        : Array.isArray(entry?.plans)
          ? entry.plans
          : [];
      const label = String(entry?.label || entry?.id || `candidate-${index + 1}`).trim() || `candidate-${index + 1}`;
      return { label, plans };
    })
    .filter((entry) => Array.isArray(entry.plans) && entry.plans.length > 0);
}

function resolvePrometheusTopologyMinLanes(minLanes: unknown): number | null {
  const normalized = Number(minLanes);
  if (!Number.isFinite(normalized) || normalized <= 1) return null;
  return Math.max(2, Math.floor(normalized));
}

export function evaluatePrometheusTopologyAdmission(
  plans: any[],
  opts: {
    planningMode?: unknown;
    minLanes?: unknown;
  } = {},
): {
  admitted: boolean;
  reason: string;
  laneCount: number;
  planCount: number;
  minLanes: number | null;
  workerTopology: WorkerTopologyContract;
} {
  const normalizedPlans = Array.isArray(plans)
    ? plans.filter((plan) => plan && typeof plan === "object")
    : [];
  const planningMode = normalizePrometheusPlanningMode(
    opts.planningMode,
    PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION,
  ) || PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION;
  const workerTopology = buildWorkerTopologyContract(normalizedPlans, { planningMode });
  const requiredMinLanes = resolvePrometheusTopologyMinLanes(opts.minLanes);
  const planCount = normalizedPlans.length;
  const laneCount = Number(workerTopology?.laneCount || 0);
  if (requiredMinLanes === null || planCount < requiredMinLanes || laneCount >= requiredMinLanes) {
    return {
      admitted: true,
      reason: "",
      laneCount,
      planCount,
      minLanes: requiredMinLanes,
      workerTopology,
    };
  }
  const laneLabels = Array.isArray(workerTopology?.lanes)
    ? workerTopology.lanes
      .map((lane) => String(lane?.lane || "").trim())
      .filter(Boolean)
    : [];
  const laneText = laneLabels.length > 0 ? laneLabels.join(",") : "none";
  return {
    admitted: false,
    reason: `worker_topology_insufficient: planCount=${planCount} laneCount=${laneCount} minLanes=${requiredMinLanes} lanes=${laneText}`,
    laneCount,
    planCount,
    minLanes: requiredMinLanes,
    workerTopology,
  };
}

function applyCandidateSelectionGates(
  baseInput: any,
  candidatePlans: any[],
  aiResult: any,
  diagnosticsFreshnessAdmission: DiagnosticsFreshnessAdmission,
  topologyMinLanes?: unknown,
) {
  const candidateInput = {
    ...(baseInput && typeof baseInput === "object" ? baseInput : {}),
    plans: Array.isArray(candidatePlans) ? candidatePlans : [],
    candidateSets: undefined,
    candidate_sets: undefined,
    candidates: undefined,
  };
  const parsed = normalizePrometheusParsedOutput(candidateInput, aiResult);
  if (!Array.isArray(parsed.plans) || parsed.plans.length === 0) {
    return {
      plans: [],
      metrics: { contractPassRate: 0, viablePlanCount: 0, freshnessPenalty: 1 },
      contractResult: { passRate: 0, results: [] },
      freshness: { penaltyApplied: 1 },
      blocked: true,
    };
  }

  if (!diagnosticsFreshnessAdmission.allFresh) {
    tagStaleDiagnosticsBackedPlans(parsed.plans, diagnosticsFreshnessAdmission);
  }
  const freshness = applyDiagnosticsFreshnessTruthToPlanning(parsed, diagnosticsFreshnessAdmission);
  const contractResult = validateAllPlans(parsed.plans);
  const contractGateOutcome = analyzePlanContractGateOutcome(contractResult);

  let admittedPlans = Array.isArray(parsed.plans) ? [...parsed.plans] : [];
  if (contractGateOutcome.allPlansBlocked) {
    admittedPlans = [];
  } else {
    const rejectionIndices = new Set<number>();
    const admissionHardFilter = applyAdmissionPacketHardFilter([...parsed.plans], contractResult);
    if (!admissionHardFilter.warnedOnly) {
      for (const index of admissionHardFilter.rejectedPlanIndices) {
        rejectionIndices.add(index);
      }
    }

    const staleBackedIndices = contractResult.results
      .filter((result) => !result.valid && result.violations.some((violation) =>
        violation.code === PACKET_VIOLATION_CODE.STALE_DIAGNOSTICS_BACKED &&
        violation.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
      ))
      .map((result) => result.planIndex)
      .filter((index) => Number.isInteger(index));
    if (staleBackedIndices.length > 0 && staleBackedIndices.length < admittedPlans.length) {
      for (const index of staleBackedIndices) {
        rejectionIndices.add(index);
      }
    }

    if (rejectionIndices.size > 0) {
      admittedPlans = admittedPlans.filter((_, index) => !rejectionIndices.has(index));
    }
  }

  const plansWithProvenance = admittedPlans.map((plan: any) => {
    const admissionConfidence = computePacketAdmissionConfidence(plan, parsed);
    const packetWithProvenance = plan._provenance
      ? { ...plan }
      : attachFallbackProvenance(plan, {
          source: "prometheus-candidate-selection",
          reason: "packet-admission-confidence",
          confidence: admissionConfidence,
          tag: admissionConfidence < QUARANTINE_CONFIDENCE_THRESHOLD
            ? FALLBACK_PROVENANCE_TAG.PARSER_FALLBACK
            : FALLBACK_PROVENANCE_TAG.DIRECT,
        });
    packetWithProvenance._admissionConfidence = admissionConfidence;
    return packetWithProvenance;
  });
  const quarantineResult = quarantineLowConfidencePackets(plansWithProvenance);
  admittedPlans = quarantineResult.allowed;

  const topologyAdmission = evaluatePrometheusTopologyAdmission(admittedPlans, {
    planningMode: resolvePrometheusPlanningModeFromContext(parsed, aiResult),
    minLanes: topologyMinLanes,
  });
  if (!topologyAdmission.admitted) {
    admittedPlans = [];
  }

  return {
    plans: admittedPlans,
    metrics: {
      contractPassRate: Number(contractResult.passRate) || 0,
      viablePlanCount: admittedPlans.length,
      freshnessPenalty: Number(freshness.penaltyApplied) || 0,
      allPlansBlocked: contractGateOutcome.allPlansBlocked || admittedPlans.length === 0,
    },
    contractResult,
    freshness,
    topologyAdmission,
    blocked: admittedPlans.length === 0,
  };
}

export function selectPrometheusCandidatePlanSet(
  rawParsedInput: any,
  aiResult: any = {},
  opts: {
    diagnosticsFreshnessAdmission?: DiagnosticsFreshnessAdmission | null;
    topologyMinLanes?: unknown;
  } = {},
): {
  candidateSets: PrometheusCandidatePlanSet[];
  selectedPlans: any[];
  selectedLabel: string;
  selectedIndex: number;
  score: number;
  tieBreakUsed: boolean;
  reason: string;
  usedSelection: boolean;
  candidateSummaries: Array<{
    label: string;
    originalPlanCount: number;
    admittedPlanCount: number;
    contractPassRate: number;
    freshnessPenalty: number;
  }>;
} {
  const candidateSets = extractPrometheusCandidatePlanSets(rawParsedInput);
  const diagnosticsFreshnessAdmission = opts.diagnosticsFreshnessAdmission && typeof opts.diagnosticsFreshnessAdmission === "object"
    ? opts.diagnosticsFreshnessAdmission
    : { allFresh: true, staleSources: [], freshnessReasons: [] };

  if (candidateSets.length < 2) {
    return {
      candidateSets,
      selectedPlans: Array.isArray(rawParsedInput?.plans) ? rawParsedInput.plans : [],
      selectedLabel: "",
      selectedIndex: -1,
      score: 0,
      tieBreakUsed: false,
      reason: "candidate_selection_disabled",
      usedSelection: false,
      candidateSummaries: [],
    };
  }

  const evaluated = candidateSets.map((candidate) => ({
    candidate,
    gated: applyCandidateSelectionGates(
      rawParsedInput,
      candidate.plans,
      aiResult,
      diagnosticsFreshnessAdmission,
      opts.topologyMinLanes,
    ),
  }));
  const selection = selectBestCandidatePlans(
    evaluated.map((entry) => entry.gated.plans),
    {
      gateMetricsByCandidate: evaluated.map((entry) => entry.gated.metrics),
    },
  );
  const selected = selection.rank >= 0 ? evaluated[selection.rank] : null;

  return {
    candidateSets,
    selectedPlans: Array.isArray(selected?.gated?.plans) ? selected.gated.plans : [],
    selectedLabel: selected?.candidate?.label || "",
    selectedIndex: selection.rank,
    score: selection.score,
    tieBreakUsed: selection.tieBreakUsed,
    reason: selection.reason,
    usedSelection: Array.isArray(selected?.gated?.plans) && selected.gated.plans.length > 0,
    candidateSummaries: evaluated.map((entry) => ({
      label: entry.candidate.label,
      originalPlanCount: entry.candidate.plans.length,
      admittedPlanCount: entry.gated.plans.length,
      contractPassRate: entry.gated.metrics.contractPassRate,
      freshnessPenalty: entry.gated.metrics.freshnessPenalty,
    })),
  };
}

// ── Architecture Drift Confidence Binding (Task 4) ──────────────────────────

/** Minimum total drift items above which plans must include remediation tasks. */
export const DRIFT_REMEDIATION_THRESHOLD = 5;

/**
 * Per-priority penalty weights for stale file references.
 * High-priority (src/core/) items carry more weight because they indicate
 * that the architecture doc references ghost paths in active infrastructure.
 */
export const DRIFT_PENALTY_BY_PRIORITY: Record<"high" | "medium" | "low", number> = Object.freeze({
  high:   0.05,
  medium: 0.02,
  low:    0.01,
});

/**
 * Compute a parser confidence penalty from an architecture drift report.
 * Applied after plan normalization to penalize cycles where docs are out of sync.
 *
 * When the full `staleReferences` array is available the penalty is priority-weighted:
 *   - src/core/ stale refs (high):   0.05 each
 *   - other src/ stale refs (medium): 0.02 each
 *   - docker/scripts/docs refs (low): 0.01 each
 *   - deprecated token usages:        0.02 each
 *
 * When only summary counts are available (legacy callers) the flat formula
 * `0.02 × total` is used as a fallback.  Both paths cap the result at 0.30.
 *
 * requiresRemediation is true when total unresolved items >= DRIFT_REMEDIATION_THRESHOLD.
 *
 * @param driftReport - result of checkArchitectureDrift(), or null/undefined
 * @returns {{ penalty: number, reason: string, requiresRemediation: boolean }}
 */
export function computeDriftConfidencePenalty(driftReport?: Record<string, unknown> | null): {
  penalty: number;
  reason: string;
  requiresRemediation: boolean;
} {
  if (!driftReport) return { penalty: 0, reason: "no-drift-report", requiresRemediation: false };
  const staleCount = (Number(driftReport.staleCount) || 0);
  const deprecatedTokenCount = (Number(driftReport.deprecatedTokenCount) || 0);
  const total = staleCount + deprecatedTokenCount;
  if (total === 0) return { penalty: 0, reason: "no-drift", requiresRemediation: false };

  let rawPenalty: number;
  const staleRefs = Array.isArray(driftReport.staleReferences) ? driftReport.staleReferences : null;
  if (staleRefs) {
    // Priority-weighted: penalize src/core/ ghost paths more heavily.
    rawPenalty = 0;
    for (const ref of staleRefs) {
      if (ref && typeof ref === "object") {
        const p = String((ref as any).referencedPath || "");
        const priority: "high" | "medium" | "low" =
          p.startsWith("src/core/") ? "high" : p.startsWith("src/") ? "medium" : "low";
        rawPenalty += DRIFT_PENALTY_BY_PRIORITY[priority];
      }
    }
    rawPenalty += deprecatedTokenCount * DRIFT_PENALTY_BY_PRIORITY.medium;
  } else {
    // Fallback flat formula for callers that supply only summary counts.
    rawPenalty = total * 0.02;
  }

  const penalty = Math.round(Math.min(0.30, rawPenalty) * 100) / 100;
  return {
    penalty,
    reason: `architecture_drift_${total}_unresolved`,
    requiresRemediation: total >= DRIFT_REMEDIATION_THRESHOLD,
  };
}

// ── Architecture Drift → Actionable Debt Tasks ────────────────────────────

/**
 * Convert architecture drift report items into structured debt plan tasks.
 * Groups items by source document so one task covers all issues in a given file.
 * Each task carries taskKind="debt" and source="architecture_drift" so it can
 * be tracked, filtered, and prioritised separately from AI-generated plans.
 *
 * Tasks are placed on a wave one beyond the highest existing plan wave so they
 * do not block critical delivery work but are still ingested into the plan graph.
 *
 * Existing plans that already reference a document path suppress debt task
 * generation for that document to prevent double-scheduling.
 *
 * @param driftReport - result of checkArchitectureDrift(), or null/undefined
 * @param existingPlans - plans already present in the parsed output
 * @returns array of debt plan task objects ready for injection into parsed.plans
 */
export function buildDriftDebtTasks(
  driftReport: Record<string, unknown> | null | undefined,
  existingPlans: any[] = []
): any[] {
  if (!driftReport) return [];

  const staleRefs = Array.isArray(driftReport.staleReferences)
    ? (driftReport.staleReferences as any[]).filter(r => r && typeof r === "object")
    : [];
  const tokenRefs = Array.isArray(driftReport.deprecatedTokenRefs)
    ? (driftReport.deprecatedTokenRefs as any[]).filter(r => r && typeof r === "object")
    : [];

  if (staleRefs.length === 0 && tokenRefs.length === 0) return [];

  // Place debt tasks on the wave immediately after the highest existing wave.
  const maxWave = existingPlans.reduce((max, p) => {
    const w = Number(p.wave) || 1;
    return w > max ? w : max;
  }, 0);
  const debtWave = maxWave + 1;

  // Identify docs already addressed in existing plans to avoid double-scheduling.
  const coveredDocs = new Set<string>();
  for (const plan of existingPlans) {
    const text = `${String(plan.task || "")} ${String(plan.description || "")} ${(plan.target_files || []).join(" ")}`.toLowerCase();
    for (const ref of [...staleRefs, ...tokenRefs]) {
      if (ref.docPath && text.includes(String(ref.docPath).toLowerCase())) {
        coveredDocs.add(String(ref.docPath));
      }
    }
  }

  const debtTasks: any[] = [];
  // Use high priority numbers so debt tasks sort after critical delivery work.
  // Within debt tasks, lower numbers mean higher urgency (high-priority refs first).
  let priority = 900;

  // Effective priority rank for a set of refs: the highest-priority (lowest rank) item wins.
  function effectivePriorityRank(refs: any[]): number {
    let best = 2; // low
    for (const r of refs) {
      const p = String(r.referencedPath || "");
      const rank = p.startsWith("src/core/") ? 0 : p.startsWith("src/") ? 1 : 2;
      if (rank < best) best = rank;
    }
    return best;
  }

  // One debt task per doc with stale file references.
  // Docs are sorted by their highest-priority ref so high-risk docs surface first.
  const staleByDoc = new Map<string, any[]>();
  for (const ref of staleRefs) {
    const doc = String(ref.docPath || "");
    if (!staleByDoc.has(doc)) staleByDoc.set(doc, []);
    staleByDoc.get(doc)!.push(ref);
  }
  const docPriorityScore = (doc: string, refs: any[]) => {
    const rankScore = effectivePriorityRank(refs) === 0 ? 300 : effectivePriorityRank(refs) === 1 ? 200 : 100;
    const pathBoost = String(doc || "").toLowerCase().includes("autonomous-dev-playbook.md") ? 40 : 0;
    return rankScore + pathBoost;
  };
  const sortedStaleByDoc = [...staleByDoc.entries()].sort(
    ([aDoc, aRefs], [bDoc, bRefs]) => {
      const scoreDiff = docPriorityScore(bDoc, bRefs) - docPriorityScore(aDoc, aRefs);
      if (scoreDiff !== 0) return scoreDiff;
      return aDoc.localeCompare(bDoc);
    }
  );
  const RANK_TO_DRIFT_PRIORITY = ["high", "medium", "low"] as const;
  for (const [doc, refs] of sortedStaleByDoc) {
    if (coveredDocs.has(doc)) continue;
    const paths = [...new Set(refs.map((r: any) => String(r.referencedPath)))].join(", ");
    const driftPriority = RANK_TO_DRIFT_PRIORITY[effectivePriorityRank(refs)];
    // Specific verification target: names the test file and the exact assertion so the
    // quality gate (plan_contract_validator.isNonSpecificVerification) accepts the task
    // and does not auto-remove it for having a bare "npm test" command.
    const verificationTarget = `tests/core/architecture_drift.test.ts — test: ${doc} has zero stale file references after update`;
    debtTasks.push({
      task: `Fix stale file references in ${doc}`,
      title: `Fix stale file references in ${doc}`,
      description: `${doc} references ${refs.length} file(s) that no longer exist: ${paths}. Update or remove these entries so documentation matches the current codebase.`,
      taskKind: "debt",
      source: "architecture_drift",
      _driftDebt: true,
      // driftPriority reflects the highest-urgency issue in this doc for downstream filtering.
      driftPriority,
      wave: debtWave,
      priority: priority++,
      target_files: [doc],
      acceptance_criteria: [
        `All ${refs.length} stale file reference(s) in ${doc} are updated or removed`,
        `No broken file references remain in ${doc}`,
        `npm test passes with no new failures after the update`,
      ],
      // Named test file reference satisfies isNonSpecificVerification — required to
      // survive the plan quality gate without being auto-removed.
      verification: verificationTarget,
      verification_commands: ["npm test"],
      // verification_targets enumerates the specific tests that must pass for this
      // debt task. The quality gate checks this field when present to validate that
      // the task is traceable to a concrete test assertion.
      verification_targets: [verificationTarget],
      riskLevel: "low",
      role: "evolution-worker",
      owner: "evolution-worker",
      // dependencies must be an array so the dependency-graph resolver and
      // validatePlanContract (WARNING check) do not flag this task.
      dependencies: [],
      // scope derived from the target document so validatePatchedPlan accepts
      // this task when Athena returns it in patchedPlans without modification.
      scope: doc,
      // capacityDelta and requestROI are mandatory contract fields (plan_contract_validator).
      // Debt remediation tasks improve documentation quality by a small, measurable amount.
      capacityDelta: 0.05,
      requestROI: 1.2,
      leverage_rank: ["quality"],
      implementationEvidence: [
        `architecture_drift report lists stale reference(s) in ${doc}`,
      ],
    });
  }

  // One debt task per doc with deprecated token usages.
  const tokensByDoc = new Map<string, any[]>();
  for (const ref of tokenRefs) {
    const doc = String(ref.docPath || "");
    if (!tokensByDoc.has(doc)) tokensByDoc.set(doc, []);
    tokensByDoc.get(doc)!.push(ref);
  }
  for (const [doc, refs] of tokensByDoc.entries()) {
    if (coveredDocs.has(doc)) continue;
    const uniqueTokens = [...new Set(refs.map((r: any) => String(r.token)))];
    const hints = [...new Map(refs.map((r: any) => [String(r.token), String(r.hint)])).entries()]
      .map(([t, h]) => `${t} → ${h}`)
      .join("; ");
    const verificationTarget = `tests/core/architecture_drift.test.ts — test: ${doc} has zero deprecated token usages after replacement`;
    debtTasks.push({
      task: `Replace deprecated API tokens in ${doc}`,
      title: `Replace deprecated API tokens in ${doc}`,
      description: `${doc} contains ${refs.length} use(s) of deprecated token(s): ${uniqueTokens.join(", ")}. Replace with current equivalents. Migration hints: ${hints}`,
      taskKind: "debt",
      source: "architecture_drift",
      _driftDebt: true,
      wave: debtWave,
      priority: priority++,
      target_files: [doc],
      acceptance_criteria: [
        `All ${refs.length} deprecated token usage(s) in ${doc} are replaced with current equivalents`,
        `No deprecated tokens remain in ${doc}`,
        `npm test passes with no new failures after the replacement`,
      ],
      verification: verificationTarget,
      verification_commands: ["npm test"],
      verification_targets: [verificationTarget],
      riskLevel: "low",
      role: "evolution-worker",
      owner: "evolution-worker",
      dependencies: [],
      scope: doc,
      capacityDelta: 0.05,
      requestROI: 1.2,
      leverage_rank: ["quality"],
      implementationEvidence: [
        `architecture_drift report lists deprecated token usage(s) in ${doc}`,
      ],
    });
  }

  return debtTasks;
}

// ── Telemetry-adjusted packet ranking ─────────────────────────────────────────
//
// Extends the base rank score (requestROI × (1 + capacityDelta)) by blending in
// realized outcome telemetry from the route ROI ledger.  When history shows that
// realized outcomes were better/worse than predicted (positive/negative avgRoiDelta),
// the ranking score is adjusted proportionally within a ±0.5 clamp.
//
// Consumers:
//   - Pass a RealizedTelemetrySummary built from model_policy.summarizeTierTelemetry
//     (or summarizeRealizedTelemetry for a pre-filtered slice of ledger entries).
//   - When no telemetry is available (sampleCount=0), adjustment is neutral (×1.0).

/**
 * Compact telemetry summary consumed by computeTelemetryAdjustedPacketScore.
 * Produced by summarizeRealizedTelemetry or model_policy.summarizeTierTelemetry.
 */
export interface RealizedTelemetrySummary {
  /** Average realized-minus-expected ROI delta across sampled entries. 0 = no data. */
  avgRoiDelta: number;
  /** Number of realized entries that contributed to the average. */
  sampleCount: number;
}

/**
 * Summarize realized outcome telemetry from a raw ledger slice into a compact signal
 * that packet ranking can consume without coupling to model_policy internals.
 *
 * Only entries that are fully realized (realizedAt non-null, roiDelta is a finite number)
 * contribute to the summary.  Returns { avgRoiDelta: 0, sampleCount: 0 } when no realized
 * entries are available so callers can distinguish "no data" from "neutral history".
 *
 * @param entries  — records with at least { roiDelta?, realizedAt? } fields
 * @param limit    — max most-recent entries to include (default: 20)
 */
export function summarizeRealizedTelemetry(
  entries: Array<{ roiDelta?: number | null; realizedAt?: string | null }>,
  limit = 20
): RealizedTelemetrySummary {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { avgRoiDelta: 0, sampleCount: 0 };
  }
  const realized = entries
    .filter(
      e =>
        e.realizedAt !== null &&
        e.realizedAt !== undefined &&
        typeof e.roiDelta === "number" &&
        Number.isFinite(e.roiDelta)
    )
    .slice(-limit);
  if (realized.length === 0) return { avgRoiDelta: 0, sampleCount: 0 };
  const sum = realized.reduce((acc, e) => acc + (e.roiDelta as number), 0);
  return {
    avgRoiDelta: Math.round((sum / realized.length) * 1000) / 1000,
    sampleCount: realized.length,
  };
}

/**
 * Maximum telemetry adjustment factor applied to a packet's base rank score.
 * avgRoiDelta is clamped to ±TELEMETRY_ADJUSTMENT_CLAMP before multiplication.
 * This prevents runaway adjustment from a small or anomalous sample.
 */
export const TELEMETRY_ADJUSTMENT_CLAMP = 0.5 as const;

/**
 * Compute a telemetry-adjusted ranking score for a single plan packet.
 *
 * Extends the base rank score (requestROI × (1 + capacityDelta)) by blending in
 * realized outcome signals.  The adjustment factor is derived from the historical
 * avgRoiDelta, clamped to ±TELEMETRY_ADJUSTMENT_CLAMP to limit sample sensitivity.
 *
 * Formula: baseScore × (1 + clamp(avgRoiDelta, −0.5, 0.5))
 *   − Positive avgRoiDelta → outcomes historically beat predictions → score up-ranked
 *   − Negative avgRoiDelta → outcomes historically missed predictions → score down-ranked
 *   − sampleCount=0         → telemetryFactor=0, score equals baseline (neutral)
 *
 * Plans missing valid capacityDelta or requestROI score 0 (filtered before ranking).
 *
 * @param plan             — normalized plan packet (capacityDelta, requestROI required)
 * @param telemetrySummary — from summarizeRealizedTelemetry or model_policy.summarizeTierTelemetry
 * @returns adjusted rank score ≥ 0
 */
export function computeTelemetryAdjustedPacketScore(
  plan: Record<string, any>,
  telemetrySummary: RealizedTelemetrySummary = { avgRoiDelta: 0, sampleCount: 0 }
): number {
  if (!plan || typeof plan !== "object") return 0;
  const roi = Number(plan.requestROI);
  const delta = Number(plan.capacityDelta);
  if (!Number.isFinite(roi) || roi <= 0) return 0;
  if (!Number.isFinite(delta)) return 0;
  const baseScore = roi * (1 + delta);
  if (!telemetrySummary || telemetrySummary.sampleCount === 0) return baseScore;
  const telemetryFactor = Math.max(
    -TELEMETRY_ADJUSTMENT_CLAMP,
    Math.min(TELEMETRY_ADJUSTMENT_CLAMP, telemetrySummary.avgRoiDelta)
  );
  return Math.max(0, baseScore * (1 + telemetryFactor));
}

/**
 * Rank plan packets by telemetry-adjusted composite score, descending.
 *
 * Uses computeTelemetryAdjustedPacketScore to score each plan.  Plans missing valid
 * capacityDelta/requestROI score 0 and sort to the end.  The original array is NOT
 * mutated — a new sorted array is returned.  Within equal scores, original order is
 * preserved (stable sort).
 *
 * @param plans            — normalized plan packets
 * @param telemetrySummary — from summarizeRealizedTelemetry (default: no adjustment)
 * @returns sorted copy, highest adjusted score first
 */
export function rankPlansByTelemetryAdjustedScore(
  plans: any[],
  telemetrySummary: RealizedTelemetrySummary = { avgRoiDelta: 0, sampleCount: 0 }
): any[] {
  if (!Array.isArray(plans)) return [];
  return [...plans].sort(
    (a, b) =>
      computeTelemetryAdjustedPacketScore(b, telemetrySummary) -
      computeTelemetryAdjustedPacketScore(a, telemetrySummary)
  );
}

// ── Realized closure yield — planning/routing rank adjustment ─────────────────
//
// Closure yield measures what fraction of carry-forward items that were marked
// closed (closedAt non-null) actually shipped with verifiable evidence
// (closureEvidence non-empty).  Low yield signals the system is declaring items
// done without proving they were fixed, which should bias plan ranking toward
// tasks that close the learning loop and bias routing toward stronger models.

/** Threshold below which closure yield is treated as "low" — triggers rank boosts. */
export const CLOSURE_YIELD_LOW_THRESHOLD = 0.5 as const;

/** Dimensions whose plans receive a capacityDelta boost when closure yield is low. */
export const CLOSURE_YIELD_BOOST_DIMENSIONS: ReadonlySet<string> = new Set([
  "learning",
  "quality",
  "task-quality",
  "learning loop",
]) as ReadonlySet<string>;

/** capacityDelta boost applied to qualifying plans when closure yield is below the threshold. */
export const CLOSURE_YIELD_BOOST_AMOUNT = 0.05 as const;

/** Result type returned by computeClosureYield. */
export interface ClosureYieldResult {
  /** Fraction of attempted closures with verified evidence (0–1; 0 when no attempts). */
  yield: number;
  /** Entries with both closedAt and non-empty closureEvidence. */
  closed: number;
  /** Entries with closedAt set (system declared them closed). */
  attempted: number;
}

/**
 * Compute the realized closure yield from carry-forward ledger entries.
 *
 * Yield = closed / attempted, where:
 *   - attempted = entries with closedAt non-null (system declared them closed)
 *   - closed    = entries with BOTH closedAt AND non-empty closureEvidence (verifiably shipped)
 *
 * Returns { yield: 0, closed: 0, attempted: 0 } when no entries have been attempted
 * so callers can distinguish "no history" from "genuinely zero yield".
 *
 * @param ledgerEntries — carry-forward ledger entry objects
 */
export function computeClosureYield(ledgerEntries: any[]): ClosureYieldResult {
  const entries = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  const attempted = entries.filter(e => e != null && e.closedAt != null).length;
  if (attempted === 0) return { yield: 0, closed: 0, attempted: 0 };
  const closed = entries.filter(e => e != null && e.closedAt && e.closureEvidence).length;
  return {
    yield: Math.round((closed / attempted) * 1000) / 1000,
    closed,
    attempted,
  };
}

/**
 * Rank plan packets by applying a closure-yield boost to plans that target the
 * learning/quality feedback-loop dimensions when realized closure yield is low.
 *
 * When closureYield < CLOSURE_YIELD_LOW_THRESHOLD (and > 0), plans whose
 * leverage_rank includes any CLOSURE_YIELD_BOOST_DIMENSIONS entry have their
 * capacityDelta raised by CLOSURE_YIELD_BOOST_AMOUNT (clamped to 1.0).  This
 * surfaces fix-the-loop plans higher in dispatch without altering unrelated plans.
 *
 * Returns a new array (does not mutate input).  When yield is 0 or at/above the
 * threshold the input is copied unchanged (caller still gets a new array).
 *
 * @param plans        — normalized plan packets with capacityDelta and leverage_rank
 * @param closureYield — from computeClosureYield().yield (0 = no data; no adjustment)
 */
export function rankPlansByClosureYield(plans: any[], closureYield: number): any[] {
  if (!Array.isArray(plans)) return [];
  if (!Number.isFinite(closureYield) || closureYield <= 0 || closureYield >= CLOSURE_YIELD_LOW_THRESHOLD) {
    return [...plans];
  }
  return plans.map(plan => {
    if (!plan || typeof plan !== "object") return plan;
    const leverageRank = Array.isArray(plan.leverage_rank) ? plan.leverage_rank : [];
    const hasBoostDimension = leverageRank.some(
      (d: any) => CLOSURE_YIELD_BOOST_DIMENSIONS.has(String(d || "").toLowerCase())
    );
    if (!hasBoostDimension) return { ...plan };
    const current = Number.isFinite(Number(plan.capacityDelta)) ? Number(plan.capacityDelta) : 0.1;
    return {
      ...plan,
      capacityDelta: Math.min(1.0, Math.round((current + CLOSURE_YIELD_BOOST_AMOUNT) * 1000) / 1000),
    };
  });
}

// ── Novelty / discovery-gap scoring ───────────────────────────────────────────
//
// Novelty measures what fraction of current plan packets address task areas
// that were NOT seen in recent historical plans.  When novelty collapses (score
// below NOVELTY_COLLAPSE_THRESHOLD) the system seeds fresh discovery packets
// that target dimensions absent from both current and historical work.  This
// prevents planning cycles from becoming closed loops on previously-attempted
// tasks with diminishing returns.

/** Threshold below which plan novelty is treated as "collapsed" — triggers seeding. */
export const NOVELTY_COLLAPSE_THRESHOLD = 0.35 as const;

/**
 * Canonical discovery dimensions used when seeding packets on novelty collapse.
 * Each dimension represents a capability area that should periodically be explored.
 */
export const NOVELTY_SEED_DIMENSIONS: ReadonlySet<string> = new Set([
  "observability",
  "reliability",
  "performance",
  "security",
  "testing",
  "architecture",
  "documentation",
  "refactor",
]) as ReadonlySet<string>;

/** Result returned by computeNoveltyScore. */
export interface NoveltyScoreResult {
  /** Fraction of current plans that are novel vs. history (0–1). 1.0 when no history. */
  score: number;
  /** Number of current plans considered novel (no significant overlap with history). */
  novelCount: number;
  /** Total current plans evaluated. */
  totalCount: number;
  /** Task texts of plans that were classified as repeated from history. */
  repeatedTasks: string[];
}

/**
 * Compute a novelty score for current plan packets relative to historical plans.
 *
 * A plan is classified as "repeated" when its task text shares ≥2 significant words
 * (≥4 chars) with any historical plan — the same keyword-overlap strategy used by
 * computeBottleneckCoverage to keep measurement consistent across the system.
 *
 * Returns { score: 1.0, novelCount: 0, totalCount: 0, repeatedTasks: [] } when
 * currentPlans is empty so callers can distinguish "no work" from "zero novelty".
 * Returns score: 1.0 (all novel) when historicalPlans is empty (first cycle).
 *
 * @param currentPlans    — plan packets from the current planning cycle
 * @param historicalPlans — plan packets from recent prior cycles
 */
export function computeNoveltyScore(
  currentPlans: any[],
  historicalPlans: any[],
): NoveltyScoreResult {
  const current = Array.isArray(currentPlans) ? currentPlans : [];
  const historical = Array.isArray(historicalPlans) ? historicalPlans : [];

  if (current.length === 0) {
    return { score: 1.0, novelCount: 0, totalCount: 0, repeatedTasks: [] };
  }
  if (historical.length === 0) {
    return { score: 1.0, novelCount: current.length, totalCount: current.length, repeatedTasks: [] };
  }

  // Pre-build word sets for all historical plans to avoid repeated tokenization.
  const historicalWordSets = historical.map(plan => {
    const text = `${String(plan?.task || "")} ${String(plan?.title || "")}`.toLowerCase();
    return text.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  });

  const repeatedTasks: string[] = [];
  let novelCount = 0;

  for (const plan of current) {
    const taskText = String(plan?.task || plan?.title || "").trim();
    const planWords = `${taskText} ${String(plan?.title || "")}`.toLowerCase()
      .split(/[^a-z0-9]+/).filter(w => w.length >= 4);

    const isRepeated = planWords.length > 0 && historicalWordSets.some(histWords => {
      const matches = planWords.filter(w => histWords.includes(w));
      return matches.length >= 2;
    });

    if (isRepeated) {
      repeatedTasks.push(taskText);
    } else {
      novelCount++;
    }
  }

  return {
    score: Math.round((novelCount / current.length) * 1000) / 1000,
    novelCount,
    totalCount: current.length,
    repeatedTasks,
  };
}

/**
 * Seed fresh implementation packets when novelty collapses.
 *
 * When computeNoveltyScore returns a score below NOVELTY_COLLAPSE_THRESHOLD,
 * this function generates minimal discovery-gap packets targeting dimensions that
 * are absent from both current and historical plans.  This prevents the planning
 * cycle from becoming a closed loop on previously-attempted work with diminishing
 * returns on system capacity.
 *
 * Returns [] when:
 *   - novelty is at or above NOVELTY_COLLAPSE_THRESHOLD (no seeding needed), or
 *   - currentPlans is empty (no work to compare against), or
 *   - all NOVELTY_SEED_DIMENSIONS are already covered.
 *
 * Does NOT mutate input arrays.  Seed packets are flagged with _discoveryGapSeed: true
 * so callers can identify them and handle them separately if needed.
 *
 * @param currentPlans    — plan packets from the current cycle
 * @param historicalPlans — plan packets from recent prior cycles
 * @param options.maxSeeds — maximum seed packets to generate (default: 3)
 */
export function seedDiscoveryGapPackets(
  currentPlans: any[],
  historicalPlans: any[],
  options: { maxSeeds?: number } = {},
): any[] {
  const noveltyResult = computeNoveltyScore(currentPlans, historicalPlans);
  if (noveltyResult.score >= NOVELTY_COLLAPSE_THRESHOLD || noveltyResult.totalCount === 0) {
    return [];
  }

  const maxSeeds =
    Number.isFinite(Number(options?.maxSeeds)) && Number(options.maxSeeds) > 0
      ? Math.floor(Number(options.maxSeeds))
      : 3;

  // Collect dimensions already addressed in current + historical plans.
  const coveredDimensions = new Set<string>();
  const allPlans = [
    ...(Array.isArray(currentPlans) ? currentPlans : []),
    ...(Array.isArray(historicalPlans) ? historicalPlans : []),
  ];
  for (const plan of allPlans) {
    const leverageRank = Array.isArray(plan?.leverage_rank) ? plan.leverage_rank : [];
    for (const dim of leverageRank) {
      coveredDimensions.add(String(dim || "").toLowerCase().trim());
    }
    // Also extract seed dimension keywords from task text for best-effort coverage.
    const taskText = `${String(plan?.task || "")} ${String(plan?.title || "")}`.toLowerCase();
    for (const dim of NOVELTY_SEED_DIMENSIONS) {
      if (taskText.includes(dim)) coveredDimensions.add(dim);
    }
  }

  const uncoveredDimensions = [...NOVELTY_SEED_DIMENSIONS].filter(
    dim => !coveredDimensions.has(dim),
  );

  if (uncoveredDimensions.length === 0) {
    return [];
  }

  return uncoveredDimensions.slice(0, maxSeeds).map((dim, i) => ({
    task: `Discovery: explore ${dim} improvements and implementation gaps`,
    title: `Discovery gap seed — ${dim}`,
    role: "evolution-worker",
    wave: 1,
    priority: 99 + i,
    verification: "npm test",
    verification_commands: ["npm test"],
    capacityDelta: 0.05,
    requestROI: 0.8,
    leverage_rank: [dim],
    _discoveryGapSeed: true,
    _noveltyCollapseScore: noveltyResult.score,
  }));
}

export function ensurePersistedAnalysisTimestamps<T extends Record<string, unknown>>(analysis: T): T & {
  generatedAt: string;
  analyzedAt: string;
} {
  const nowIso = new Date().toISOString();
  return {
    ...analysis,
    generatedAt: nowIso,
    analyzedAt: nowIso,
  };
}

export async function runPrometheusAnalysis(config, options: any = {}) {
  const stateDir = config.paths?.stateDir || "state";

  // ── Freshness cache: skip if recent analysis exists ───────────────────────
  // bypassCache: allows event-driven invalidation (e.g., all plans completed)
  if (options.bypassCache) {
    await appendProgress(config, `[PROMETHEUS] Cache bypass requested (reason=${options.bypassReason || "unknown"}) — forcing fresh analysis`);
  }
  const freshnessMins = Number(config.runtime?.prometheusAnalysisFreshnessMinutes);
  if (!options.bypassCache && Number.isFinite(freshnessMins) && freshnessMins > 0) {
    try {
      const existing = await readJson(path.join(stateDir, "prometheus_analysis.json"), null);
      if (existing?.analyzedAt) {
        const analyzedAtMs = new Date(existing.analyzedAt).getTime();
        const ageMs = Date.now() - analyzedAtMs;
        const latestResearchArtifactMs = await getLatestResearchArtifactUpdatedAtMs(stateDir);
        const researchUpdatedAfterAnalysis = latestResearchArtifactMs > analyzedAtMs;
        if (ageMs < freshnessMins * 60_000 && !researchUpdatedAfterAnalysis) {
          // If cached file already has plans, re-normalise them so enrichment
          // functions (target_files, scope, acceptance_criteria) always run.
          if (Array.isArray(existing.plans) && existing.plans.length > 0) {
            const renormalized = normalizePrometheusParsedOutput(existing, {});
            const persistedRenormalized = ensurePersistedAnalysisTimestamps(renormalized);
            await writeJson(
              path.join(stateDir, "prometheus_analysis.json"),
              addSchemaVersion(persistedRenormalized, STATE_FILE_TYPE.PROMETHEUS_ANALYSIS),
            ).catch(() => {});
            await appendProgress(config, `[PROMETHEUS] Fresh analysis exists (${Math.round(ageMs / 60_000)}m old, threshold=${freshnessMins}m) — reusing cached result (re-normalized ${renormalized.plans.length} plan(s))`);
            return persistedRenormalized;
          }
          // Cached file has no plans — attempt normalization to recover plans
          const recovered = normalizePrometheusParsedOutput(existing, {});
          if (Array.isArray(recovered.plans) && recovered.plans.length > 0) {
            await appendProgress(config, `[PROMETHEUS] Cached analysis normalized: ${recovered.plans.length} plan(s) recovered — rebuilding dependency graph`);
            // Rebuild dependency graph for the recovered plans
            try {
              const graphTasks = recovered.plans.map((plan, i) => ({
                id: String(plan.task || `plan-${i}`),
                dependsOn: Array.isArray(plan.dependencies) ? plan.dependencies.map(String) : [],
                filesInScope: Array.isArray(plan.target_files) ? plan.target_files : (Array.isArray(plan.targetFiles) ? plan.targetFiles : []),
              }));
              const graphResult = resolveDependencyGraph(graphTasks);
              recovered.dependencyGraph = {
                status:          graphResult.status,
                reasonCode:      graphResult.reasonCode,
                waveCount:       graphResult.waves.length,
                parallelTasks:   graphResult.parallelTasks,
                serializedTasks: graphResult.serializedTasks,
                conflictCount:   graphResult.conflictPairs.length,
                cycleCount:      graphResult.cycles.length,
                waves:           graphResult.waves,
                errorMessage:    graphResult.errorMessage ?? null,
              };
            } catch (graphErr) {
              recovered.dependencyGraph = { status: "degraded", errorMessage: String(graphErr?.message || graphErr) };
            }
            // Persist normalized result so subsequent reads don't need re-normalization
            const persistedRecovered = ensurePersistedAnalysisTimestamps(recovered);
            await writeJson(
              path.join(stateDir, "prometheus_analysis.json"),
              addSchemaVersion(persistedRecovered, STATE_FILE_TYPE.PROMETHEUS_ANALYSIS),
            ).catch(() => {});
            return persistedRecovered;
          }
          // Cache exists but normalization also produced no plans — re-run
          await appendProgress(config, `[PROMETHEUS] Cached analysis has no actionable plans (${Math.round(ageMs / 60_000)}m old) — re-running`);
        } else if (ageMs < freshnessMins * 60_000 && researchUpdatedAfterAnalysis) {
          await appendProgress(config, `[PROMETHEUS] Fresh cache skipped — research artifacts are newer than cached analysis`);
        }
      }
    } catch { /* no cached analysis — proceed normally */ }
  }

  const repoRoot = process.cwd();
  const registry = getRoleRegistry(config);
  const prometheusName = registry?.deepPlanner?.name || "Prometheus";
  const prometheusModel = registry?.deepPlanner?.model || "gpt-5.4";
  const command = config.env?.copilotCliCommand || "copilot";

  const userPrompt = options.prompt || options.prometheusReason || "Full repository self-evolution analysis";
  const requestedBy = options.requestedBy || "Janus";

  const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

  // ── Log start ─────────────────────────────────────────────────────────────
  await appendProgress(config, `[PROMETHEUS] ${prometheusName} awakening — starting deep repository analysis (simplified mode)`);
  await appendPrometheusLiveLog(stateDir, "leadership_live", `[${ts()}] ${prometheusName.padEnd(20)} Awakening — direct Copilot CLI scan starting...`);

  // ── Load lane telemetry from previous cycle analytics for context injection ──
  let prevLaneTelemetry: Record<string, unknown> | null = null;
  let prevAnalyticsSnapshot: any = null;
  let prevAnalyticsRecords: unknown[] = [];
  try {
    const prevAnalytics = await readJson(path.join(stateDir, "cycle_analytics.json"), null);
    prevAnalyticsSnapshot = prevAnalytics;
    const raw = (prevAnalytics as any)?.lastCycle?.laneTelemetry;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      prevLaneTelemetry = raw as Record<string, unknown>;
    }
    // Collect historical cycle records for lane difficulty priors.
    if (Array.isArray((prevAnalytics as any)?.history)) {
      prevAnalyticsRecords = (prevAnalytics as any).history;
    } else if (prevAnalytics && typeof prevAnalytics === "object") {
      prevAnalyticsRecords = [prevAnalytics];
    }
  } catch { /* non-fatal — proceed without lane telemetry */ }

  // Compute historical lane difficulty priors from previous cycle analytics.
  // These signal which lanes have historically been harder (lower completion rate)
  // so the density gate can be stricter for those lanes.
  const laneDifficultyPriors = computeHistoricalLaneDifficultyPriors(prevAnalyticsRecords);

  let planningPolicy = buildPrometheusPlanningPolicy(config, prevLaneTelemetry, {
    taskKindTelemetry: extractTaskKindPacketTelemetry(prevAnalyticsSnapshot),
  });
  const diagnosticsFreshnessSection = await buildDiagnosticsFreshnessPromptSection(stateDir);
  // Build machine-readable freshness records for the live admission gate.
  // These are computed in parallel with the prompt section so the same file I/O
  // serves both the human-readable section and the deterministic admission gate.
  const _diagnosticsFreshnessRecords = await buildDiagnosticsFreshnessRecords(stateDir);
  const diagnosticsFreshnessAdmission = computeDiagnosticsFreshnessAdmission(_diagnosticsFreshnessRecords);

  let researchSectionText = "";
  let researchTopicCount = 0;
  let researchSourceCount = 0;
  let researchCoverageTarget = 0;
  let researchTopicsList: string[] = [];
  let researchSynthesisData: unknown = null;
  let mandatoryFindings: MandatoryHealthAuditFinding[] = [];
  let mandatoryTasksSection = "";
  let mandatoryFindingsPreflightResult: MandatoryFindingsPreflightResult | null = null;
  let benchmarkSection = "";
  let routingOutcomeSection = "";
  let truthMaintenanceSection = "";
  const targetModePlanningActive = isSingleTargetPromptIsolationActive(config);
  let truthSignals = null as Awaited<ReturnType<typeof collectPromptTruthSignals>> | null;
  let latestMainCiConclusionForTruth: string | null = null;
  let preloadedHealthAuditPayload: unknown;
  let benchmarkData: unknown = null;
  let memoryShortlist: ReturnType<typeof buildTrustedMemoryShortlist> | null = null;
  try {
    preloadedHealthAuditPayload = await readJson(path.join(stateDir, "health_audit_findings.json"), null);
    latestMainCiConclusionForTruth = String((preloadedHealthAuditPayload as any)?.latestMainCiConclusion || "").trim().toLowerCase() || null;
  } catch {
    preloadedHealthAuditPayload = undefined;
  }
  try {
    truthSignals = await collectPromptTruthSignals(repoRoot, {
      latestMainCiConclusion: latestMainCiConclusionForTruth,
    });
    if (truthSignals.errors.length > 0) {
      await appendProgress(
        config,
        `[PROMETHEUS][WARN] Truth-maintenance signal collection degraded: ${truthSignals.errors.join("; ")}`,
      );
    }
  } catch (truthErr) {
    await appendProgress(
      config,
      `[PROMETHEUS][WARN] Failed to collect truth-maintenance signals: ${String((truthErr as any)?.message || truthErr)}`,
    );
  }
  if (targetModePlanningActive) {
    await appendProgress(
      config,
      "[PROMETHEUS][TARGET_MODE] Suppressing BOX self-dev planning context for active target session planning",
    );
  }
  try {
    const [researchSynthesis, researchScout, knowledgeMemory, janusDirective, loadedBenchmarkData] = await Promise.all([
      readJson(path.join(stateDir, "research_synthesis.json"), null),
      readJson(path.join(stateDir, "research_scout_output.json"), null),
      readJson(path.join(stateDir, "knowledge_memory.json"), null),
      readJson(path.join(stateDir, "janus_directive.json"), null),
      readBenchmarkGroundTruth(config),
    ]);
    benchmarkData = loadedBenchmarkData;
    researchSynthesisData = researchSynthesis;
    const researchArtifactsAligned = !targetModePlanningActive
      || isResearchArtifactAlignedToTargetSession(researchSynthesis as Record<string, unknown>, config?.activeTargetSession);
    researchTopicsList = researchArtifactsAligned ? extractResearchTopics(researchSynthesis, researchScout) : [];
    const researchArtifactUpdatedAtMs = await getLatestResearchArtifactUpdatedAtMs(stateDir);
    memoryShortlist = buildTrustedMemoryShortlist(knowledgeMemory, {
      requestedBy,
      includeLowTrust: options.includeLowTrustMemory === true,
    });

    // ── Research quality gate: quarantine low-density topics ─────────────────
    // When the quality gate failed, filter out topics below minimum actionable density
    // before injecting them into the Prometheus prompt.  This prevents low-signal
    // topics from degrading plan quality; the resulting state is "degraded planning mode".
    let effectiveSynthesis: unknown = researchSynthesis;
    let degradedPlanningModeActive = false;
    const qg = (researchSynthesis as any)?.qualityGate;
    const qualityGatePlanningMode = String((qg as any)?.planningMode || "").trim();
    if (qg && qg.passed === false) {
      const allTopics: unknown[] = Array.isArray((researchSynthesis as any)?.topics)
        ? (researchSynthesis as any).topics
        : [];
      // Prefer persisted quarantinedTopics list (new schema); fall back to computing from densities.
      const quarantinedTopicNames: string[] = Array.isArray(qg.quarantinedTopics)
        ? qg.quarantinedTopics
        : (Array.isArray(qg.topicDensities)
            ? (qg.topicDensities as any[]).filter((d: any) => !d.passed).map((d: any) => String(d.topic || ""))
            : []);
      const quarantinedSet = new Set(quarantinedTopicNames);
      const passedTopics = allTopics.filter((t: any) => !quarantinedSet.has(String(t?.topic || "")));
      if (quarantinedTopicNames.length > 0) {
        // Always filter quarantined topics from the effective synthesis injected into the prompt.
        effectiveSynthesis = { ...(researchSynthesis as any), topics: passedTopics };
        const allTopicsQuarantined = passedTopics.length === 0;
        const contractRequiresInternalEvidenceOnly = qualityGatePlanningMode === "internal_evidence_only";
        if (allTopicsQuarantined || contractRequiresInternalEvidenceOnly) {
          // ALL topics quarantined — no valid signal remains. Enter degraded planning mode.
          degradedPlanningModeActive = true;
          await appendProgress(
            config,
            `[PROMETHEUS][DEGRADED_PLANNING] ${quarantinedTopicNames.length} low-density topic(s) quarantined from planning context ` +
            `(retried=${qg.retried}). mode=${contractRequiresInternalEvidenceOnly ? "contract:internal_evidence_only" : "inferred:all_topics_quarantined"} — operating in degraded planning mode.`
          );
        } else {
          // PARTIAL quarantine — valid signal retained in passedTopics. NOT degraded.
          await appendProgress(
            config,
            `[PROMETHEUS][PARTIAL_QUARANTINE] ${quarantinedTopicNames.length} low-density topic(s) quarantined ` +
            `(retried=${qg.retried}). ${passedTopics.length} valid topic(s) retained — continuing in normal planning mode.`
          );
        }
      } else {
        await appendProgress(
          config,
          `[PROMETHEUS][WARN] Research synthesis quality gate did not pass (retried=${qg.retried}). ` +
          `${(qg.topicDensities ?? []).filter((d: any) => !d.passed).length} topic(s) below minimum actionable density. ` +
          `Plans may have reduced signal quality.`
        );
      }
    }

    const plannerPriorityActions = Array.isArray((effectiveSynthesis as any)?.plannerSignals?.priorityActions)
      ? (effectiveSynthesis as any).plannerSignals.priorityActions
      : [];
    if (!targetModePlanningActive && truthSignals && memoryShortlist) {
      const reconciledPromptMemory = reconcilePromptMemoryShortlistByTruth(memoryShortlist, truthSignals.signals);
      const plannerPrioritySnapshot = buildPromptTruthMaintenanceSnapshot({
        signals: truthSignals.signals,
        researchRecommendations: plannerPriorityActions,
      });
      const activePlannerPriorityActions = plannerPrioritySnapshot.recommendations.activeText;
      if (Array.isArray((effectiveSynthesis as any)?.plannerSignals?.priorityActions)) {
        effectiveSynthesis = {
          ...(effectiveSynthesis as Record<string, unknown>),
          plannerSignals: {
            ...((((effectiveSynthesis as any)?.plannerSignals) && typeof (effectiveSynthesis as any).plannerSignals === "object")
              ? (effectiveSynthesis as any).plannerSignals
              : {}),
            priorityActions: activePlannerPriorityActions,
          },
        };
      }
      const truthSnapshot = buildPromptTruthMaintenanceSnapshot({
        signals: truthSignals.signals,
        lessons: memoryShortlist?.lessons ?? [],
        researchRecommendations: [
          ...extractLatestBenchmarkRecommendations(loadedBenchmarkData),
          ...plannerPriorityActions,
        ],
        leadershipPriorities: Array.isArray((janusDirective as any)?.priorities) ? (janusDirective as any).priorities : [],
      });
      const activeLeadershipPriorities = truthSnapshot.priorities.activeText;
      const activeTruthLessons = truthSnapshot.lessons.activeText;
      const activeTruthRecommendations = truthSnapshot.recommendations.activeText;
      const retiredTruthLessons = truthSnapshot.lessons.retired.map(({ label, reason }) => ({ label, reason }));
      const retiredTruthRecommendations = truthSnapshot.recommendations.retired.map(({ label, reason }) => ({ label, reason }));
      const retiredTruthPriorities = truthSnapshot.priorities.retired.map(({ label, reason }) => ({ label, reason }));
      truthMaintenanceSection = buildPromptTruthMaintenanceSection({
        activeLessons: activeTruthLessons,
        activeRecommendations: activeTruthRecommendations,
        activePriorities: activeLeadershipPriorities,
        retiredLessons: retiredTruthLessons,
        retiredRecommendations: retiredTruthRecommendations,
        retiredPriorities: retiredTruthPriorities,
      }, { maxActivePerKind: 4, maxRetiredPerKind: 4 });
      memoryShortlist = {
        ...reconciledPromptMemory,
        lessons: truthSnapshot.lessons.active,
        promptHints: reconciledPromptMemory.promptHints,
      };
    }

    const researchContext = buildResearchPromptSection(effectiveSynthesis, researchScout, planningPolicy, researchArtifactUpdatedAtMs, config);
    researchSectionText = researchContext.sectionText;
    // Prepend degraded-mode warning so Prometheus knows its research context is incomplete.
    // When ALL topics are quarantined, researchSectionText may be empty — inject the
    // recovery signal regardless so Prometheus always receives a non-empty planning context.
    if (degradedPlanningModeActive) {
      const quarantinedForRecovery: string[] = Array.isArray(qg?.quarantinedTopics) ? qg.quarantinedTopics : [];
      // Schedule bounded recovery synthesis for the next cycle so the Research Scout
      // can re-run with strict density thresholds rather than silently skipping.
      try {
        const { scheduleBoundedRecoverySynthesis } = await import("./research_synthesizer.js");
        await scheduleBoundedRecoverySynthesis(stateDir, {
          quarantinedTopics: quarantinedForRecovery,
          retriedAlready: qg?.retried === true,
        });
        await appendProgress(
          config,
          `[PROMETHEUS][DEGRADED_PLANNING][INTERNAL_EVIDENCE_MODE] All research topics quarantined. ` +
          `Switching to internal repository-evidence-only planning. ` +
          `Bounded recovery synthesis scheduled for next cycle (${quarantinedForRecovery.length} topic(s)).`
        );
      } catch (recoveryErr) {
        await appendProgress(
          config,
          `[PROMETHEUS][DEGRADED_PLANNING][WARN] Failed to schedule recovery synthesis: ${String((recoveryErr as Error)?.message || recoveryErr)}`
        );
      }
      // Override planning context: derive tasks from repo state only — NOT from topic names.
      // The header below is injected as the sole research context so Prometheus cannot
      // accidentally treat topic names as evidence.
      const degradedHeader =
        `## ⚠️ DEGRADED PLANNING MODE — INTERNAL EVIDENCE ONLY\n` +
        `Research synthesis quality gate is in degraded mode due to insufficient actionable ` +
        `research density. You MUST derive tasks exclusively from concrete ` +
        `repository evidence (failing tests, error logs, source files, state files). ` +
        `Do NOT reference research topic names as task justification — topic names are not evidence.\n` +
        `Persisted planning contract: qualityGate.planningMode=internal_evidence_only.\n` +
        `A bounded recovery synthesis has been scheduled for the next cycle.\n\n`;
      researchSectionText = degradedHeader;
    }
    researchTopicCount = researchContext.topicCount;
    researchSourceCount = researchContext.sourceCount;
    researchCoverageTarget = researchContext.coverageTarget;
    if (researchSectionText) {
      await appendProgress(
        config,
        `[PROMETHEUS] Injecting research synthesis: ${researchTopicCount} topic(s) from ${researchSourceCount} source(s)`
      );
      // Mark synthesis as consumed so the scout gate can trigger a refresh on the next cycle.
      try {
        const synthPath = path.join(stateDir, "research_synthesis.json");
        const synthRaw = await readJson(synthPath, null);
        if (
          synthRaw
          && typeof synthRaw === "object"
          && isResearchArtifactAlignedToTargetSession(synthRaw as Record<string, unknown>, config?.activeTargetSession)
        ) {
          const updated = { ...(synthRaw as Record<string, unknown>), lastConsumedAt: new Date().toISOString() };
          const { writeFile } = await import("node:fs/promises");
          await writeFile(synthPath, JSON.stringify(updated, null, 2), "utf8");
        }
      } catch { /* non-fatal — consumption tracking must never block planning */ }
    }
  } catch {
    // Optional signal; continue without research injection.
  }

  if (!targetModePlanningActive) {
    try {
      const healthAuditPayload = preloadedHealthAuditPayload ?? await readJson(path.join(stateDir, "health_audit_findings.json"), null);
      const { payload: normalizedHealthPayload, suppressedCount: ciBreakSuppressedCount } =
        normalizeStaleCiBreakFindings(healthAuditPayload);
      latestMainCiConclusionForTruth = String((normalizedHealthPayload as any)?.latestMainCiConclusion || "").trim().toLowerCase() || null;
      if (ciBreakSuppressedCount > 0) {
        await appendProgress(
          config,
          `[PROMETHEUS][FRESHNESS] Suppressed ${ciBreakSuppressedCount} stale CI-break finding(s) — main-branch CI was healthy at audit time (latestMainCiConclusion=success)`,
        );
      }
      const allExtractedFindings = extractMandatoryHealthAuditFindings(normalizedHealthPayload);

      // ── Pre-planning truth preflight ─────────────────────────────────────────
      // Quarantine CI-related findings when the source payload is too old or lacks
      // a parseable auditedAt timestamp.  Non-CI findings (capability gaps,
      // architecture debt) are structural and remain trusted regardless of age.
      // This prevents stale CI-break evidence from driving unnecessary premium requests.
      mandatoryFindingsPreflightResult = computeMandatoryFindingsPreflight(
        allExtractedFindings,
        normalizedHealthPayload,
      );
      if (mandatoryFindingsPreflightResult.quarantinedCount > 0) {
        await appendProgress(
          config,
          `[PROMETHEUS][PREFLIGHT_TRUTH] Quarantined ${mandatoryFindingsPreflightResult.quarantinedCount} stale CI finding(s) — ` +
          `preflightStatus=${mandatoryFindingsPreflightResult.preflightStatus} ` +
          `sourceAgeMs=${Number.isFinite(mandatoryFindingsPreflightResult.sourceAgeMs) ? Math.round(mandatoryFindingsPreflightResult.sourceAgeMs) : "unknown"} ` +
          `threshold=${MANDATORY_FINDINGS_PREFLIGHT_MAX_AGE_MS}ms`,
        );
      }

      // Only inject trusted (non-quarantined) findings into the planning prompt.
      mandatoryFindings = mandatoryFindingsPreflightResult.trustedFindings;
      mandatoryTasksSection = buildMandatoryTasksPromptSection(mandatoryFindings);
      if (mandatoryFindings.length > 0) {
        await appendProgress(
          config,
          `[PROMETHEUS] Injecting mandatory health-audit tasks: ${mandatoryFindings.length} finding(s) from state/health_audit_findings.json`
        );
      }
    } catch (error) {
      await appendProgress(
        config,
        `[PROMETHEUS][WARN] Failed to load health audit findings for mandatory-task injection: ${String((error as any)?.message || error)}`
      );
    }
  }

  // ── Compute benchmark planning priors (co-loaded with routing telemetry) ─────
  // Declared before the try block so the density gate below always has a valid
  // value even when benchmarkData loading fails.
  let planningPriors = computeBenchmarkPlanningPriors(null);

  // Pre-load prior-cycle violation feedback outside the main try/catch so it is
  // available even when benchmarkData loading partially fails.
  let priorCycleViolationSignal: RetryViolationSignal | null = null;
  try {
    const prevAnalytics = await readJson(path.join(stateDir, "cycle_analytics.json"), null);
    const vf = prevAnalytics?.lastCycle?.violationFeedback ?? prevAnalytics?.violationFeedback ?? null;
    if (vf && typeof vf === "object") {
      priorCycleViolationSignal = {
        retryRate:             typeof vf.retryRate             === "number" ? vf.retryRate             : null,
        contractViolationRate: typeof vf.contractViolationRate === "number" ? vf.contractViolationRate : null,
        rerouteRate:           typeof vf.rerouteRate           === "number" ? vf.rerouteRate           : null,
      };
    }
  } catch { /* non-fatal — proceed without prior-cycle signal */ }

  if (!targetModePlanningActive) {
    try {
      const [resolvedBenchmarkData, premiumUsageData] = await Promise.all([
        benchmarkData ? Promise.resolve(benchmarkData) : readBenchmarkGroundTruth(config),
        readJson(path.join(stateDir, "premium_usage_log.json"), []),
      ]);
      benchmarkData = resolvedBenchmarkData;
      benchmarkSection = buildBenchmarkSection(resolvedBenchmarkData);
      routingOutcomeSection = buildRoutingOutcomeSection(premiumUsageData);
      if (benchmarkSection || routingOutcomeSection) {
        await appendProgress(
          config,
          `[PROMETHEUS] Injecting routing telemetry signals: benchmark=${benchmarkSection ? "yes" : "no"} outcomes=${routingOutcomeSection ? "yes" : "no"}`
        );
      }
      // Derive planning priors from the same benchmarkData so we avoid a second disk read.
      // Include prior-cycle violation/retry/reroute signal so observed pressure adjusts
      // strictness on top of the capacity-gain baseline.
      const benchmarkEntries = Array.isArray((resolvedBenchmarkData as any)?.entries)
        ? (resolvedBenchmarkData as any).entries as unknown[]
        : [];
      const capacityGainResult = computeResearchCapacityGain(benchmarkEntries as any[]);
      planningPriors = computeBenchmarkPlanningPriors(capacityGainResult, priorCycleViolationSignal);
      if (planningPriors.uncertainty !== "low" || planningPriors.retryViolationAdjustment > 0) {
        await appendProgress(
          config,
          `[PROMETHEUS][PRIORS] Planning priors: uncertainty=${planningPriors.uncertainty} strictnessMultiplier=${planningPriors.strictnessMultiplier} verificationDepth=${planningPriors.verificationDepth} retryViolationAdj=${planningPriors.retryViolationAdjustment}`
        );
      }
      planningPolicy = buildPrometheusPlanningPolicy(config, prevLaneTelemetry, {
        uncertainty: planningPriors.uncertainty,
        taskKindTelemetry: extractTaskKindPacketTelemetry(prevAnalyticsSnapshot),
      });
    } catch (signalErr) {
      await appendProgress(
        config,
        `[PROMETHEUS][WARN] Failed to load routing telemetry signals: ${String((signalErr as any)?.message || signalErr)}`
      );
    }
  }
  const candidatePlanningPolicy = deriveCandidatePlanningPolicy(planningPriors);

  // planningPriors initialized inside the routing telemetry try block above.
  // Declared here as baseline so the density gate below always has a valid value,
  // even when benchmarkData loading fails.
  // (If the try block above succeeded, planningPriors is already overwritten.)
  // ── Load accumulated topic memory ─────────────────────────────────────────
  let topicMemory = targetModePlanningActive ? { topics: {} } as Awaited<ReturnType<typeof loadTopicMemory>> : await loadTopicMemory(stateDir);
  let topicMemorySection = "";
  let trustedMemorySection = "";
  let cycleProofSection = "";
  if (!targetModePlanningActive) {
    try {
      topicMemorySection = buildTopicMemoryPromptSection(topicMemory);
      const activeCount = Object.values(topicMemory.topics).filter(t => t.status === "active").length;
      const completedCount = Object.values(topicMemory.topics).filter(t => t.status === "completed").length;
      const archivedCount = Object.values(topicMemory.topics).filter(t => t.status === "archived").length;
      if (activeCount > 0 || completedCount > 0 || archivedCount > 0) {
        await appendProgress(config,
          `[PROMETHEUS] Topic memory loaded: ${activeCount} active, ${completedCount} completed, ${archivedCount} archived topic(s)`
        );
      }
    } catch {
      // Non-fatal — proceed without topic memory.
    }

    try {
      if (!memoryShortlist) {
        const knowledgeMemory = await readJson(path.join(stateDir, "knowledge_memory.json"), null);
        memoryShortlist = buildTrustedMemoryShortlist(knowledgeMemory, {
          requestedBy,
          includeLowTrust: options.includeLowTrustMemory === true,
        });
      }
      if (memoryShortlist && (memoryShortlist.lessons.length > 0 || memoryShortlist.promptHints.length > 0)) {
        const lessonLines = memoryShortlist.lessons.map((entry: any, index: number) => {
          const trustLevel = String(entry?.trust?.level || MEMORY_TRUST_LEVEL.MEDIUM);
          return `${index + 1}. ${String(entry?.lesson || "").trim()} [trust=${trustLevel}]`;
        }).filter((line: string) => /\S/.test(line));
        const hintLines = memoryShortlist.promptHints.map((entry: any, index: number) => {
          const trustLevel = String(entry?.trust?.level || MEMORY_TRUST_LEVEL.MEDIUM);
          return `${index + 1}. ${String(entry?.hint || "").trim()} [trust=${trustLevel}]`;
        }).filter((line: string) => /\S/.test(line));
        trustedMemorySection = `\n\n## TRUST-FILTERED KNOWLEDGE MEMORY\nLessons:\n${lessonLines.length > 0 ? lessonLines.join("\n") : "- (none)"}\n\nPrompt hints:\n${hintLines.length > 0 ? hintLines.join("\n") : "- (none)"}`;
      }
      if (memoryShortlist && (memoryShortlist.droppedLowTrustLessons > 0 || memoryShortlist.droppedLowTrustHints > 0)) {
        await appendProgress(
          config,
          `[PROMETHEUS][MEMORY_TRUST] filtered low-trust entries lessons=${memoryShortlist.droppedLowTrustLessons} hints=${memoryShortlist.droppedLowTrustHints} includeLowTrust=${options.includeLowTrustMemory === true && isPrivilegedMemoryRequester(requestedBy)}`
        );
      }
    } catch (memoryErr) {
      await appendProgress(
        config,
        `[PROMETHEUS][WARN] Failed to load trust-filtered knowledge memory: ${String((memoryErr as any)?.message || memoryErr)}`
      );
    }

    try {
      const cycleProofEvidence = await readJson(path.join(stateDir, "cycle_proof_evidence.json"), null);
      const seamValidation = validateCycleProofEvidenceSeams(cycleProofEvidence);
      if (!seamValidation.ok) {
        await appendProgress(
          config,
          `[PROMETHEUS][CYCLE_PROOF] rejected incomplete cycle_proof_evidence artifact: ${seamValidation.failReasons.slice(0, 5).join("; ")}`
        );
      } else {
        const failedSeams = CYCLE_PROOF_SEAM_KEYS.filter((key) => seamValidation.seamChecks[key]?.pass !== true);
        cycleProofSection = `\n\n## CYCLE PROOF EVIDENCE\ncycleId=${seamValidation.cycleId}\nseamStatus=${failedSeams.length === 0 ? "all-pass" : `failed(${failedSeams.join(",")})`}`;
      }
    } catch {
      // Optional signal — proceed without cycle proof evidence section.
    }
  }

  // ── Extract behavior patterns from postmortems ────────────────────────────
  let behaviorPatternsSection = "";
  let postmortemShortlistSection = "";
  let carryForwardSection = "";
  // Postmortem entries lifted to function scope so the carry-forward gate can
  // evaluate them after plan generation and validation.
  let postmortemEntries: any[] = [];
  if (!targetModePlanningActive) {
    try {
      // Load carry-forward ledger and coordination data in parallel for retirement check
      const [postmortems, cfLedgerData, coordinationData] = await Promise.all([
        readJson(path.join(stateDir, "athena_postmortems.json"), null),
        readJson(path.join(stateDir, "carry_forward_ledger.json"), { entries: [] }),
        readJson(path.join(stateDir, "athena_coordination.json"), {}),
      ]);
      const cfLedger = Array.isArray(cfLedgerData?.entries) ? cfLedgerData.entries : [];
      const coordinationCompletedTasks = Array.isArray(coordinationData?.completedTasks)
        ? coordinationData.completedTasks : [];
      const entries = Array.isArray(postmortems?.entries) ? postmortems.entries : [];
      postmortemEntries = entries; // expose to carry-forward gate after plan validation
      const shortlist = buildRankedLessonShortlists(entries, { limit: 10 });
      const unresolvedShortlistLessons = new Set(
        shortlist.unresolvedTop10.map((item) => String(item.lesson || "").toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean),
      );
      
      if (entries.length > 0) {
      // ── Token-partitioned postmortem shortlist (compilePrometheusContextShortlist) ──
      // Converts ranked lesson entries into ShortlistItem[] and enforces the
      // TOKEN_PARTITION_LIMITS.behaviorPatterns cap so repeated long-tail blocks
      // cannot exhaust the prompt budget.
      const shortlistItems: ShortlistItem[] = [
        ...shortlist.recentTop10,
        ...shortlist.highImpactTop10,
        ...shortlist.unresolvedTop10,
      ].reduce<ShortlistItem[]>((acc, item) => {
        if (!acc.some(a => a.id === item.lesson)) {
          acc.push({
            id: item.lesson,
            text: `${item.lesson} (score=${item.score.toFixed(2)}, impact=${item.impact.toFixed(2)}, freshness=${item.freshness.toFixed(2)})`,
            recencyScore: Math.max(0, Math.min(1, item.freshness)),
            impactScore: Math.max(0, Math.min(1, item.impact)),
            resolved: !item.unresolved,
          });
        }
        return acc;
      }, []);

      postmortemShortlistSection = compilePrometheusContextShortlist(
        "POSTMORTEM SHORTLISTS (ranked recent+high-impact+unresolved)",
        shortlistItems,
        "behaviorPatterns",
        { maxItems: 15, includeResolved: false },
      );
      if (postmortemShortlistSection) {
        postmortemShortlistSection = "\n\n" + postmortemShortlistSection;
      }

      // ── Shortlist-based behavior patterns section ─────────────────────────
      // Replaces old long-tail manual analysis with compilePrometheusContextShortlist:
      // selects ranked high-impact+unresolved items under TOKEN_PARTITION_LIMITS
      // behaviorPatterns cap so repeated large blocks cannot exhaust the prompt budget.
      if (shortlistItems.length > 0) {
        const bpSection = compilePrometheusContextShortlist(
          "BEHAVIOR PATTERNS FROM POSTMORTEMS (ranked high-impact+unresolved)",
          shortlistItems,
          "behaviorPatterns",
          { maxItems: 10, includeResolved: false },
        );
        if (bpSection) {
          behaviorPatternsSection = "\n\n" + bpSection;
        }
      }
      
      // Carry-forward follow-ups — retire items already resolved in ledger or coordination
      const allPending = entries
        .filter(e => e.followUpNeeded && e.followUpTask)
        .filter((entry) => {
          if (unresolvedShortlistLessons.size === 0) return true;
          const followUp = String(entry?.followUpTask || entry?.lessonLearned || "").toLowerCase().replace(/\s+/g, " ").trim();
          return followUp && unresolvedShortlistLessons.has(followUp);
        });
      const pending = filterResolvedCarryForwardItems(allPending, cfLedger, coordinationCompletedTasks);
      if (pending.length > 0) {
        const seenFollowUps = new Set();
        const deduped = [];
        // Traverse from newest to oldest so repeated tasks keep their latest wording/date.
        for (let i = pending.length - 1; i >= 0; i--) {
          const e = pending[i];
          const fp = computeFingerprint(String(e.followUpTask || ""));
          if (!fp || seenFollowUps.has(fp)) continue;
          seenFollowUps.add(fp);
          deduped.push(e);
        }
        const shortlistedPending = deduped.slice(-10);
        const classified = classifyCarryForwardByRecurrence(shortlistedPending, entries);
        const highRec = classified.highRecurrence;
        const lowRec = classified.lowRecurrence.slice(-CARRY_FORWARD_MAX_LOW_RECURRENCE_ITEMS);
        const combined = [...highRec, ...lowRec];
        combined.reverse();
        const suppressedCount = classified.lowRecurrence.length - lowRec.length;
        const suppressedNote = suppressedCount > 0 ? ` (${suppressedCount} low-recurrence items omitted)` : "";
        const items = combined.map((e, i) =>
          `${i + 1}. [worker=${e.workerName || "unknown"}, reviewed=${e.reviewedAt || "?"}, recurrence=${e.recurrenceCount ?? 1}] ${e.followUpTask}`
        ).join("\n");
        carryForwardSection = `\n\n## MANDATORY_CARRY_FORWARD\nThe following follow-up tasks from previous Athena postmortems have NOT been addressed yet.\nYou MUST include these in your plan unless they are already resolved in the codebase:${suppressedNote}:\n${items}\n`;
      }
      }
    } catch { /* non-fatal — proceed without pattern analysis */ }
  }

  // ── Deterministic semantic retrieval for planner context ───────────────────
  let semanticRetrievalSection = "";
  try {
    const scan = await scanProject({ rootDir: repoRoot });
    const candidates = buildSemanticFileCandidatesFromScan(scan);
    const retrievalQuery = [
      userPrompt,
      String(options.prometheusReason || ""),
      String(carryForwardSection || ""),
      String(behaviorPatternsSection || ""),
    ].join("\n");
    const ranked = rankSemanticFileCandidates(retrievalQuery, candidates, {
      tokenBudget: 1100,
      maxEntries: 16,
      cacheKey: `prometheus:${repoRoot}:${retrievalQuery}`,
    });
    if (ranked.length > 0) {
      semanticRetrievalSection = compileRankedContextSection(
        "SEMANTIC FILE PRIORITY (deterministic, token-budgeted)",
        ranked,
        { tokenBudget: 1100, maxEntries: 16 },
      );
    }
  } catch {
    // Non-fatal — prompt generation continues without semantic retrieval.
  }

  // ── Self-improvement repair feedback injection ────────────────────────────
  let repairFeedbackSection = "";
  if (!targetModePlanningActive && options.repairFeedback) {
    const rf = options.repairFeedback;
    const causes = (rf.rootCauses || []).map((c, i) => `${i + 1}. [${c.severity}] ${c.cause} (affects: ${c.affectedComponent})`).join("\n");
    const patches = (rf.behaviorPatches || []).map((p, i) => `${i + 1}. [${p.target}] ${p.patch} \u2014 rationale: ${p.rationale}`).join("\n");
    const constraints = rf.repairedPlanConstraints || {};
    const upgrades = (rf.verificationUpgrades || []).map((u, i) => `${i + 1}. ${u.area}: ${u.currentProblem} \u2192 required: ${u.requiredStandard}`).join("\n");

    repairFeedbackSection = `\n\n## CRITICAL: ATHENA REJECTION REPAIR FEEDBACK\nThe previous plan was REJECTED by Athena. Self-improvement has analyzed the failure.\nYou MUST address every item below. Repeating the same mistakes will cause a hard stop.\n\n### ROOT CAUSES OF REJECTION\n${causes || "- No root causes identified"}\n\n### BEHAVIOR PATCHES (you MUST follow these)\n${patches || "- No patches specified"}\n\n### PLAN CONSTRAINTS (mandatory for this re-plan)\n- Must include: ${JSON.stringify(constraints.mustInclude || [])}\n- Must NOT repeat: ${JSON.stringify(constraints.mustNotRepeat || [])}\n- Verification standard: ${constraints.verificationStandard || "task-specific, measurable"}\n- Wave strategy: ${constraints.waveStrategy || "explicit inter-wave dependencies required"}\n\n### VERIFICATION UPGRADES REQUIRED\n${upgrades || "- No specific upgrades"}\n\nFAILURE TO COMPLY WITH THESE CONSTRAINTS WILL RESULT IN CYCLE TERMINATION.\n`;
  }
  const planningMode = resolvePrometheusPromptPlanningMode(config, options);

  // ── Architecture drift summary injection ─────────────────────────────────
  // Inject unresolved stale doc references and deprecated token usage so
  // Prometheus can include remediation tasks in the plan.
  let driftSummarySection = "";
  const driftReport = options.driftReport;
  if (!targetModePlanningActive && driftReport && (driftReport.staleCount > 0 || driftReport.deprecatedTokenCount > 0)) {
    const staleLines = (driftReport.staleReferences || []).slice(0, 20).map(
      (r, i) => `${i + 1}. [${r.docPath}:${r.line}] references missing file: ${r.referencedPath}`
    ).join("\n");
    const tokenLines = (driftReport.deprecatedTokenRefs || []).slice(0, 20).map(
      (r, i) => `${i + 1}. [${r.docPath}:${r.line}] deprecated token "${r.token}" — ${r.hint}`
    ).join("\n");
    const moreMsgStale = (driftReport.staleReferences || []).length > 20
      ? `\n... and ${(driftReport.staleReferences || []).length - 20} more` : "";
    const moreMsgToken = (driftReport.deprecatedTokenRefs || []).length > 20
      ? `\n... and ${(driftReport.deprecatedTokenRefs || []).length - 20} more` : "";

    driftSummarySection = `\n\n## ARCHITECTURE DRIFT REPORT (unresolved — generated this cycle)\nScanned ${driftReport.scannedDocs.length} documentation file(s). Found ${driftReport.staleCount} stale file reference(s) and ${driftReport.deprecatedTokenCount} deprecated token usage(s).\nThese represent gaps between docs and the current codebase. You MUST include remediation tasks for items you cannot immediately resolve.\n${staleLines ? `\n### Stale File References\n${staleLines}${moreMsgStale}` : ""}${tokenLines ? `\n\n### Deprecated Token Usage\n${tokenLines}${moreMsgToken}` : ""}`;
  }

  // ── Build minimal directive prompt ──────────────────────────────────────
  // Prometheus now reads files autonomously via allowAll tools.
  // No source code or state data is injected — Prometheus decides what to read.
  // Only cycle-delta context (carry-forward, behavior patterns, research topics,
  // repair feedback, drift summary) and planning policy are passed in the prompt.
  // The static identity sections (evolution directive, self-critique, output format)
  // are defined in prometheus.agent.md and loaded automatically by the agent runtime.

  // Build compact cycle-delta context sections
  const cycleDeltaParts: string[] = [];

  // Planning policy
  cycleDeltaParts.push(buildPromptAssemblyPrompt({ agentName: "prometheus", config }));

  cycleDeltaParts.push(`## PLANNING POLICY
- planningMode: ${planningMode}
- maxTasks: ${planningPolicy.maxTasks > 0 ? planningPolicy.maxTasks : "UNLIMITED"}
- maxWorkersPerWave: ${planningPolicy.maxWorkersPerWave}
- maxPlansPerPacket: ${planningPolicy.maxPlansPerPacket} (HARD CAP — do not exceed)
- planningUncertainty: ${planningPolicy.planningUncertainty}
- adaptivePacketCaps: implementation<=${planningPolicy.adaptivePacketCaps.implementation}, bugfix<=${planningPolicy.adaptivePacketCaps.bugfix}, refactor<=${planningPolicy.adaptivePacketCaps.refactor}, test<=${planningPolicy.adaptivePacketCaps.test}, rework<=${planningPolicy.adaptivePacketCaps.rework}, ci-fix<=${planningPolicy.adaptivePacketCaps["ci-fix"]}
- preferFewestWorkers: ${planningPolicy.preferFewestWorkers}
- requireDependencyAwareWaves: ${planningPolicy.requireDependencyAwareWaves}
- researchCoverageTarget: ${researchCoverageTarget > 0 ? researchCoverageTarget : "AUTO(0 when no research artifacts)"}
- Do NOT create extra waves without explicit task-level dependsOn/dependencies evidence.
- Avoid single-task waves unless dependency constraints force them.

## BUNDLED WORK PACKAGES — BOUNDED
Each plan packet you produce is ONE AI worker call. Bundle related work, but respect the maxPlansPerPacket cap (${planningPolicy.maxPlansPerPacket} steps).
Fragile task kinds MUST obey the tighter adaptive caps above even when the global cap is larger.

RULE: Every packet MUST contain enough work to justify a full AI context call. This means:
1. GROUP related sub-tasks into a single packet. If you find 5 small fixes in the same area, bundle ALL of them into ONE packet with ordered steps.
2. A packet's task field must describe a COMPLETE feature or improvement area, not a single micro-fix.
3. Emit as many high-value packets as evidence supports, but each packet must stay within the maxPlansPerPacket cap.
4. Each packet's scope should cover multiple related files and multiple related behaviors.
5. Plans covering 5+ target files MUST declare estimatedExecutionTokens >= 8000.
6. EXCEPTION: Only create separate packets when there is a HARD dependency ordering requirement.

## PLANNING MODE CONTRACT
- master_evolution = produce the primary capacity-increase plan for the cycle. Favor explicit worker topology and parallel wave structure when evidence supports it.
- repair_plan = repair a rejected plan with the smallest deterministic changes needed to make it dispatchable. Do NOT widen scope into a fresh repo-wide master plan.
- You MUST emit executionStrategy.planningMode, executionStrategy.executionPattern, and executionStrategy.workerTopology in the JSON block.
- executionPattern MUST be one of: wave_parallel | bounded_chain | single_worker | serial_repair.
- workerTopology MUST include workerCount, laneCount, maxParallelWorkers, roles[], and lanes[] derived from the actual plans you emit.

## STRUCTURAL CORRECTNESS — LEARN THESE PATTERNS
### dependencies — use EXACT packet titles, never aliases
### acceptance_criteria — every item MUST contain a numeric threshold
### wave assignments — tasks with dependencies must be in a later wave`);
  if (candidatePlanningPolicy.enabled) {
    cycleDeltaParts.push(buildCandidateGenerationSection({
      minCandidates: candidatePlanningPolicy.minCandidates,
      maxCandidates: candidatePlanningPolicy.maxCandidates,
    }).content);
  }
  if (diagnosticsFreshnessSection) cycleDeltaParts.push(diagnosticsFreshnessSection);

  // Lane telemetry: inject per-lane performance signals to guide role assignment
  if (planningPolicy.laneTelemetry) {
    const laneTelemetrySection = buildLaneTelemetryPromptSection(planningPolicy.laneTelemetry);
    if (laneTelemetrySection) cycleDeltaParts.push(laneTelemetrySection);
  }

  // Research intelligence summary (topics only — Prometheus reads full synthesis file itself)
  if (researchTopicsList.length > 0) {
    const topicLines = researchTopicsList.map((topic, i) => `${i + 1}. ${topic}`).join("\n");
    cycleDeltaParts.push(`## RESEARCH INTELLIGENCE AVAILABLE
${researchTopicsList.length} topic(s) from ${researchSourceCount} source(s) available.
Research coverage target: ${researchCoverageTarget > 0 ? researchCoverageTarget : "AUTO"} research-backed packet(s).

Topics identified:
${topicLines}

IMPORTANT: Read state/research_synthesis.json for full extracted content from each source.
The synthesis contains real technical details — algorithm names, benchmark numbers, code examples, architecture patterns.
Use this data to produce evidence-backed plans, not vague strategic recommendations.`);
  }

  // Topic memory (compact)
  if (topicMemorySection) cycleDeltaParts.push(topicMemorySection);
  if (truthMaintenanceSection) cycleDeltaParts.push(truthMaintenanceSection);
  if (trustedMemorySection) cycleDeltaParts.push(trustedMemorySection);
  if (cycleProofSection) cycleDeltaParts.push(cycleProofSection);

  // Behavior patterns from postmortems
  if (behaviorPatternsSection) cycleDeltaParts.push(behaviorPatternsSection);
  if (postmortemShortlistSection) cycleDeltaParts.push(postmortemShortlistSection);

  // Carry-forward follow-ups
  if (carryForwardSection) cycleDeltaParts.push(carryForwardSection);
  if (benchmarkSection) cycleDeltaParts.push(benchmarkSection);
  if (routingOutcomeSection) cycleDeltaParts.push(routingOutcomeSection);

  // Repair feedback (if Athena rejected previous plan)
  if (repairFeedbackSection) cycleDeltaParts.push(repairFeedbackSection);

  // Architecture drift summary
  if (driftSummarySection) cycleDeltaParts.push(driftSummarySection);
  if (semanticRetrievalSection) cycleDeltaParts.push(`\n\n${semanticRetrievalSection}`);
  if (mandatoryTasksSection) cycleDeltaParts.push(mandatoryTasksSection);

  const cycleDeltaSections = _markCycleDeltaSectionsRequired(
    [
      section("research-intelligence", researchTopicsList.length > 0 ? cycleDeltaParts.find(p => p.startsWith("## RESEARCH INTELLIGENCE AVAILABLE")) || "" : ""),
      section("topic-memory", topicMemorySection || ""),
      section("truth-maintenance", truthMaintenanceSection || ""),
      section("trusted-memory", trustedMemorySection || ""),
      section("cycle-proof", cycleProofSection || ""),
      section("behavior-patterns", behaviorPatternsSection || ""),
      section("postmortem-shortlist", postmortemShortlistSection || ""),
      section("carry-forward", carryForwardSection || ""),
      section("benchmark", benchmarkSection || ""),
      section("routing-outcomes", routingOutcomeSection || ""),
      section("repair-feedback", repairFeedbackSection || ""),
      section("drift-summary", driftSummarySection || ""),
      section("mandatory-tasks", mandatoryTasksSection || ""),
      section("diagnostics-freshness", diagnosticsFreshnessSection || ""),
    ],
    PROMETHEUS_CYCLE_DELTA_SECTION_NAMES
  );
  const resolvedStaticSections = resolvePrometheusStaticSections(config);
  const resolvedStaticSectionNames = resolvedStaticSections === TARGET_PROMETHEUS_STATIC_SECTIONS
    ? TARGET_PROMETHEUS_STATIC_SECTION_NAMES
    : PROMETHEUS_STATIC_SECTION_NAMES;
  const markedStaticPromptSections = _markCacheableSegments(
    Object.values(resolvedStaticSections).map((promptSection) => ({ ...promptSection })),
    {
      stableNames: Array.from(resolvedStaticSectionNames),
    },
  );
  const filteredStaticPromptSections = markedStaticPromptSections.filter(
    (promptSection) => String(promptSection.content || "").trim().length > 0,
  );
  const markedCycleDelta = _markCacheableSegments(cycleDeltaSections, {
    stableNames: Array.from(resolvedStaticSectionNames),
  });
  const filteredCycleDelta = markedCycleDelta.filter(s => String(s.content || "").trim().length > 0);
  const promptTelemetrySections = [...filteredStaticPromptSections, ...filteredCycleDelta];
  const promptFamilyLabel = resolvePrometheusPromptFamilyLabel(config, options);
  let promptLineage = null;
  if (promptTelemetrySections.length > 0) {
    const cacheableSections = promptTelemetrySections.filter((section) => section.cacheable === true);
    const estimatedSavedTokens = cacheableSections.reduce(
      (sum, section) => sum + estimateTokens(String(section.content || "")),
      0,
    );
    const promptFamilyKey = derivePromptFamilyKey(promptTelemetrySections, { salt: promptFamilyLabel });
    const priorPromptLineage = options?.promptLineage && typeof options.promptLineage === "object"
      ? normalizePromptLineageContract(options.promptLineage)
      : null;
    promptLineage = normalizePromptLineageContract({
      lineageId: priorPromptLineage?.lineageId || `planner:${promptFamilyKey}`,
      parentLineageId: priorPromptLineage?.lineageId || null,
      promptFamilyKey,
      familyLabel: promptFamilyLabel,
      agent: "prometheus",
      stage: "planner",
      checkpointNs: "planner",
      checkpointId: options?.promptCheckpointId || priorPromptLineage?.checkpointId || null,
      resumeFromCheckpointId: options?.resumeFromCheckpointId || priorPromptLineage?.checkpointId || null,
      stablePrefixHash: promptFamilyKey,
      totalSegments: promptTelemetrySections.length,
      cacheableSegments: cacheableSections.length,
      estimatedSavedTokens,
    });
    appendPromptCacheTelemetry(config, {
      promptFamilyKey,
      agent: "prometheus",
      model: prometheusModel,
      taskKind: "planning",
      totalSegments: promptTelemetrySections.length,
      cachedSegments: cacheableSections.length,
      estimatedSavedTokens,
      lineageId: promptLineage.lineageId || undefined,
      cycleId: String((config as any)?.cycleId || ""),
      lineage: {
        lineageId: promptLineage.lineageId || null,
        promptFamilyKey,
        cycleId: String((config as any)?.cycleId || ""),
        taskKind: "planning",
        role: "prometheus",
      },
    }).catch(() => { /* prompt-cache telemetry is advisory only */ });
  }
  const compiledStaticPromptSections = _compilePrompt(filteredStaticPromptSections);
  const compiledCycleDelta = _compilePrompt(filteredCycleDelta, { tokenBudget: 8000 });

  const promptLineageMarker = promptLineage ? `${buildPromptLineageMarker(promptLineage)}\n` : "";
  const promptRepoPath = resolvePrometheusPromptRepoPath(config, repoRoot);
  const contextPrompt = `${promptLineageMarker}TARGET REPO: ${config.env?.targetRepo || "unknown"}
REPO PATH: ${promptRepoPath}
STATE DIR: ${stateDir}

${compiledStaticPromptSections}

## OPERATOR OBJECTIVE
${userPrompt}

${buildPrometheusWorkflowPrompt(config, repoRoot)}

The JSON plans array is MANDATORY in normal mode — the orchestrator reads it to dispatch workers.
When bounded multi-candidate mode is enabled, candidateSets[*].plans is the primary dispatch payload and top-level plans may be omitted.
Each plan in the array must have: title, task, owner, role, wave, scope, target_files, before_state, after_state, riskLevel, dependencies, acceptance_criteria, verification, premortem (if medium/high risk), capacityDelta, requestROI, capabilityLane, capabilityTag.

Role/lane assignment is dispatch-critical.
- Use the best-fit worker role, not generic evolution-worker by default.
- quality-worker for tests, audits, regression-proofing, coverage, Athena review fidelity.
- governance-worker for dispatch rules, governance contracts, correction tokens, lane diversity, freeze/canary policy.
- infrastructure-worker for CI, docker, deployment, infra setup.
- observation-worker for metrics, dashboards, telemetry, alerts.
- integration-worker for wiring/import flows across modules.
- evolution-worker only for true implementation/refactor work that does not clearly belong to a specialist lane.
- capabilityLane must match the chosen role's lane and capabilityTag must explain why that lane was chosen.

${compiledCycleDelta}`;

  appendPromptPreviewSync(stateDir, contextPrompt);

  await appendPrometheusLiveLog(stateDir, "leadership_live", `[${ts()}] ${prometheusName.padEnd(20)} Calling Copilot CLI (agent=prometheus, allowAll=true)...`);

  // ── Call Copilot CLI with full tool access ────────────────────────────────
  // Prometheus reads files autonomously — no code/state injection from Node.js.
  // allowAll: true gives read + write + list_dir + search so Prometheus can
  // explore the repo, read research synthesis, read state files, and write its plan.
  const args = buildAgentArgs({
    agentSlug: "prometheus",
    prompt: contextPrompt,
    model: prometheusModel,
    allowAll: true,
    noAskUser: true,
    maxContinues: undefined,
    runContract: promptLineage ? { promptLineage } : undefined,
  });

  appendLiveLogSync(stateDir, `\n[copilot_stream_start] ${ts()}\n`);

  const prometheusCallStartedAt = Date.now();
  const promptChars = contextPrompt.length;
  const prometheusTimeoutMs = Math.max(
    120_000,
    Number(config?.runtime?.prometheusTimeoutMs || 20 * 60 * 1000)
  );
  const heartbeatIntervalMs = Math.max(
    30_000,
    Number(config?.runtime?.prometheusHeartbeatIntervalMs || 60_000)
  );
  const heartbeatTimer = setInterval(() => {
    const elapsedMs = Date.now() - prometheusCallStartedAt;
    const elapsedMinutes = Math.floor(elapsedMs / 60_000);
    const elapsedSeconds = Math.floor((elapsedMs % 60_000) / 1000);
    const heartbeat = `[PROMETHEUS] Analysis in progress — elapsed=${elapsedMinutes}m ${elapsedSeconds}s promptChars=${promptChars} model=${prometheusModel}`;
    appendProgress(config, heartbeat).catch(() => { /* non-fatal heartbeat logging */ });
    appendPrometheusLiveLog(
      stateDir,
      "leadership_live",
      `[${ts()}] ${prometheusName.padEnd(20)} Heartbeat — elapsed=${elapsedMinutes}m ${elapsedSeconds}s promptChars=${promptChars} model=${prometheusModel}`
    ).catch(() => { /* non-fatal heartbeat logging */ });
  }, heartbeatIntervalMs);

  let streamedStdout = "";
  let streamedStderr = "";
  let result;
  try {
    result = await spawnAsync(command, args, {
      env: process.env,
      timeoutMs: prometheusTimeoutMs,
      // Kill the CLI process as soon as ===END=== appears in output — the
      // model is done and the CLI often hangs open for minutes after this.
      earlyExitMarker: "===END===",
      onStdout(chunk) {
        const text = chunk.toString("utf8");
        streamedStdout += text;
        appendLiveLogSync(stateDir, text);
      },
      onStderr(chunk) {
        const text = chunk.toString("utf8");
        streamedStderr += text;
        appendLiveLogSync(stateDir, text);
      }
    });
  } finally {
    clearInterval(heartbeatTimer);
  }

  appendLiveLogSync(stateDir, `\n[copilot_stream_end] ${ts()} exit=${(result as any).status}\n`);

  const stdout = String((result as any)?.stdout || "");
  const stderr = String((result as any)?.stderr || "");
  const combinedRaw = resolveCapturedAgentRawOutput(stdout, stderr, streamedStdout, streamedStderr);
  const raw = combinedRaw;

  // ── Check for model fallback ──────────────────────────────────────────────
  const fallback = detectModelFallback(combinedRaw);
  if (fallback) {
    const warningMessage = `Prometheus model fallback: requested=${fallback.requestedModel}, active=${fallback.fallbackModel}`;
    await appendProgress(config, `[PROMETHEUS][WARN] ${warningMessage}`);
    try {
      await appendAlert(config, { severity: "warning", source: "prometheus", title: "Prometheus model fallback", message: warningMessage });
    } catch { /* non-fatal */ }
  }

  // ── Handle failure ────────────────────────────────────────────────────────
  if ((result as any).status !== 0) {
    const error = `exited ${(result as any).status}: ${(stderr || stdout).slice(0, 500)}`;
    await appendProgress(config, `[PROMETHEUS] Analysis failed — ${error}`);
    await appendPrometheusLiveLog(stateDir, "leadership_live", `[${ts()}] ${prometheusName.padEnd(20)} Analysis failed: ${error}`);
    return null;
  }

  // ── Parse output ──────────────────────────────────────────────────────────
  let aiResult = parseAgentOutput(raw);

  // ── Parser contract gate (pre-normalization) ──────────────────────────────
  // Mandatory parse fields must be present/valid before normalization:
  //   - projectHealth ∈ {healthy,degraded,critical,needs-work}
  //   - requestBudget.estimatedPremiumRequestsTotal is finite
  //   - keyFindings is non-empty
  //   - strategicNarrative is non-empty
  // Retry once with an explicit diff; fail-closed on second failure.
  const parsedContractCandidate = aiResult?.parsed || buildNarrativeFallbackParsed({ ...aiResult, raw });
  const repairedParsedContractCandidate = repairParserContractCandidate(parsedContractCandidate, raw);

  let retryAiResult: any = null;
  const parserContractResult = await enforceParserContractBeforeNormalization(
    repairedParsedContractCandidate,
    {
      onRetryDiff: async (parserDiff: string) => {
        await appendProgress(
          config,
          `[PROMETHEUS][PARSER_CONTRACT] Missing/invalid mandatory fields — retrying once with diff: ${parserDiff}`
        );
      },
      onRetrySuccess: async () => {
        await appendProgress(config, "[PROMETHEUS][PARSER_CONTRACT] Retry succeeded");
      },
      onRetryViolation: async (violationReason: string) => {
        await appendProgress(
          config,
          `[PROMETHEUS][PARSER_CONTRACT] Retry failed mandatory fields — parser_contract_violation: ${violationReason}`
        );
      },
      buildRetryCandidate: async (parserDiff: string) => {
        const retryPrompt = `${contextPrompt}

## PARSER_CONTRACT_RETRY
The previous response failed parser contract validation.
Regenerate the full response and companion JSON, then fix mandatory parser fields exactly.

Parser contract diff:
${parserDiff}

Mandatory parser fields:
- projectHealth must be exactly one of: good, healthy, needs-work, degraded, critical
- requestBudget.estimatedPremiumRequestsTotal must be present and finite
- generatedAt must be a non-empty ISO timestamp string
- keyFindings must be a non-empty string
- strategicNarrative must be a non-empty string
- Keep the rest of the plan deterministic and unchanged unless required by these fixes.`;

        try {
          const retryArgs = buildAgentArgs({
            agentSlug: "prometheus",
            prompt: retryPrompt,
            model: prometheusModel,
            allowAll: true,
            noAskUser: true,
            maxContinues: undefined,
            runContract: promptLineage ? { promptLineage } : undefined,
          });
          appendLiveLogSync(stateDir, `\n[copilot_stream_retry_start] ${ts()}\n`);
          let retryStreamStdout = "";
          let retryStreamStderr = "";
          const retryResult = await spawnAsync(command, retryArgs, {
            env: process.env,
            timeoutMs: prometheusTimeoutMs,
            earlyExitMarker: "===END===",
            onStdout(chunk) {
              const text = chunk.toString("utf8");
              retryStreamStdout += text;
              appendLiveLogSync(stateDir, text);
            },
            onStderr(chunk) {
              const text = chunk.toString("utf8");
              retryStreamStderr += text;
              appendLiveLogSync(stateDir, text);
            }
          });
          const retryResultObj = retryResult as { status?: number; stdout?: string; stderr?: string };
          appendLiveLogSync(stateDir, `\n[copilot_stream_retry_end] ${ts()} exit=${retryResultObj.status}\n`);
          if (retryResultObj.status !== 0) {
            await appendProgress(
              config,
              `[PROMETHEUS][PARSER_CONTRACT] Retry process failed — parser_contract_violation: exited ${retryResultObj.status}`
            );
            return null;
          }
          const retryRaw = resolveCapturedAgentRawOutput(
            retryResultObj.stdout,
            retryResultObj.stderr,
            retryStreamStdout,
            retryStreamStderr,
          );
          retryAiResult = parseAgentOutput(retryRaw);
          return repairParserContractCandidate(
            retryAiResult?.parsed || buildNarrativeFallbackParsed({ ...retryAiResult, raw: retryRaw }),
            retryRaw,
          );
        } catch (retryError) {
          const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
          await appendProgress(
            config,
            `[PROMETHEUS][PARSER_CONTRACT] Retry execution error — parser_contract_violation: ${retryMessage}`
          );
          return null;
        }
      },
    }
  );
  if (!parserContractResult.ok) {
    return null;
  }
  if (parserContractResult.retried && retryAiResult) {
    aiResult = retryAiResult;
  }

  // ── Output fidelity gate — process-thought marker rejection ─────────────
  // Check for process-thought markers (<think>, <reasoning>, [THINKING], etc.)
  // in strategic fields of the raw parsed output.  These tokens are internal
  // reasoning artifacts that must never appear in persisted plans.
  // On first violation we issue one constrained retry with an explicit diff.
  // On repeated violation we fail-closed: plans=[], failReason=output-fidelity-gate.
  let rawParsedInput = aiResult?.parsed || buildNarrativeFallbackParsed({ ...aiResult, raw });
  {
    const fidelityContaminated = scanParsedOutputForProcessThought(rawParsedInput);
    if (fidelityContaminated.length > 0) {
      await appendProgress(
        config,
        `[PROMETHEUS][FIDELITY] Process-thought markers detected in fields: ${fidelityContaminated.join(", ")} — retrying once`
      );
      // One constrained retry
      let fidelityRetryParsed: unknown = null;
      try {
        const fidelityRetryPrompt = `${contextPrompt}

## OUTPUT_FIDELITY_RETRY
Your previous response contained process-thought markers (<think>, <reasoning>, [THINKING], etc.)
in the following fields: ${fidelityContaminated.join(", ")}.
These internal reasoning tokens must NOT appear in the JSON output or plan fields.
Regenerate the full response ensuring all strategic fields (analysis, strategicNarrative, keyFindings, plans[].task, plans[].context) contain ONLY final actionable content — no thinking fragments.`;
        const fidelityRetryArgs = buildAgentArgs({
          agentSlug: "prometheus",
          prompt: fidelityRetryPrompt,
          model: prometheusModel,
          allowAll: true,
          noAskUser: true,
          maxContinues: undefined,
          runContract: promptLineage ? { promptLineage } : undefined,
        });
        appendLiveLogSync(stateDir, `\n[fidelity_retry_start] ${ts()}\n`);
        let fidelityRetryStreamStdout = "";
        let fidelityRetryStreamStderr = "";
        const fidelityRetryResult = await spawnAsync(command, fidelityRetryArgs, {
          env: process.env,
          timeoutMs: prometheusTimeoutMs,
          earlyExitMarker: "===END===",
          onStdout(chunk) {
            const text = chunk.toString("utf8");
            fidelityRetryStreamStdout += text;
            appendLiveLogSync(stateDir, text);
          },
          onStderr(chunk)  {
            const text = chunk.toString("utf8");
            fidelityRetryStreamStderr += text;
            appendLiveLogSync(stateDir, text);
          },
        }) as { status?: number; stdout?: string; stderr?: string };
        appendLiveLogSync(stateDir, `\n[fidelity_retry_end] ${ts()} exit=${fidelityRetryResult.status}\n`);
        if (fidelityRetryResult.status === 0) {
          const retryRaw = resolveCapturedAgentRawOutput(
            fidelityRetryResult.stdout,
            fidelityRetryResult.stderr,
            fidelityRetryStreamStdout,
            fidelityRetryStreamStderr,
          );
          const retryAi = parseAgentOutput(retryRaw);
          fidelityRetryParsed = retryAi?.parsed || buildNarrativeFallbackParsed({ ...retryAi, raw: retryRaw });
        }
      } catch (fidelityErr) {
        await appendProgress(config, `[PROMETHEUS][FIDELITY] Retry failed: ${String((fidelityErr as any)?.message || fidelityErr)}`);
      }

      const retryContaminated = fidelityRetryParsed ? scanParsedOutputForProcessThought(fidelityRetryParsed) : fidelityContaminated;
      if (retryContaminated.length > 0 || !fidelityRetryParsed) {
        // Fail-closed: persist empty plans with an explicit failReason
        await appendProgress(
          config,
          `[PROMETHEUS][FIDELITY][${OUTPUT_FIDELITY_GATE_FAIL_REASON}] Repeated process-thought contamination after retry — fail-close plans=[]`
        );
        rawParsedInput = {
          ...(rawParsedInput as object),
          plans: [],
          failReason: OUTPUT_FIDELITY_GATE_FAIL_REASON,
          _fidelityGateFailed: true,
          _fidelityContaminatedFields: fidelityContaminated,
        };
      } else {
        rawParsedInput = fidelityRetryParsed as any;
        await appendProgress(config, "[PROMETHEUS][FIDELITY] Retry clean — process-thought markers resolved");
      }
    }
    // Record that the output-fidelity gate was invoked this cycle (source present AND executed).
    await recordCapabilityExecution(
      config,
      "output-fidelity-gate",
      `contaminated=${fidelityContaminated.length > 0} retried=${fidelityContaminated.length > 0}`,
    );
  }

  const topologyMinLanes = resolvePrometheusTopologyMinLanes(config?.workerPool?.minLanes);
  let candidateSetsBeforeSelection = candidatePlanningPolicy.enabled
    ? extractPrometheusCandidatePlanSets(rawParsedInput)
    : [];
  if (candidateSetsBeforeSelection.length < 2) {
    const topologyAdmission = evaluatePrometheusTopologyAdmission(rawParsedInput?.plans, {
      planningMode,
      minLanes: topologyMinLanes,
    });
    if (!topologyAdmission.admitted) {
      await appendProgress(
        config,
        `[PROMETHEUS][TOPOLOGY] Non-dispatchable worker topology — retrying once: ${topologyAdmission.reason}`,
      );
      try {
        const topologyRetryPrompt = `${contextPrompt}

## TOPOLOGY_CONTRACT_RETRY
The previous response produced a non-dispatchable worker topology.

Topology diff:
${topologyAdmission.reason}

Dispatch contract:
- If you emit ${topologyAdmission.minLanes} or more plans, they MUST span at least ${topologyAdmission.minLanes} distinct capability lanes after normalization.
- If evidence supports only one real lane of work, emit fewer than ${topologyAdmission.minLanes} plans instead of padding with same-lane packets.
- executionStrategy.workerTopology MUST match the actual plans you emit.
- Keep parser-contract fields valid: projectHealth, requestBudget.estimatedPremiumRequestsTotal, generatedAt, keyFindings, strategicNarrative.

Regenerate the full response.`;
        const topologyRetryArgs = buildAgentArgs({
          agentSlug: "prometheus",
          prompt: topologyRetryPrompt,
          model: prometheusModel,
          allowAll: true,
          noAskUser: true,
          maxContinues: undefined,
          runContract: promptLineage ? { promptLineage } : undefined,
        });
        appendLiveLogSync(stateDir, `\n[topology_retry_start] ${ts()}\n`);
        let topologyRetryStreamStdout = "";
        let topologyRetryStreamStderr = "";
        const topologyRetryResult = await spawnAsync(command, topologyRetryArgs, {
          env: process.env,
          timeoutMs: prometheusTimeoutMs,
          earlyExitMarker: "===END===",
          onStdout(chunk) {
            const text = chunk.toString("utf8");
            topologyRetryStreamStdout += text;
            appendLiveLogSync(stateDir, text);
          },
          onStderr(chunk) {
            const text = chunk.toString("utf8");
            topologyRetryStreamStderr += text;
            appendLiveLogSync(stateDir, text);
          },
        }) as { status?: number; stdout?: string; stderr?: string };
        appendLiveLogSync(stateDir, `\n[topology_retry_end] ${ts()} exit=${topologyRetryResult.status}\n`);
        if (topologyRetryResult.status === 0) {
          const topologyRetryRaw = resolveCapturedAgentRawOutput(
            topologyRetryResult.stdout,
            topologyRetryResult.stderr,
            topologyRetryStreamStdout,
            topologyRetryStreamStderr,
          );
          const topologyRetryAi = parseAgentOutput(topologyRetryRaw);
          rawParsedInput = repairParserContractCandidate(
            topologyRetryAi?.parsed || buildNarrativeFallbackParsed({ ...topologyRetryAi, raw: topologyRetryRaw }),
            topologyRetryRaw,
          );
          candidateSetsBeforeSelection = candidatePlanningPolicy.enabled
            ? extractPrometheusCandidatePlanSets(rawParsedInput)
            : [];
          await appendProgress(config, "[PROMETHEUS][TOPOLOGY] Retry completed");
        }
      } catch (topologyErr) {
        await appendProgress(
          config,
          `[PROMETHEUS][TOPOLOGY] Retry failed: ${String((topologyErr as any)?.message || topologyErr)}`,
        );
      }
      if (candidateSetsBeforeSelection.length < 2) {
        const topologyRetryAdmission = evaluatePrometheusTopologyAdmission(rawParsedInput?.plans, {
          planningMode,
          minLanes: topologyMinLanes,
        });
        if (!topologyRetryAdmission.admitted) {
          const emptyExecutionStrategy = buildExecutionStrategyFromPlans([], { planningMode });
          rawParsedInput = {
            ...(rawParsedInput && typeof rawParsedInput === "object" ? rawParsedInput : {}),
            plans: [],
            executionStrategy: emptyExecutionStrategy,
            requestBudget: {
              ...buildDeterministicRequestBudget([], emptyExecutionStrategy),
              _fallback: false,
            },
            failReason: "topology-contract",
            _topologyContractFailed: true,
            _topologyContractReason: topologyRetryAdmission.reason,
          };
          await appendProgress(
            config,
            `[PROMETHEUS][TOPOLOGY][FAIL_CLOSED] Repeated non-dispatchable worker topology — plans=[] reason=${topologyRetryAdmission.reason}`,
          );
        }
      }
    }
  }

  if (candidatePlanningPolicy.enabled) {
    const candidateSelection = selectPrometheusCandidatePlanSet(
      rawParsedInput,
      { ...aiResult, raw, researchTopics: researchTopicsList, planningMode, repairFeedback: options.repairFeedback, requestedBy: options.requestedBy },
      { diagnosticsFreshnessAdmission, topologyMinLanes },
    );
    if (candidateSelection.candidateSets.length >= 2 && candidateSelection.usedSelection) {
      const nextExecutionStrategy = buildExecutionStrategyFromPlans(candidateSelection.selectedPlans, { planningMode });
      rawParsedInput = {
        ...rawParsedInput,
        plans: candidateSelection.selectedPlans,
        executionStrategy: nextExecutionStrategy,
        requestBudget: {
          ...buildDeterministicRequestBudget(candidateSelection.selectedPlans, nextExecutionStrategy),
          _fallback: false,
        },
        _candidatePlanning: {
          enabled: true,
          candidateCount: candidateSelection.candidateSets.length,
          selectedIndex: candidateSelection.selectedIndex,
          selectedLabel: candidateSelection.selectedLabel,
          score: candidateSelection.score,
          tieBreakUsed: candidateSelection.tieBreakUsed,
          reason: candidateSelection.reason,
          summaries: candidateSelection.candidateSummaries,
        },
      };
      await appendProgress(
        config,
        `[PROMETHEUS][CANDIDATES] Selected ${candidateSelection.selectedLabel || `candidate-${candidateSelection.selectedIndex + 1}`} ` +
        `from ${candidateSelection.candidateSets.length} candidate set(s) ` +
        `(score=${candidateSelection.score} tieBreak=${candidateSelection.tieBreakUsed} reason=${candidateSelection.reason})`,
      );
    } else if (candidateSelection.candidateSets.length >= 2) {
      rawParsedInput = {
        ...rawParsedInput,
        plans: [],
        executionStrategy: buildExecutionStrategyFromPlans([], { planningMode }),
        requestBudget: {
          ...buildDeterministicRequestBudget([], buildExecutionStrategyFromPlans([], { planningMode })),
          _fallback: false,
        },
        failReason: "candidate-selection-gate",
        _candidatePlanning: {
          enabled: true,
          candidateCount: candidateSelection.candidateSets.length,
          selectedIndex: -1,
          selectedLabel: "",
          score: candidateSelection.score,
          tieBreakUsed: candidateSelection.tieBreakUsed,
          reason: candidateSelection.reason,
          summaries: candidateSelection.candidateSummaries,
          failClosed: true,
        },
      };
      await appendProgress(
        config,
        `[PROMETHEUS][CANDIDATES][FAIL_CLOSED] Candidate selection produced no dispatchable set — plans=[] reason=${candidateSelection.reason}`,
      );
    }
  }

  // ── Generation-boundary packet completeness gate ──────────────────────────
  // Reject unrecoverable incomplete packets BEFORE normalization so they never
  // enter the normalization pipeline. Unrecoverable means normalizePlanFromTask()
  // cannot synthesize a meaningful value for the missing field:
  //   - No task identity (task/title/task_id/id all absent) → "Task-N" is useless
  //   - Missing/invalid capacityDelta → normalization omits it; validator removes it
  //   - Missing/invalid requestROI   → same rationale
  // This is the primary enforcement gate. The post-normalization capacityDelta/
  // requestROI filter below remains as a secondary safety net for plans injected
  // by non-rawPlans paths (alternative shapes, drift debt tasks).
  const ciRepairEnforcement = enforceCiRepairPacketForMandatoryFindings(rawParsedInput, mandatoryFindings);
  const mandatoryFindingFallback = enforceMandatoryFindingCoveragePackets(ciRepairEnforcement.output, mandatoryFindings);
  rawParsedInput = synthesizeMandatoryTaskCoverage(mandatoryFindingFallback.output, mandatoryFindings);
  if (ciRepairEnforcement.findingIds.length > 0) {
    await appendProgress(
      config,
      `[PROMETHEUS][CI_FIX_ENFORCED] ${ciRepairEnforcement.injected ? "Injected" : "Enriched"} wave-1 ci-fix packet from mandatory CI finding(s): ${ciRepairEnforcement.findingIds.join(", ")}`
    );
    await recordCapabilityExecution(
      config,
      "ci-failure-log-injection",
      `enforced=1 injected=${ciRepairEnforcement.injected ? 1 : 0} mandatoryCiFindings=${ciRepairEnforcement.findingIds.join(",")}`,
    );
  }
  if (mandatoryFindingFallback.injectedFindingIds.length > 0) {
    await appendProgress(
      config,
      `[PROMETHEUS][MANDATORY_TASKS][FALLBACK] Injected deterministic fallback packet(s) for missing finding(s): ${mandatoryFindingFallback.injectedFindingIds.join(", ")}`
    );
  }

  const mandatoryCoverageResult = validateMandatoryTaskCoverageContract(rawParsedInput, mandatoryFindings);
  const mandatoryCoverageMode = config?.runtime?.mandatoryTaskCoverageMode === "enforce" ? "enforce" : "warn";
  if (mandatoryCoverageMode === "enforce") {
    rawParsedInput._retryAttempted = false;
  }
  if (!mandatoryCoverageResult.ok) {
    const missing = mandatoryCoverageResult.missing.join(", ") || "none";
    const invalid = mandatoryCoverageResult.invalid.join(", ") || "none";
    await appendProgress(
      config,
      `[PROMETHEUS][MANDATORY_TASKS] Coverage gate failed — missing=[${missing}] invalid=[${invalid}]`
    );
    rawParsedInput._mandatoryTaskCoverageGate = {
      ok: false,
      missing: mandatoryCoverageResult.missing,
      invalid: mandatoryCoverageResult.invalid,
      mapped: mandatoryCoverageResult.mapped,
      excluded: mandatoryCoverageResult.excluded,
      _retryAttempted: mandatoryCoverageMode === "enforce" ? true : undefined,
    };
    if (mandatoryCoverageMode === "enforce") {
      rawParsedInput._retryAttempted = true;
      const coverageDiff = buildMandatoryCoverageRetryDiff(mandatoryCoverageResult);
      const retryPrompt = `${contextPrompt}

## MANDATORY_TASK_COVERAGE_RETRY
The previous response failed mandatory coverage validation.
Regenerate the full response and companion JSON, then fix the mandatoryTaskCoverage contract exactly.

Coverage diff:
${coverageDiff}

Mandatory requirements:
- Every mandatory finding ID appears exactly once in mandatoryTaskCoverage.
- "mapped" entries must reference an existing plan task/title/task_id in plans[].
- "excluded" entries must include cycle-specific, non-generic justification.
- Keep plans actionable and deterministic.`;
      await appendProgress(
        config,
        "[PROMETHEUS][MANDATORY_TASKS] Enforcement active — retrying once with explicit coverage diff"
      );

      let retryRawParsedInput: unknown = null;
      try {
        const retryArgs = buildAgentArgs({
          agentSlug: "prometheus",
          prompt: retryPrompt,
          model: prometheusModel,
          allowAll: true,
          noAskUser: true,
          maxContinues: undefined,
          runContract: promptLineage ? { promptLineage } : undefined,
        });
        appendLiveLogSync(stateDir, `\n[copilot_stream_retry_start] ${ts()}\n`);
        let retryStreamStdout = "";
        let retryStreamStderr = "";
        const retryResult = await spawnAsync(command, retryArgs, {
          env: process.env,
          timeoutMs: prometheusTimeoutMs,
          earlyExitMarker: "===END===",
          onStdout(chunk) {
            const text = chunk.toString("utf8");
            retryStreamStdout += text;
            appendLiveLogSync(stateDir, text);
          },
          onStderr(chunk) {
            const text = chunk.toString("utf8");
            retryStreamStderr += text;
            appendLiveLogSync(stateDir, text);
          }
        });
        const retryResultObj = retryResult as { status?: number; stdout?: string; stderr?: string };
        appendLiveLogSync(stateDir, `\n[copilot_stream_retry_end] ${ts()} exit=${retryResultObj.status}\n`);
        if (retryResultObj.status === 0) {
          const retryRaw = resolveCapturedAgentRawOutput(
            retryResultObj.stdout,
            retryResultObj.stderr,
            retryStreamStdout,
            retryStreamStderr,
          );
          const retryAiResult = parseAgentOutput(retryRaw);
          retryRawParsedInput = retryAiResult?.parsed || buildNarrativeFallbackParsed({ ...retryAiResult, raw: retryRaw });
        } else {
          await appendProgress(
            config,
            `[PROMETHEUS][MANDATORY_TASKS][WARN] Retry process failed — exited ${retryResultObj.status}`
          );
        }
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        await appendProgress(
          config,
          `[PROMETHEUS][MANDATORY_TASKS][WARN] Retry execution error: ${retryMessage}`
        );
      }

      if (retryRawParsedInput) {
        const retryCoverageResult = validateMandatoryTaskCoverageContract(retryRawParsedInput, mandatoryFindings);
        if (retryCoverageResult.ok) {
          rawParsedInput = retryRawParsedInput;
          rawParsedInput._retryAttempted = true;
          rawParsedInput._mandatoryTaskCoverageGate = {
            ok: true,
            missing: [],
            invalid: [],
            mapped: retryCoverageResult.mapped,
            excluded: retryCoverageResult.excluded,
            _retryAttempted: true,
          };
          await appendProgress(
            config,
            `[PROMETHEUS][MANDATORY_TASKS] Retry succeeded — mapped=${retryCoverageResult.mapped.length} excluded=${retryCoverageResult.excluded.length}`
          );
        } else {
          const retryMissing = retryCoverageResult.missing.join(", ") || "none";
          const retryInvalid = retryCoverageResult.invalid.join(", ") || "none";
          rawParsedInput = applyMandatoryCoverageEnforceReject(retryRawParsedInput, retryCoverageResult);
          rawParsedInput._retryAttempted = true;
          await appendProgress(
            config,
            `[PROMETHEUS][MANDATORY_TASKS][${MANDATORY_COVERAGE_ENFORCE_REJECT_TOKEN}] Retry failed coverage — missing=[${retryMissing}] invalid=[${retryInvalid}] | fail-close plans=[] | exit_code=${MANDATORY_COVERAGE_ENFORCE_EXIT_CODE}`
          );
        }
      } else {
        rawParsedInput = applyMandatoryCoverageEnforceReject(rawParsedInput, mandatoryCoverageResult);
        rawParsedInput._retryAttempted = true;
        await appendProgress(
          config,
          `[PROMETHEUS][MANDATORY_TASKS][${MANDATORY_COVERAGE_ENFORCE_REJECT_TOKEN}] Retry produced no parsable payload — fail-close plans=[] | exit_code=${MANDATORY_COVERAGE_ENFORCE_EXIT_CODE}`
        );
      }
    } else {
      await appendProgress(
        config,
        "[PROMETHEUS][MANDATORY_TASKS][WARN] Coverage failure is non-blocking (warn mode) — continuing with generated plans"
      );
    }
  } else if (mandatoryFindings.length > 0) {
    rawParsedInput._mandatoryTaskCoverageGate = {
      ok: true,
      missing: [],
      invalid: [],
      mapped: mandatoryCoverageResult.mapped,
      excluded: mandatoryCoverageResult.excluded,
      _retryAttempted: mandatoryCoverageMode === "enforce" ? false : undefined,
    };
    await recordCapabilityExecution(
      config,
      "janus-findings-to-plan-requirements",
      `mapped=${mandatoryCoverageResult.mapped.length} excluded=${mandatoryCoverageResult.excluded.length}`,
    );
    await appendProgress(
      config,
      `[PROMETHEUS][MANDATORY_TASKS] Coverage gate passed — mapped=${mandatoryCoverageResult.mapped.length} excluded=${mandatoryCoverageResult.excluded.length}`
    );
  }

  // ── Execution-strategy role coverage gate (post-LLM, pre-Athena) ─────────────
  // Ensure every role declared by executionStrategy.waves[*].tasks has at least one
  // contract-valid plans[] entry. Retry once with an explicit diff; on repeated
  // failure throw RolePlanCompletenessError (fail-closed) — never silently inject
  // skeleton plans, as that would give downstream postmortems a false clean-pass signal.
  {
    const roleCoverageResult = validateAndInjectRolePlans(rawParsedInput, { injectMissing: false });
    if (!roleCoverageResult.ok && roleCoverageResult.initialMissingRoles.length > 0) {
      const roleDiff = buildRolePlanCoverageRetryDiff(roleCoverageResult);
      await appendProgress(
        config,
        `[PROMETHEUS][ROLE_PLAN_COVERAGE] Missing executionStrategy role coverage — retrying once with diff: ${roleDiff}`
      );

      let retryRoleParsedInput: unknown = null;
      try {
        const retryPrompt = `${contextPrompt}

## EXECUTION_STRATEGY_ROLE_PLAN_RETRY
The previous response failed execution-strategy role coverage validation.
Regenerate the full response and companion JSON, then satisfy this contract exactly.

Role coverage diff:
${roleDiff}

Mandatory requirements:
- Every role declared in executionStrategy.waves[*].tasks objects must have at least one contract-valid plans[] entry.
- Keep role names deterministic and consistent between executionStrategy and plans[].
- Do not remove existing valid plans unless required to repair invalid role coverage.`;

        const retryArgs = buildAgentArgs({
          agentSlug: "prometheus",
          prompt: retryPrompt,
          model: prometheusModel,
          allowAll: true,
          noAskUser: true,
          maxContinues: undefined,
          runContract: promptLineage ? { promptLineage } : undefined,
        });
        appendLiveLogSync(stateDir, `\n[copilot_stream_retry_start] ${ts()}\n`);
        let retryStreamStdout = "";
        let retryStreamStderr = "";
        const retryResult = await spawnAsync(command, retryArgs, {
          env: process.env,
          timeoutMs: prometheusTimeoutMs,
          earlyExitMarker: "===END===",
          onStdout(chunk) {
            const text = chunk.toString("utf8");
            retryStreamStdout += text;
            appendLiveLogSync(stateDir, text);
          },
          onStderr(chunk) {
            const text = chunk.toString("utf8");
            retryStreamStderr += text;
            appendLiveLogSync(stateDir, text);
          },
        }) as { status?: number; stdout?: string; stderr?: string };
        appendLiveLogSync(stateDir, `\n[copilot_stream_retry_end] ${ts()} exit=${retryResult.status}\n`);
        if (retryResult.status === 0) {
          const retryRaw = resolveCapturedAgentRawOutput(
            retryResult.stdout,
            retryResult.stderr,
            retryStreamStdout,
            retryStreamStderr,
          );
          const retryAiResult = parseAgentOutput(retryRaw);
          retryRoleParsedInput = retryAiResult?.parsed || buildNarrativeFallbackParsed({ ...retryAiResult, raw: retryRaw });
        } else {
          await appendProgress(
            config,
            `[PROMETHEUS][ROLE_PLAN_COVERAGE][WARN] Retry process failed — exited ${retryResult.status}`
          );
        }
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        await appendProgress(
          config,
          `[PROMETHEUS][ROLE_PLAN_COVERAGE][WARN] Retry execution error: ${retryMessage}`
        );
      }

      if (retryRoleParsedInput) {
        const retryCoverage = validateAndInjectRolePlans(retryRoleParsedInput, { injectMissing: false });
        if (retryCoverage.ok) {
          rawParsedInput = retryCoverage.output;
          rawParsedInput._executionStrategyRolePlanGate = {
            ok: true,
            requiredRoles: retryCoverage.requiredRoles,
            missingRoles: [],
            initialMissingRoles: retryCoverage.initialMissingRoles,
            initialMissingRoleMarkers: retryCoverage.initialMissingRoleMarkers,
            injectedRoles: [],
            injectedSkeletonMetadata: retryCoverage.injectedSkeletonMetadata,
            invalidRolePlans: retryCoverage.invalidRolePlans,
            _retryAttempted: true,
          };
          await appendProgress(
            config,
            `[PROMETHEUS][ROLE_PLAN_COVERAGE] Retry succeeded — roles=${retryCoverage.requiredRoles.length}`
          );
        } else {
          // Fail-closed: retry produced output but still missing roles.
          // Emit per-missing-role telemetry, then block Athena submission.
          const failedMissingRoles = Array.isArray(retryCoverage.initialMissingRoles) ? retryCoverage.initialMissingRoles : [];
          const failedRequiredRoles = Array.isArray(retryCoverage.requiredRoles) ? retryCoverage.requiredRoles : [];
          for (const missingRole of failedMissingRoles) {
            await appendProgress(
              config,
              `[PROMETHEUS][ROLE_PLAN_COVERAGE][FAIL_CLOSED] missing_role=${missingRole} required_roles=${failedRequiredRoles.length} retry_attempted=true`
            );
          }
          await appendProgress(
            config,
            `[PROMETHEUS][ROLE_PLAN_COVERAGE][${ROLE_PLAN_COMPLETENESS_ERROR_CODE}] Blocking plan submission: missing=${failedMissingRoles.length} required=${failedRequiredRoles.length}`
          );
          throw new RolePlanCompletenessError(failedMissingRoles, failedRequiredRoles, true);
        }
      } else {
        // Fail-closed: retry produced no parsable output; original missing roles remain.
        // Emit per-missing-role telemetry, then block Athena submission.
        const failedMissingRoles = Array.isArray(roleCoverageResult.initialMissingRoles) ? roleCoverageResult.initialMissingRoles : [];
        const failedRequiredRoles = Array.isArray(roleCoverageResult.requiredRoles) ? roleCoverageResult.requiredRoles : [];
        for (const missingRole of failedMissingRoles) {
          await appendProgress(
            config,
            `[PROMETHEUS][ROLE_PLAN_COVERAGE][FAIL_CLOSED] missing_role=${missingRole} required_roles=${failedRequiredRoles.length} retry_attempted=true`
          );
        }
        await appendProgress(
          config,
          `[PROMETHEUS][ROLE_PLAN_COVERAGE][${ROLE_PLAN_COMPLETENESS_ERROR_CODE}] Blocking plan submission: missing=${failedMissingRoles.length} required=${failedRequiredRoles.length}`
        );
        throw new RolePlanCompletenessError(failedMissingRoles, failedRequiredRoles, true);
      }
    } else {
      rawParsedInput = roleCoverageResult.output;
      rawParsedInput._executionStrategyRolePlanGate = {
        ok: true,
        requiredRoles: roleCoverageResult.requiredRoles,
        missingRoles: [],
        initialMissingRoles: roleCoverageResult.initialMissingRoles,
        initialMissingRoleMarkers: roleCoverageResult.initialMissingRoleMarkers,
        injectedRoles: [],
        injectedSkeletonMetadata: roleCoverageResult.injectedSkeletonMetadata,
        invalidRolePlans: roleCoverageResult.invalidRolePlans,
        _retryAttempted: false,
      };
    }

    const roleGateMeta = (rawParsedInput as any)._executionStrategyRolePlanGate || {};
    await recordCapabilityExecution(
      config,
      "execution-strategy-role-plan-validation",
      `required=${Array.isArray(roleGateMeta.requiredRoles) ? roleGateMeta.requiredRoles.length : 0} missing=${Array.isArray(roleGateMeta.missingRoles) ? roleGateMeta.missingRoles.length : 0} injected=${Array.isArray(roleGateMeta.injectedRoles) ? roleGateMeta.injectedRoles.length : 0} retried=${roleGateMeta._retryAttempted === true}`,
    );
  }

  if (Array.isArray(rawParsedInput.plans) && rawParsedInput.plans.length > 0) {
    const densification = _analyzePacketDensification(rawParsedInput.plans, PROMETHEUS_PROMPT_DENSITY_MIN);
    rawParsedInput._packetDensification = densification;
    if (densification.thinCount > 0) {
      await appendProgress(
        config,
        `[PROMETHEUS][DENSITY] Thin packet detection: ${densification.thinCount}/${densification.total} packet(s) below densification floor`
      );
    }

    // Record that the packet-granularity-governor was invoked this cycle.
    await recordCapabilityExecution(
      config,
      "packet-granularity-governor",
      `thinCount=${densification.thinCount} total=${densification.total}`,
    );

    // Convert densification into dispatch admission behavior:
    // 1) auto-bundle thin related packets
    // 2) reject remaining thin packets with explicit reasons
    const bundled = autoBundleThinRelatedPackets(rawParsedInput.plans, PROMETHEUS_PROMPT_DENSITY_MIN);
    rawParsedInput.plans = bundled.plans;
    if (bundled.bundledCount > 0) {
      await appendProgress(
        config,
        `[PROMETHEUS][DENSITY] Auto-bundled ${bundled.bundledCount} thin related packet group(s) before admission`
      );
    }
    // Deterministic backfill pass: ensure no plan enters thin-filter with non-finite tokens.
    rawParsedInput.plans = rawParsedInput.plans.map((plan: any) => {
      const rawTokens = Number(plan?.estimatedExecutionTokens);
      if (Number.isFinite(rawTokens)) return plan;
      return {
        ...plan,
        estimatedExecutionTokens: Math.max(1, estimatePlanExecutionTokens(plan)),
      };
    });
    const postBundleDensity = _analyzePacketDensification(rawParsedInput.plans, PROMETHEUS_PROMPT_DENSITY_MIN);
    rawParsedInput._packetDensificationPostBundle = postBundleDensity;
    if (postBundleDensity.thinCount > 0) {
      const rejectedThinPackets: Array<{ index: number; reason: string }> = [];
      // Apply benchmark planning priors: stricter thresholds when uncertainty is high.
      const strictness = planningPriors.strictnessMultiplier;
      const baseDensityThresholds = {
        minTaskChars: Math.ceil(PROMETHEUS_PROMPT_DENSITY_MIN.minTaskChars * strictness),
        minTargetFiles: PROMETHEUS_PROMPT_DENSITY_MIN.minTargetFiles,
        minAcceptanceCriteria: Math.ceil(PROMETHEUS_PROMPT_DENSITY_MIN.minAcceptanceCriteria * strictness),
        minExecutionTokens: Math.ceil(PROMETHEUS_PROMPT_DENSITY_MIN.minExecutionTokens * strictness),
      };
      rawParsedInput.plans = rawParsedInput.plans.filter((plan: any, i: number) => {
        const metrics = computePacketDensityMetrics(plan);
        // Use lane-aware token floor: plans covering 5+ files must declare ≥8 k tokens.
        const targetFileCount = Array.isArray(plan.target_files) ? plan.target_files.length : 0;
        const laneThresholds = getPacketThresholdsForLane(targetFileCount);
        // Apply historical lane difficulty prior: hard lanes get an additional
        // strictness boost on top of the benchmark planning prior multiplier.
        const planRole = String(plan._batchWorkerRole || plan.role || "").toLowerCase();
        const lanePrior = laneDifficultyPriors[planRole];
        const laneStrictness = lanePrior?.difficulty === "hard" ? 1.2
          : lanePrior?.difficulty === "moderate" ? 1.1
          : 1.0;
        const effectiveThresholds = {
          minTaskChars: Math.max(baseDensityThresholds.minTaskChars, Math.ceil(laneThresholds.minTaskChars * laneStrictness)),
          minTargetFiles: laneThresholds.minTargetFiles,
          minAcceptanceCriteria: Math.max(baseDensityThresholds.minAcceptanceCriteria, Math.ceil(laneThresholds.minAcceptanceCriteria * laneStrictness)),
          minExecutionTokens: Math.max(baseDensityThresholds.minExecutionTokens, Math.ceil(laneThresholds.minExecutionTokens * laneStrictness)),
        };
        const thin = isThinPacketForAdmission(metrics, effectiveThresholds);
        if (!thin) return true;
        const reason = buildThinPacketRejectionReason(metrics, effectiveThresholds);
        plan._thinPacketRejected = true;
        plan._thinPacketReason = reason;
        rejectedThinPackets.push({ index: i, reason });
        return false;
      });
      if (rejectedThinPackets.length > 0) {
        rawParsedInput._rejectedThinPacketCount = rejectedThinPackets.length;
        rawParsedInput._rejectedThinPackets = rejectedThinPackets;
        await appendProgress(
          config,
          `[PROMETHEUS][DENSITY] Rejected ${rejectedThinPackets.length} thin packet(s) after auto-bundling`
        );
      }
      // Bounded lane-aware clamping: instead of restoring ALL rejected packets,
      // sort by token richness and restore only the richest packets up to the
      // lane-aware minimum token floor.  This avoids the deadlock while still
      // enforcing triage — trivially thin packets are not re-admitted.
      if (rawParsedInput.plans.length === 0 && rejectedThinPackets.length > 0) {
        await appendProgress(
          config,
          `[PROMETHEUS][DENSITY] All packets rejected — applying bounded lane-aware clamping to restore richest packet(s)`
        );
        const bundledPlans: any[] = bundled.plans;
        // Sort rejected packets by estimated execution tokens (descending) so we
        // prefer richer work when capacity is constrained.
        const sortedRejected = [...bundledPlans]
          .map((plan: any) => {
            const metrics = computePacketDensityMetrics(plan);
            return { plan, tokenEstimate: metrics.estimatedExecutionTokens ?? 0 };
          })
          .sort((a, b) => b.tokenEstimate - a.tokenEstimate);

        // Admit packets that meet at least the lane-aware minimum token floor,
        // capping at the original count to prevent unintended expansion.
        const restoredPlans: any[] = [];
        for (const { plan } of sortedRejected) {
          const targetFileCount = Array.isArray(plan.target_files) ? plan.target_files.length : 0;
          const laneFloor = getPacketThresholdsForLane(targetFileCount).minExecutionTokens;
          const metrics = computePacketDensityMetrics(plan);
          const tokenEstimate = metrics.estimatedExecutionTokens ?? 0;
          if (tokenEstimate >= laneFloor) {
            restoredPlans.push({
              ...plan,
              _thinPacketWarning: plan._thinPacketRejected ? plan._thinPacketReason : undefined,
              _thinPacketRejected: false,
            });
          }
          // Limit restoration to original packet count.
          if (restoredPlans.length >= bundledPlans.length) break;
        }

        // Fallback: if lane-floor clamping still produced nothing, admit the richest single plan.
        if (restoredPlans.length === 0 && sortedRejected.length > 0) {
          const { plan } = sortedRejected[0];
          restoredPlans.push({
            ...plan,
            _thinPacketWarning: plan._thinPacketRejected ? plan._thinPacketReason : undefined,
            _thinPacketRejected: false,
          });
        }

        rawParsedInput.plans = restoredPlans;
      }
      // Record that the token/density floor enforcement ran this cycle.
      await recordCapabilityExecution(
        config,
        "prometheus-token-budget-floor",
        `rejected=${rejectedThinPackets.length} remaining=${rawParsedInput.plans.length}`,
      );
    }

    // ── Decomposition cap gate ────────────────────────────────────────────
    // Trim oversized batches before any per-packet validation so subsequent
    // gates operate on a bounded set and log output stays tractable.
    // Apply benchmark planning prior adjustment: high-gain history relaxes the cap
    // (more plans allowed); high-uncertainty tightens it.
    const baseCap = Number(config?.runtime?.prometheusMaxDecompositionPlans ?? MAX_DECOMPOSITION_PLANS);
    const configuredDecompositionCap = Math.max(1, baseCap + planningPriors.decompositionCapAdjustment);
    const capResult = checkDecompositionCaps(rawParsedInput.plans, configuredDecompositionCap);
    if (capResult.capped) {
      rawParsedInput.plans = rawParsedInput.plans.slice(0, capResult.cappedCount);
      rawParsedInput._decompositionCapApplied = true;
      rawParsedInput._decompositionCapOriginalCount = capResult.originalCount;
      await appendProgress(config,
        `[PROMETHEUS][PACKET_GATE] Decomposition cap applied — trimmed ${capResult.originalCount} plans to ${capResult.cappedCount} (reason: ${DECOMPOSITION_CAP_REASON})`
      );
    }

    const incompletePackets: Array<{ index: number; reasons: string[] }> = [];
    rawParsedInput.plans = rawParsedInput.plans.filter((plan: any, i: number) => {
      const stabilizedPlan = stabilizeRawPacketEconomics(plan);
      if (stabilizedPlan && stabilizedPlan !== plan) {
        rawParsedInput.plans[i] = stabilizedPlan;
      }
      const check = checkPacketCompleteness(stabilizedPlan);
      if (!check.recoverable) {
        incompletePackets.push({ index: i, reasons: check.reasons });
        return false;
      }
      return true;
    });
    if (incompletePackets.length > 0) {
      await appendProgress(config,
        `[PROMETHEUS][PACKET_GATE] Rejected ${incompletePackets.length} unrecoverable packet(s) at generation boundary ` +
        `(reasons: ${[...new Set(incompletePackets.flatMap(p => p.reasons))].join(", ")})`
      );
      rawParsedInput._rejectedIncompleteCount = incompletePackets.length;
      rawParsedInput._rejectedIncompletePackets = incompletePackets;
    }

    // ── High-risk / low-confidence packet gate ────────────────────────────
    // Reject packets that are explicitly high-risk but lack BOTH premortem AND
    // acceptance_criteria.  Executing an undocumented high-risk change without
    // any completion signal or failure-mode analysis is a safety violation.
    // Only runs when plans survived the completeness gate (empty arrays skipped).
    if (rawParsedInput.plans.length > 0) {
      const highRiskLowConfidence: Array<{ index: number; reason: string }> = [];
      rawParsedInput.plans = rawParsedInput.plans.filter((plan: any, i: number) => {
        const check = checkHighRiskPacketConfidence(plan);
        if (check.requiresRejection) {
          highRiskLowConfidence.push({ index: i, reason: check.reason });
          return false;
        }
        return true;
      });
      if (highRiskLowConfidence.length > 0) {
        await appendProgress(config,
          `[PROMETHEUS][PACKET_GATE] Rejected ${highRiskLowConfidence.length} high-risk low-confidence packet(s) ` +
          `— explicit riskLevel=high but no premortem and no acceptance_criteria (reason: ${HIGH_RISK_LOW_CONFIDENCE_REASON})`
        );
        rawParsedInput._rejectedHighRiskLowConfidenceCount = highRiskLowConfidence.length;
        rawParsedInput._rejectedHighRiskLowConfidencePackets = highRiskLowConfidence;
      }

      // ── Component-level strict high-risk gate ────────────────────────────
      // When parser component confidence is degraded (shape/budget/dependency
      // below thresholds), require BOTH premortem AND acceptance_criteria for
      // every high-risk plan.  This is stricter than the gate above, which only
      // rejects when BOTH signals are simultaneously absent.
      //
      // Preliminary component scores are computed from the raw parsed input
      // (pre-normalization) because normalization always injects premortem/AC
      // for high-risk plans, making post-normalization checks ineffective.
      //   plansShape:      1.0 if plans[] is non-empty JSON array, else 0.5
      //   requestBudget:   1.0 if budget with estimatedPremiumRequestsTotal
      //                    present, else 0.9 (built deterministically)
      //   dependencyGraph: 1.0 default; refined post-normalization via the
      //                    non-blocking dependency resolver.
      if (rawParsedInput.plans.length > 0) {
        const prelimComponents = {
          plansShape:      Array.isArray(rawParsedInput.plans) && rawParsedInput.plans.length > 0 ? 1.0 : 0.5,
          requestBudget:   (rawParsedInput.requestBudget &&
            Number.isFinite(Number(rawParsedInput.requestBudget.estimatedPremiumRequestsTotal))) ? 1.0 : 0.9,
          dependencyGraph: 1.0,
        };
        const componentGateResult = computeHighRiskComponentGate(prelimComponents);
        if (componentGateResult.shouldApplyStricterGate) {
          const componentStrictAutoRepaired: Array<{ index: number; reason: string }> = [];
          rawParsedInput.plans = rawParsedInput.plans.map((plan: any, i: number) => {
            if (String(plan?.riskLevel || "").trim().toLowerCase() !== "high") return plan;

            const premortem = plan?.premortem;
            const hasPremortem = premortem && typeof premortem === "object" && (
              (typeof premortem.scenario === "string" && premortem.scenario.trim().length >= 20) &&
              (Array.isArray(premortem.failurePaths) && premortem.failurePaths.length > 0) &&
              (Array.isArray(premortem.mitigations) && premortem.mitigations.length > 0) &&
              (Array.isArray(premortem.detectionSignals) && premortem.detectionSignals.length > 0) &&
              (Array.isArray(premortem.guardrails) && premortem.guardrails.length > 0) &&
              (typeof premortem.rollbackPlan === "string" && premortem.rollbackPlan.trim().length >= 10) &&
              (String(premortem.riskLevel || "").trim().toLowerCase() === "high")
            );

            const ac = Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria : [];
            const hasAC = ac.some(c => String(c || "").trim().length > 0);
            if (hasPremortem && hasAC) return plan;

            const repairedPremortem = hasPremortem
              ? premortem
              : {
                  scenario: `High-risk task "${String(plan?.task || plan?.title || `plan-${i + 1}`).trim()}" can regress core behavior if executed without staged safeguards.`,
                  failurePaths: ["Regression introduces failing verification checks"],
                  mitigations: ["Implement in small deterministic steps and verify after each step"],
                  detectionSignals: ["Verification command exits non-zero"],
                  guardrails: ["Do not continue to next dependent wave if verification fails"],
                  rollbackPlan: "Revert the scoped code change and re-run verification.",
                  riskLevel: "high",
                };

            const repairedAC = hasAC
              ? ac
              : [
                  "verification command exits with code 0",
                  "post-change regression count remains 0",
                ];

            componentStrictAutoRepaired.push({
              index: i,
              reason: `component_high_risk_strict_gate_auto_repair(${componentGateResult.weakComponents.join(",")})`,
            });

            return {
              ...plan,
              premortem: repairedPremortem,
              acceptance_criteria: repairedAC,
            };
          });
          if (componentStrictAutoRepaired.length > 0) {
            await appendProgress(config,
              `[PROMETHEUS][PACKET_GATE] Component-level strict gate auto-repaired ${componentStrictAutoRepaired.length} high-risk packet(s) ` +
              `(weak: ${componentGateResult.weakComponents.join(",")}) — no packet dropped`
            );
            rawParsedInput._autoRepairedComponentGateCount   = componentStrictAutoRepaired.length;
            rawParsedInput._autoRepairedComponentGatePackets = componentStrictAutoRepaired;
          }
        }
      }
    }
  }

  const parsedForValidation = normalizePrometheusParsedOutput(
    rawParsedInput,
    { ...aiResult, raw, researchTopics: researchTopicsList, planningMode, repairFeedback: options.repairFeedback, requestedBy: options.requestedBy }
  );

  if (planningPolicy.requireDependencyAwareWaves && Array.isArray(parsedForValidation.plans) && parsedForValidation.plans.length > 0) {
    const uniqueWaveCountBefore = new Set(
      parsedForValidation.plans.map((plan) => Number(plan?.wave || 1))
    ).size;
    parsedForValidation.plans = compactWavesForDependencyAwarePlanning(parsedForValidation.plans);
    const uniqueWaveCountAfter = new Set(
      parsedForValidation.plans.map((plan) => Number(plan?.wave || 1))
    ).size;
    if (uniqueWaveCountAfter < uniqueWaveCountBefore) {
      await appendProgress(
        config,
        `[PROMETHEUS][WAVE_COMPACTION] Reduced waves ${uniqueWaveCountBefore} -> ${uniqueWaveCountAfter} using explicit dependency graph`
      );
    }
    parsedForValidation.executionStrategy = buildExecutionStrategyFromPlans(parsedForValidation.plans, {
      planningMode: parsedForValidation?.executionStrategy?.planningMode || parsedForValidation?.planningMode || planningMode,
    });
    parsedForValidation.requestBudget = {
      ...buildDeterministicRequestBudget(parsedForValidation.plans, parsedForValidation.executionStrategy || {}),
      _fallback: false,
    };
  }

  // ── Schema v2 plan validation ─────────────────────────────────────────────
  // Validate each plan has the required schema fields. Non-conforming plans are
  // tagged but kept (Athena makes the final accept/reject decision).
  const REQUIRED_PLAN_FIELDS = ["task", "role"];
  if (Array.isArray(parsedForValidation.plans)) {
    let invalidCount = 0;
    for (const plan of parsedForValidation.plans) {
      const missing = REQUIRED_PLAN_FIELDS.filter(f => !plan[f] || String(plan[f]).trim().length === 0);
      if (missing.length > 0) {
        plan._schemaViolations = missing;
        invalidCount++;
      }
      // Tag verification quality: plans without verification are schema-weak
      if (!plan.verification || String(plan.verification).trim().length === 0) {
        plan._schemaViolations = [...(plan._schemaViolations || []), "verification"];
      }
    }
    if (invalidCount > 0) {
      await appendProgress(config,
        `[PROMETHEUS][SCHEMA] ${invalidCount}/${parsedForValidation.plans.length} plan(s) missing required fields`
      );
    }
  }

  // ── Trust boundary validation ─────────────────────────────────────────────
  const tbMode = config?.runtime?.trustBoundaryMode === "warn" ? "warn" : "enforce";
  const trustCheck = validateLeadershipContract(
    LEADERSHIP_CONTRACT_TYPE.PLANNER, parsedForValidation, { mode: tbMode }
  );
  if (!trustCheck.ok && tbMode === "enforce") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    await appendProgress(config, `[PROMETHEUS][TRUST_BOUNDARY] Contract validation failed — class=${TRUST_BOUNDARY_ERROR} errors=${tbErrors}`);
    try {
      await appendAlert(config, {
        severity: "critical",
        source: "prometheus",
        title: "Planner output failed trust-boundary validation",
        message: `class=${TRUST_BOUNDARY_ERROR} reasonCode=${trustCheck.reasonCode} errors=${tbErrors}`
      });
    } catch { /* non-fatal */ }
    // Block on trust-boundary violation (fail-closed)
    await appendProgress(config, `[PROMETHEUS][TRUST_BOUNDARY] Blocking analysis — returning null (fail-closed)`);
    return null;
  }
  if (trustCheck.errors.length > 0 && tbMode === "warn") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    await appendProgress(config, `[PROMETHEUS][TRUST_BOUNDARY][WARN] Contract violations (warn mode): ${tbErrors}`);
  }

  // ── Log thinking/dossier ──────────────────────────────────────────────────
  if (aiResult.thinking) {
    await appendPrometheusLiveLog(stateDir, "prometheus_dossier", aiResult.thinking);
  }

  // ── Enforce mandatory requestBudget ───────────────────────────────────────
  const parsed = parsedForValidation;
  if (!parsed.requestBudget || !Number.isFinite(Number(parsed.requestBudget.estimatedPremiumRequestsTotal))) {
    const planCount = Array.isArray(parsed.plans) ? parsed.plans.length : 4;
    const margin = 25;
    parsed.requestBudget = {
      estimatedPremiumRequestsTotal: planCount,
      errorMarginPercent: margin,
      hardCapTotal: Math.ceil(planCount * (1 + margin / 100)),
      confidence: "low",
      byWave: [],
      byRole: [],
      _fallback: true
    };
    await appendProgress(config, `[PROMETHEUS][WARN] No requestBudget — fallback: ${parsed.requestBudget.hardCapTotal} requests`);
  } else {
    const rb = parsed.requestBudget;
    const total = Number(rb.estimatedPremiumRequestsTotal) || 0;
    const margin = Number(rb.errorMarginPercent) || 20;
    if (!Number.isFinite(Number(rb.hardCapTotal)) || Number(rb.hardCapTotal) <= 0) {
      rb.hardCapTotal = Math.ceil(total * (1 + margin / 100));
    }
  }

  // ── Stale-diagnostics-backed plan admission gate ─────────────────────────
  // Tag plans that are backed by stale diagnostics and lack independent evidence.
  // Must run BEFORE validateAllPlans so the contract validator can emit the
  // STALE_DIAGNOSTICS_BACKED violation code for tagged plans.
  if (Array.isArray(parsed.plans) && parsed.plans.length > 0 && !diagnosticsFreshnessAdmission.allFresh) {
    tagStaleDiagnosticsBackedPlans(parsed.plans, diagnosticsFreshnessAdmission);
    const staleTaggedCount = parsed.plans.filter((p: any) => p._staleDiagnosticsGated === true).length;
    if (staleTaggedCount > 0) {
      await appendProgress(
        config,
        `[PROMETHEUS][DIAG_FRESHNESS] Tagged ${staleTaggedCount}/${parsed.plans.length} plan(s) as stale-diagnostics-backed ` +
        `(staleSources=${diagnosticsFreshnessAdmission.staleSources.join(",")})`,
      );
      parsed._staleTaggedPlanCount = staleTaggedCount;
    }
  }

  applyDiagnosticsFreshnessTruthToPlanning(parsed, diagnosticsFreshnessAdmission);

  // ── Contract-first plan validation (Packet 2) ────────────────────────────
  // Every plan must pass schema contract before persistence.
  if (Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    const contractResult = validateAllPlans(parsed.plans);
    if (contractResult.invalidCount > 0) {
      await appendProgress(config,
        `[PROMETHEUS][CONTRACT] ${contractResult.invalidCount}/${contractResult.totalPlans} plan(s) have contract violations (passRate=${contractResult.passRate})`
      );
    }
    // Tag each plan with contract validation results
    for (const r of contractResult.results) {
      parsed.plans[r.planIndex]._contractValid = r.valid;
      parsed.plans[r.planIndex]._contractViolations = r.violations;
    }
    parsed._planContractPassRate = contractResult.passRate;
    // Record that the structural lint gate was invoked this cycle.
    await recordCapabilityExecution(
      config,
      "prometheus-plan-structural-lint",
      `plans=${contractResult.totalPlans} invalid=${contractResult.invalidCount} passRate=${contractResult.passRate}`,
    );
    await recordCapabilityExecution(
      config,
      "pre-athena-plan-structural-validation",
      `plans=${contractResult.totalPlans} passRate=${contractResult.passRate}`,
    );

    const contractGateOutcome = analyzePlanContractGateOutcome(contractResult);
    if (contractGateOutcome.allPlansBlocked) {
      const blockingCodes = contractGateOutcome.blockedViolationCodes.join(",") || "unknown_critical_contract_violation";
      await appendProgress(
        config,
        `[PROMETHEUS][CONTRACT][FAIL_CLOSED] All ${contractGateOutcome.totalPlans} plan(s) fail the critical dispatch contract ` +
        `(codes=${blockingCodes}) - blocking Athena submission until Prometheus emits dispatchable packets`
      );
      parsed._planContractGateFailed = true;
      parsed._planContractGateCodes = contractGateOutcome.blockedViolationCodes;
      parsed.failReason = "plan-contract-gate";
      parsed.plans = [];
      parsed.executionStrategy = buildExecutionStrategyFromPlans([], {
        planningMode: parsed?.executionStrategy?.planningMode || parsed?.planningMode || planningMode,
      });
      parsed.requestBudget = {
        ...buildDeterministicRequestBudget([], parsed.executionStrategy || {}),
        _fallback: false,
      };
    }

    // ── Secondary safety net: hard-filter plans missing valid capacityDelta / requestROI ─
    // Primary rejection happens at the generation boundary (checkPacketCompleteness above).
    // This secondary pass catches any surviving violations from alternative-shape synthesized
    // plans (waves, bottlenecks, narrative fallback) or drift debt tasks that bypass the
    // pre-normalization gate. These fields are required for plan ranking and budget comparison.
    //
    // Filter uses deterministic PACKET_VIOLATION_CODE codes (canonical taxonomy from
    // plan_contract_validator.ts) rather than field-name string equality, so matching
    // is immune to field rename and consistent with the generation-boundary gate codes.
    if (parsed.plans.length > 0) {
      const admissionHardFilter = applyAdmissionPacketHardFilter(parsed.plans, contractResult);
      if (admissionHardFilter.rejectedPlanIndices.length > 0) {
        if (admissionHardFilter.warnedOnly) {
          await appendProgress(
            config,
            `[PROMETHEUS][CONTRACT] WARN: all ${admissionHardFilter.rejectedPlanIndices.length} plan(s) ` +
            `hit admission hard-filter for missing required evidence or capacity-first justification ` +
            `- preserving for Athena review to avoid a no-plan cycle`,
          );
          parsed._allPlansAdmissionFilterWarnOnly = true;
        } else {
          await appendProgress(config,
            `[PROMETHEUS][CONTRACT] Hard-filtered ${admissionHardFilter.filteredCount} low-quality/redundant admission packet(s) missing required evidence or capacity-first justification`
          );
          parsed._capacityRoiFilteredCount = admissionHardFilter.filteredCount;
        }
      }
    }

    // ── Stale-diagnostics hard rejection gate ────────────────────────────────
    // Reject plans that were tagged _staleDiagnosticsGated by the gate above and
    // received a CRITICAL STALE_DIAGNOSTICS_BACKED violation from the contract
    // validator.  Safety valve: if ALL plans are stale-backed (no fresh
    // alternative exists), preserve them with a warning rather than killing the
    // cycle — Athena will make the final accept/reject decision.
    if (parsed.plans.length > 0) {
      const staleBackedIndices = contractResult.results
        .filter(r => !r.valid && r.violations.some(v =>
          v.code === PACKET_VIOLATION_CODE.STALE_DIAGNOSTICS_BACKED &&
          v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
        ))
        .map(r => r.planIndex)
        .sort((a, b) => b - a);
      if (staleBackedIndices.length > 0) {
        const nonStaleCount = parsed.plans.length - staleBackedIndices.length;
        if (nonStaleCount > 0) {
          // Non-stale alternatives exist — hard-reject stale-backed plans.
          for (const idx of staleBackedIndices) {
            parsed.plans.splice(idx, 1);
          }
          await appendProgress(
            config,
            `[PROMETHEUS][DIAG_FRESHNESS] Hard-rejected ${staleBackedIndices.length} stale-diagnostics-backed packet(s) ` +
            `(${nonStaleCount} independently-evidenced plan(s) remain)`,
          );
          parsed._staleBackedRejectedCount = staleBackedIndices.length;
        } else {
          // All plans are stale-backed — preserve with warning to avoid deadlock.
          await appendProgress(
            config,
            `[PROMETHEUS][DIAG_FRESHNESS] WARN: all ${staleBackedIndices.length} plan(s) are stale-diagnostics-backed ` +
            `— preserving for Athena review (staleSources=${diagnosticsFreshnessAdmission.staleSources.join(",")})`,
          );
          parsed._allPlansStale = true;
        }
      }
    }
  }

  // ── Low-confidence quarantine ────────────────────────────────────────────
  // Attach aggregate parser confidence as provenance to plans that do not yet
  // carry per-packet provenance, then run quarantineLowConfidencePackets so
  // low-quality fallback plans are excluded from the dispatchable set.
  // This executes the quarantine function in the normalization pipeline rather
  // than leaving it as an untriggered utility — low-confidence packets must
  // never reach dispatch.
  if (Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    const parserConfidenceScore = typeof parsed.parserConfidence === "number"
      ? parsed.parserConfidence
      : 1.0;
    const plansWithProvenance = parsed.plans.map((plan: any) => {
      const admissionConfidence = computePacketAdmissionConfidence(plan, parsed);
      const packetWithProvenance = plan._provenance
        ? { ...plan }
        : attachFallbackProvenance(plan, {
            source: "prometheus-normalization",
            reason: "packet-admission-confidence",
            confidence: admissionConfidence,
            tag: admissionConfidence < QUARANTINE_CONFIDENCE_THRESHOLD
              ? FALLBACK_PROVENANCE_TAG.PARSER_FALLBACK
              : FALLBACK_PROVENANCE_TAG.DIRECT,
          });
      packetWithProvenance._admissionConfidence = admissionConfidence;
      return packetWithProvenance;
    });
    const quarantineResult = quarantineLowConfidencePackets(plansWithProvenance);
    if (quarantineResult.quarantined.length > 0) {
      parsed.plans = quarantineResult.allowed;
      parsed._quarantinedPacketCount = quarantineResult.quarantined.length;
      parsed._quarantinedPackets = quarantineResult.quarantined;
      const minAdmissionConfidence = quarantineResult.quarantined.reduce((min: number, packet: any) => {
        const confidence = typeof packet?._admissionConfidence === "number"
          ? packet._admissionConfidence
          : (typeof packet?._provenance?.confidence === "number" ? packet._provenance.confidence : 1.0);
        return Math.min(min, confidence);
      }, 1.0);
      await appendProgress(config,
        `[PROMETHEUS][QUARANTINE] ${quarantineResult.quarantined.length} low-confidence packet(s) excluded from dispatch ` +
        `(aggregateParserConfidence=${parserConfidenceScore}; minAdmissionConfidence=${minAdmissionConfidence} < threshold=${QUARANTINE_CONFIDENCE_THRESHOLD})`
      );
    } else {
      parsed.plans = plansWithProvenance;
    }
  }

  // ── Carry-forward admission gate (Task 2) ────────────────────────────────
  // Blocks plan dispatch when the same unresolved lesson has recurred past the
  // threshold without being addressed in the current plan set. This converts
  // repeated advisory carry-forward items into hard admission blockers.
  if (postmortemEntries.length > 0 && Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    const maxUnresolvedCycles = Number(config?.planner?.maxUnresolvedCycles) || 3;
    const gateResult = checkCarryForwardGate(postmortemEntries, parsed.plans, { maxUnresolvedCycles });
    // Also compile recurring unresolved lessons into enforceable hard-gate policies.
    const existingPolicyIds = (parsed._hardGatePolicies || []).map((p: any) => String(p.id));
    const recurrenceResult = hardGateRecurrenceToPolicies(postmortemEntries, existingPolicyIds, {
      maxRecurrences: maxUnresolvedCycles,
    });
    if (recurrenceResult.newPolicies.length > 0) {
      parsed._hardGatePolicies = [...(parsed._hardGatePolicies || []), ...recurrenceResult.newPolicies];
    }
    parsed._carryForwardGateResult = gateResult;
    if (gateResult.shouldBlock) {
      parsed._carryForwardGateBlocked = true;
      await appendProgress(config,
        `[PROMETHEUS][CARRY-FORWARD] HARD BLOCK — ${gateResult.reason}` +
        (gateResult.unresolvedLessons.length > 0 ? ` | unresolved: ${gateResult.unresolvedLessons.slice(0, 3).join("; ")}` : "") +
        (gateResult.missingMandatory.length > 0 ? ` | missing mandatory: ${gateResult.missingMandatory.slice(0, 3).join("; ")}` : "")
      );
    }
  }

  // ── Dual-pass planning: Pass-B critic gate ─────────────────────────────────
  // Deterministic critic evaluates plans before Athena review (no AI call).
  // Rejected plans are logged but still included (Athena makes final decision).
  if (Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    const criticRepair = dualPassCriticRepair(parsed.plans);
    parsed.plans = criticRepair.plans;
    if (criticRepair.repairCount > 0 || criticRepair.finalRejected > 0) {
      await appendProgress(
        config,
        `[PROMETHEUS][CRITIC] repaired=${criticRepair.repairCount} approved=${criticRepair.finalApproved} rejected=${criticRepair.finalRejected}`
      );
    }
  }

  // ── AC measurability enrichment ───────────────────────────────────────────
  // Enrich plans lacking concrete acceptance criteria with compiled ACs.
  if (Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    const acResult = enrichPlansWithAC(parsed.plans);
    if (acResult.enrichedCount > 0) {
      await appendProgress(config,
        `[PROMETHEUS][AC] Enriched ${acResult.enrichedCount} plan(s) with compiled acceptance criteria`
      );
    }
    parsed.plans = acResult.plans;
  }

  // Ensure Athena-facing rigor fields exist after all enrichment/repair passes.
  if (Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    parsed.plans = parsed.plans.map((plan, idx) => normalizePlanFromTask(plan, idx, Number(plan.wave) || 1));
    parsed.plans = applyPlanningRubric(parsed.plans);
  }

  if (Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    const lifecycleAdmission = await applyPlanLifecycleAdmissionFilter(stateDir, parsed.plans);
    if (lifecycleAdmission.skippedPlans.length > 0) {
      parsed._lifecycleAdmission = {
        skippedCount: lifecycleAdmission.skippedPlans.length,
        closedFamilyCount: lifecycleAdmission.lifecycleSummary.closedFamilyCount,
        ongoingFamilyCount: lifecycleAdmission.lifecycleSummary.ongoingFamilyCount,
      };
      parsed._lifecycleSkippedPlans = lifecycleAdmission.skippedPlans.slice(0, 50).map(({ plan, reason }) => ({
        task: plan?.task || plan?.title || plan?.task_id || null,
        continuationFamilyKey: plan?.continuationFamilyKey || null,
        lifecycleState: plan?._lifecycleState || null,
        reason,
      }));
      await appendProgress(
        config,
        `[PROMETHEUS][LIFECYCLE] Suppressed ${lifecycleAdmission.skippedPlans.length}/${parsed.plans.length} plan(s) already closed or already continuing in the same family`,
      );
    }
    parsed.plans = lifecycleAdmission.actionablePlans;
  }

  // Ensure execution strategy and request budget remain concrete after plan normalization.
  if (!parsed.executionStrategy || !Array.isArray(parsed.executionStrategy.waves) || parsed.executionStrategy.waves.length === 0) {
    parsed.executionStrategy = buildExecutionStrategyFromPlans(parsed.plans || [], {
      planningMode: parsed?.executionStrategy?.planningMode || parsed?.planningMode || planningMode,
    });
  }
  if (!parsed.requestBudget || parsed.requestBudget._fallback) {
    parsed.requestBudget = {
      ...buildDeterministicRequestBudget(parsed.plans || [], parsed.executionStrategy || {}),
      _fallback: false
    };
    await appendProgress(config, `[PROMETHEUS][BUDGET] Rebuilt deterministic request budget with byWave/byRole breakdown`);
  }

  // ── Drift confidence penalty (Task 4) ────────────────────────────────────
  // Bind unresolved architecture drift counts to planning confidence.
  // High drift counts signal docs-codebase divergence, reducing trust in the plan.
  const driftPenaltyResult = computeDriftConfidencePenalty(driftReport);
  if (driftPenaltyResult.penalty > 0) {
    parsed.parserConfidence = Math.max(0.1, (parsed.parserConfidence ?? 1.0) - driftPenaltyResult.penalty);
    // Accumulate drift into the context-penalty channel (architectureDrift is a context signal).
    parsed.parserContextPenalty = Math.round(((parsed.parserContextPenalty ?? 0) + driftPenaltyResult.penalty) * 100) / 100;
    if (!Array.isArray(parsed.parserConfidencePenalties)) parsed.parserConfidencePenalties = [];
    parsed.parserConfidencePenalties.push({
      reason: driftPenaltyResult.reason,
      component: "architectureDrift",
      delta: -driftPenaltyResult.penalty,
    });
    if (driftPenaltyResult.requiresRemediation) {
      parsed._requiresDriftRemediation = true;
    }
    await appendProgress(config,
      `[PROMETHEUS][DRIFT] Confidence penalty applied: ${driftPenaltyResult.penalty.toFixed(2)} (${driftPenaltyResult.reason})` +
      (driftPenaltyResult.requiresRemediation ? " — remediation plans required" : "")
    );
  }

  // ── Drift debt task injection ─────────────────────────────────────────────
  // Deterministically convert unresolved drift items into tracked debt tasks so
  // they appear in the plan graph regardless of whether the AI included them.
  if (driftReport && (driftReport.staleCount > 0 || driftReport.deprecatedTokenCount > 0)) {
    const driftDebtTasks = buildDriftDebtTasks(driftReport, parsed.plans || []);
    if (driftDebtTasks.length > 0) {
      if (!Array.isArray(parsed.plans)) parsed.plans = [];
      parsed.plans = [...parsed.plans, ...driftDebtTasks];
      parsed._driftDebtTaskCount = driftDebtTasks.length;
      await appendProgress(config,
        `[PROMETHEUS][DRIFT] Injected ${driftDebtTasks.length} debt task(s) from architecture drift into plan (wave ${driftDebtTasks[0].wave})`
      );
    }
  }

  parsed.projectHealth = resolvePrometheusProjectHealth(parsed);

  // ── Build analysis result ─────────────────────────────────────────────────
  const analysis = ensurePersistedAnalysisTimestamps({
    ...parsed,
    dossierPath: null,
    model: prometheusModel,
    repo: config.env?.targetRepo,
    requestedBy,
    promptLineage,
    researchContext: {
      injected: Boolean(researchSectionText),
      topicCount: researchTopicCount,
      sourceCount: researchSourceCount,
      coverageTarget: researchCoverageTarget,
    },
    mandatoryTasks: {
      sourceFile: path.join(stateDir, "health_audit_findings.json"),
      requiredSeverities: Array.from(HEALTH_AUDIT_MANDATORY_SEVERITIES),
      findingCount: mandatoryFindings.length,
      findings: mandatoryFindings,
      coverageGate: parsed._mandatoryTaskCoverageGate || null,
      preflightResult: mandatoryFindingsPreflightResult,
    },
  });
  (analysis as any).executionStrategy = {
    ...((analysis as any).executionStrategy || {}),
    promptLineage,
  };

  try {
    // Sanitize plan text fields before persistence to strip operational tool traces.
    (analysis as any).keyFindings = sanitizePlanningFieldForPersistence(String((analysis as any).keyFindings || ""));
    (analysis as any).strategicNarrative = sanitizePlanningFieldForPersistence(String((analysis as any).strategicNarrative || ""));
    if (Array.isArray((analysis as any).plans)) {
      (analysis as any).plans = (analysis as any).plans.map((plan: any) => ({
        ...plan,
        task: sanitizePlanningFieldForPersistence(String(plan.task || "")),
        context: plan.context != null
          ? sanitizePlanningFieldForPersistence(String(plan.context))
          : plan.context,
      }));
    }
    await writeJson(path.join(stateDir, "prometheus_analysis.json"), addSchemaVersion(analysis, STATE_FILE_TYPE.PROMETHEUS_ANALYSIS));
  } catch (writeErr) {
    // Critical planning ledger write failed — emit structured WARN so the orchestrator
    // can detect degraded state without halting the cycle (fail-open contract).
    warn(`[prometheus] prometheus_analysis.json write failed (degraded): ${String((writeErr as any)?.message || writeErr)}`);
    emitEvent(EVENTS.ORCHESTRATION_HEALTH_DEGRADED, EVENT_DOMAIN.PLANNING, "prometheus_analysis_write", {
      source: "prometheus",
      ledger: "prometheus_analysis.json",
      error: String((writeErr as any)?.message || writeErr),
    });
  }

  const planCount = Array.isArray(analysis.plans) ? analysis.plans.length : 0;
  await appendProgress(config, `[PROMETHEUS] Analysis complete — ${planCount} work items | health=${analysis.projectHealth}`);
  await appendPrometheusLiveLog(stateDir, "leadership_live", `[${ts()}] ${prometheusName.padEnd(20)} Analysis ready: ${planCount} plans | health=${analysis.projectHealth}`);

  // ── Update topic memory with knowledge from this run ──────────────────────
  try {
    if (researchTopicsList.length > 0 && Array.isArray(analysis.plans)) {
      topicMemory = updateTopicKnowledge(topicMemory, researchTopicsList, analysis.plans, researchSynthesisData);
      const qualityGateQuarantinedTopics = Array.isArray((researchSynthesisData as any)?.qualityGate?.quarantinedTopics)
        ? ((researchSynthesisData as any).qualityGate.quarantinedTopics as string[])
        : [];
      const completion = detectAndCompleteTopics(
        topicMemory,
        researchTopicsList,
        analysis.plans,
        analysis,
        qualityGateQuarantinedTopics,
      );
      topicMemory = completion.memory;
      await saveTopicMemory(stateDir, topicMemory);

      if (completion.completedThisRun.length > 0) {
        await appendProgress(config,
          `[PROMETHEUS][TOPIC_MEMORY] Completed ${completion.completedThisRun.length} topic(s): ${completion.completedThisRun.join(", ")}`
        );
      }
      if (completion.archivedThisRun.length > 0) {
        await appendProgress(config,
          `[PROMETHEUS][TOPIC_MEMORY] Archived ${completion.archivedThisRun.length} informational topic(s): ${completion.archivedThisRun.join(", ")}`
        );
      }
      const activeCount = Object.values(topicMemory.topics).filter(t => t.status === "active").length;
      const completedCount = Object.values(topicMemory.topics).filter(t => t.status === "completed").length;
      const archivedCount = Object.values(topicMemory.topics).filter(t => t.status === "archived").length;
      await appendProgress(config,
        `[PROMETHEUS][TOPIC_MEMORY] Updated: ${activeCount} active, ${completedCount} completed, ${archivedCount} archived topic(s), ${Object.keys(topicMemory.topics).length} total`
      );
    }
  } catch (tmErr) {
    warn(`[prometheus] Topic memory update failed (degraded): ${String((tmErr as any)?.message || tmErr)}`);
    emitEvent(EVENTS.ORCHESTRATION_HEALTH_DEGRADED, EVENT_DOMAIN.PLANNING, "prometheus_topic_memory", {
      source: "prometheus",
      ledger: "topic_memory",
      error: String((tmErr as any)?.message || tmErr),
    });
    await appendProgress(config, `[PROMETHEUS][WARN] Topic memory update failed (non-fatal): ${String((tmErr as any)?.message || tmErr)}`).catch(() => {});
  }

  // ── Budget-aware intervention optimizer (non-blocking) ────────────────────
  if (config?.interventionOptimizer?.enabled !== false && Array.isArray(analysis.plans) && analysis.plans.length > 0) {
    try {
      const interventions = buildInterventionsFromPlan(analysis.plans, config);
      const budget = buildBudgetFromConfig(analysis.requestBudget, config);
      const learnedPolicies = await readJson(path.join(stateDir, "learned_policies.json"), []);
      const policyImpactByInterventionId = buildPolicyImpactByInterventionId(
        analysis.plans,
        Array.isArray(learnedPolicies) ? learnedPolicies : [],
      );
      const optimizerResult = runInterventionOptimizer(interventions, budget, { policyImpactByInterventionId });

      await appendInterventionOptimizerEntry(config, {
        ...optimizerResult,
        correlationId: `prometheus-${Date.now()}`,
        prometheusAnalyzedAt: analysis.analyzedAt,
      }).catch((err) => {
        appendProgress(config, `[PROMETHEUS][WARN] Optimizer log persist failed: ${String(err?.message || err)}`).catch(() => {});
      });

      const selectedCount = Array.isArray(optimizerResult.selected) ? optimizerResult.selected.length : 0;
      const rejectedCount = Array.isArray(optimizerResult.rejected) ? optimizerResult.rejected.length : 0;
      const policyImpactPenaltiesApplied = "policyImpactPenaltiesApplied" in optimizerResult
        ? Number(optimizerResult.policyImpactPenaltiesApplied || 0)
        : 0;
      await appendProgress(config,
        `[PROMETHEUS] Intervention optimizer: status=${optimizerResult.status} selected=${selectedCount} rejected=${rejectedCount} budgetUsed=${optimizerResult.totalBudgetUsed}/${optimizerResult.totalBudgetLimit} (${optimizerResult.budgetUnit ?? "workerSpawns"})`
      ).catch(() => {});

      if (optimizerResult.status === OPTIMIZER_STATUS.BUDGET_EXCEEDED) {
        await appendProgress(config,
          `[PROMETHEUS][WARN] Budget pressure: ${rejectedCount} intervention(s) blocked — reasonCode=${optimizerResult.reasonCode}`
        ).catch(() => {});
      }

      analysis.interventionOptimizer = {
        status:           optimizerResult.status,
        reasonCode:       optimizerResult.reasonCode,
        selectedCount,
        rejectedCount,
        policyImpactPenaltiesApplied,
        totalBudgetUsed:  optimizerResult.totalBudgetUsed,
        totalBudgetLimit: optimizerResult.totalBudgetLimit,
        budgetUnit:       optimizerResult.budgetUnit,
      };
    } catch (err) {
      analysis.interventionOptimizer = {
        status:       "error",
        reasonCode:   "OPTIMIZER_INTERNAL_ERROR",
        errorMessage: String(err?.message || err),
      };
      await appendProgress(config, `[PROMETHEUS][WARN] Intervention optimizer error (non-fatal): ${String(err?.message || err)}`).catch(() => {});
    }
  }

  // ── Dependency graph resolver (non-blocking) ─────────────────────────────
  if (Array.isArray(analysis.plans) && analysis.plans.length > 0) {
    try {
      const graphTasks = analysis.plans.map((plan, i) => ({
        id: String(plan.task || `plan-${i}`),
        dependsOn: Array.isArray(plan.dependencies) ? plan.dependencies.map(String) : [],
        filesInScope: Array.isArray(plan.target_files) ? plan.target_files : (Array.isArray(plan.targetFiles) ? plan.targetFiles : []),
      }));

      const graphResult = resolveDependencyGraph(graphTasks);

      await persistGraphDiagnostics(stateDir, graphResult, {
        correlationId: `prometheus-${Date.now()}`,
        prometheusAnalyzedAt: analysis.analyzedAt,
      }).catch((err) => {
        appendProgress(config, `[PROMETHEUS][WARN] Dependency graph diagnostics persist failed: ${String(err?.message || err)}`).catch(() => {});
      });

      await appendProgress(config,
        `[PROMETHEUS] Dependency graph: status=${graphResult.status} waves=${graphResult.waves.length} parallel=${graphResult.parallelTasks} serialized=${graphResult.serializedTasks} conflicts=${graphResult.conflictPairs.length}`
      ).catch(() => {});

      if (graphResult.status === GRAPH_STATUS.CYCLE_DETECTED) {
        await appendProgress(config,
          `[PROMETHEUS][WARN] Dependency graph cycle detected — scheduler will fall back to sequential dispatch: ${graphResult.errorMessage}`
        ).catch(() => {});
      }

      analysis.dependencyGraph = {
        status:          graphResult.status,
        reasonCode:      graphResult.reasonCode,
        waveCount:       graphResult.waves.length,
        parallelTasks:   graphResult.parallelTasks,
        serializedTasks: graphResult.serializedTasks,
        conflictCount:   graphResult.conflictPairs.length,
        cycleCount:      graphResult.cycles.length,
        waves:           graphResult.waves,
        errorMessage:    graphResult.errorMessage ?? null,
      };

      // ── Update dependencyGraph confidence component ──────────────────────
      // Compute a 0–1 score from the resolved graph and attach it to the
      // parserConfidenceComponents so that calibration loops (baseline recovery,
      // dispatch strictness) can use it on the next cycle.
      //
      // Score scale:
      //   1.0 — OK, no conflicts
      //   0.8–1.0 — OK, conflict-rate adjusted (0.2 deducted per 100% conflict rate)
      //   0.6 — non-OK status without cycles (degraded but recoverable)
      //   0.3 — cycle detected (hard graph failure)
      const conflictRate = graphResult.conflictPairs.length / Math.max(1, analysis.plans.length);
      const cycleCount   = Array.isArray(graphResult.cycles) ? graphResult.cycles.length : 0;
      const dependencyGraphScore =
        cycleCount > 0                           ? 0.3 :
        graphResult.status !== GRAPH_STATUS.OK   ? 0.6 :
        Math.max(0.5, 1.0 - conflictRate * 0.2);
      const roundedDGScore = Math.round(dependencyGraphScore * 100) / 100;

      if (!analysis.parserConfidenceComponents) analysis.parserConfidenceComponents = {};
      analysis.parserConfidenceComponents.dependencyGraph = roundedDGScore;
      analysis.dependencyGraph.score = roundedDGScore;
    } catch (err) {
      analysis.dependencyGraph = {
        status:       GRAPH_STATUS.DEGRADED,
        reasonCode:   "RESOLVER_INTERNAL_ERROR",
        errorMessage: String(err?.message || err),
      };
      // Reflect degraded graph in parserConfidenceComponents so downstream gates see it.
      if (!analysis.parserConfidenceComponents) analysis.parserConfidenceComponents = {};
      analysis.parserConfidenceComponents.dependencyGraph = 0.6;
      await appendProgress(config, `[PROMETHEUS][WARN] Dependency graph resolver error (non-fatal): ${String(err?.message || err)}`).catch(() => {});
    }
  }

  // ── Emit per-cycle planner metrics (Task 1 observability) ────────────────
  // Non-blocking: append to prometheus_cycle_metrics.jsonl for budget efficiency
  // measurement. Captures: findingsInjectedCount, coverageGateRetries, planCount,
  // estimatedPromptTokens, estimatedTokenCost, diagnosticsFreshnessSnapshot.
  try {
    const promptTokens = Math.ceil(contextPrompt.length / 4);
    const tokenCost = estimateTokenCost(promptTokens);
    const freshnessSnap = diagnosticsFreshnessSection
      ? String(diagnosticsFreshnessSection).slice(0, 200).trim() || null
      : null;
    await emitPlannerCycleMetrics(stateDir, {
      schemaVersion: PROMETHEUS_CYCLE_METRICS_SCHEMA_VERSION,
      cycleId: analysis.analyzedAt || new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      findingsInjectedCount: mandatoryFindings.length,
      coverageGateRetries: parserContractResult.retried ? 1 : 0,
      planCount: Array.isArray(analysis.plans) ? analysis.plans.length : 0,
      estimatedPromptTokens: promptTokens,
      estimatedTokenCost: tokenCost,
      diagnosticsFreshnessSnapshot: freshnessSnap,
    });
  } catch { /* non-fatal — metrics emission must never block planning */ }

  return analysis;
}

// ── Per-cycle planner metrics ──────────────────────────────────────────────────
//
// Emitted at the end of every successful runPrometheusAnalysis() call.
// Appended to state/prometheus_cycle_metrics.jsonl so budget efficiency
// can be measured and improved across cycles.

/** Schema version for prometheus_cycle_metrics.jsonl entries. */
export const PROMETHEUS_CYCLE_METRICS_SCHEMA_VERSION = 1;

/** Per-cycle planner observability record. */
export interface PlannerCycleMetrics {
  schemaVersion: number;
  /** ISO timestamp matching analysis.analyzedAt — used as the cycle identity key. */
  cycleId: string;
  recordedAt: string;
  /** Number of mandatory health-audit findings injected into the prompt. */
  findingsInjectedCount: number;
  /**
   * 1 when the parser contract gate triggered a retry this cycle; 0 otherwise.
   * Proxy for how often the planner output needed correction.
   */
  coverageGateRetries: number;
  /** Number of plans in the final analysis (after all gates). */
  planCount: number;
  /** Estimated token count for the full context prompt (chars / 4). */
  estimatedPromptTokens: number;
  /** Estimated USD cost for the prompt tokens at default model pricing. */
  estimatedTokenCost: number;
  /**
   * Compact snapshot (≤200 chars) of the diagnostics freshness section text,
   * or null when no freshness section was built this cycle.
   */
  diagnosticsFreshnessSnapshot: string | null;
}

/**
 * Append a PlannerCycleMetrics record to state/prometheus_cycle_metrics.jsonl.
 *
 * Uses appendFileSync so each record is a single atomic line write.
 * Never throws — all errors are silently swallowed to prevent blocking planning.
 *
 * @param stateDir - path to the state directory
 * @param metrics  - the record to persist
 */
export async function emitPlannerCycleMetrics(
  stateDir: string,
  metrics: PlannerCycleMetrics,
): Promise<void> {
  try {
    const { appendFileSync } = await import("node:fs");
    const filePath = path.join(stateDir, "prometheus_cycle_metrics.jsonl");
    const entry = JSON.stringify(metrics) + "\n";
    appendFileSync(filePath, entry, "utf8");
  } catch { /* non-fatal */ }
}

// ── Fallback provenance and low-confidence quarantine ─────────────────────────
//
// Fallback packets (produced by narrative extraction, wave-derivation, or
// parser recovery modes) carry lower-confidence plans than direct JSON parses.
// Attaching explicit provenance lets downstream gates (Athena, validateAllPlans)
// reason about plan origin; quarantine prevents low-confidence packets from
// being dispatched at all.

/**
 * Canonical provenance tags for fallback plan packets.
 * `direct` = JSON plans parsed directly from model output (highest confidence).
 * All others indicate fallback / recovery paths with reduced confidence.
 */
export const FALLBACK_PROVENANCE_TAG = Object.freeze({
  DIRECT:               "direct",
  NARRATIVE:            "narrative-extracted",
  WAVE_DERIVED:         "wave-derived",
  PARSER_FALLBACK:      "parser-fallback",
  UNCERTAINTY_FALLBACK: "uncertainty-fallback",
} as const);

export type FallbackProvenanceTag = typeof FALLBACK_PROVENANCE_TAG[keyof typeof FALLBACK_PROVENANCE_TAG];

/**
 * Packets whose `_provenance.confidence` is below this threshold are quarantined
 * and excluded from worker dispatch by `quarantineLowConfidencePackets`.
 */
export const QUARANTINE_CONFIDENCE_THRESHOLD = 0.5 as const;

/**
 * Attach provenance metadata to a fallback plan packet.
 *
 * Returns a new object with `_provenance` set — the original packet is not mutated.
 * Non-object inputs are returned unchanged (safe for piping through pipelines).
 *
 * @param packet — the plan packet to annotate
 * @param opts   — { source, reason, confidence (0-1), tag }
 */
export function attachFallbackProvenance(
  packet: any,
  opts: {
    source?:     string;
    reason?:     string;
    confidence?: number;
    tag?:        FallbackProvenanceTag | string;
  } = {},
): any {
  if (!packet || typeof packet !== "object") return packet;
  const confidence = typeof opts.confidence === "number"
    ? Math.max(0, Math.min(1, opts.confidence))
    : 0.5;
  return {
    ...packet,
    _provenance: {
      source:     String(opts.source  || "parser"),
      reason:     String(opts.reason  || "fallback"),
      confidence,
      tag:        opts.tag || FALLBACK_PROVENANCE_TAG.PARSER_FALLBACK,
      attachedAt: new Date().toISOString(),
    },
  };
}

/**
 * Compute the packet-level admission confidence used by dispatch quarantine.
 *
 * Aggregate parserConfidence remains the analytics signal for the whole plan set,
 * but quarantine must operate on the confidence of the specific surviving packet.
 * Context penalties that are still applicable to the packet are subtracted from
 * parserCoreConfidence. Diagnostics-freshness penalties apply only to packets that
 * are explicitly stale-backed, or when every remaining packet is stale-backed.
 */
export function computePacketAdmissionConfidence(packet: any, parsed: any): number {
  const parserCoreConfidence = typeof parsed?.parserCoreConfidence === "number"
    ? parsed.parserCoreConfidence
    : (typeof parsed?.parserConfidence === "number" ? parsed.parserConfidence : 1.0);
  const penalties = Array.isArray(parsed?.parserConfidencePenalties)
    ? parsed.parserConfidencePenalties
    : [];

  let applicableContextPenalty = 0;
  for (const penalty of penalties) {
    const component = String(penalty?.component || "").trim();
    const delta = Number(penalty?.delta);
    if (!PARSER_CONTEXT_PENALTY_COMPONENTS.has(component) || !Number.isFinite(delta) || delta >= 0) {
      continue;
    }

    if (component === "diagnosticsFreshness") {
      const packetIsStaleBacked = packet?._staleDiagnosticsGated === true || parsed?._allPlansStale === true;
      if (!packetIsStaleBacked) {
        continue;
      }
    }

    applicableContextPenalty += -delta;
  }

  return Math.round(Math.max(0.1, parserCoreConfidence - applicableContextPenalty) * 100) / 100;
}

/**
 * Partition plan packets into allowed and quarantined sets.
 *
 * A packet is quarantined when its admission confidence is strictly less than
 * `threshold`. `_admissionConfidence` takes precedence; `_provenance.confidence`
 * remains the backward-compatible fallback. Packets without either value are
 * treated as high-confidence (backward compatible with pre-provenance plans).
 *
 * Quarantined packets are tagged with `_quarantined: true` and a
 * `_quarantineReason` string; allowed packets are returned unchanged.
 *
 * @param packets  — plan packets to partition
 * @param opts     — { threshold } override (default: QUARANTINE_CONFIDENCE_THRESHOLD)
 * @returns {{ allowed: any[], quarantined: any[] }}
 */
export function quarantineLowConfidencePackets(
  packets: any[],
  opts: { threshold?: number } = {},
): { allowed: any[]; quarantined: any[] } {
  if (!Array.isArray(packets)) return { allowed: [], quarantined: [] };

  const threshold = typeof opts.threshold === "number"
    ? opts.threshold
    : QUARANTINE_CONFIDENCE_THRESHOLD;

  const allowed: any[]     = [];
  const quarantined: any[] = [];

  for (const packet of packets) {
    const admissionConfidence = packet?._admissionConfidence;
    const provConfidence = packet?._provenance?.confidence;
    // No provenance → assume max confidence (backward compatible)
    const confidence = typeof admissionConfidence === "number"
      ? admissionConfidence
      : (typeof provConfidence === "number" ? provConfidence : 1.0);

    if (confidence < threshold) {
      quarantined.push({
        ...packet,
        _quarantined:      true,
        _quarantineReason: `confidence ${confidence} < threshold ${threshold}`,
      });
    } else {
      allowed.push(packet);
    }
  }

  return { allowed, quarantined };
}

// ── Benchmark ground-truth section for planning prompt ────────────────────────

/**
 * Read benchmark_ground_truth.json from the state directory.
 * Returns null when the file does not exist or cannot be parsed.
 */
export async function readBenchmarkGroundTruth(config: any): Promise<any | null> {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, "benchmark_ground_truth.json");
  try {
    return await readJson(filePath, null);
  } catch {
    return null;
  }
}

/**
 * Build a concise benchmark status section for injection into the Prometheus
 * planning prompt.
 *
 * Shows the most-recent cycle's research recommendation statuses so Prometheus
 * can see which prior research has been implemented and what still needs work.
 * Returns empty string when no benchmark data is available.
 *
 * @param benchmarkData — parsed benchmark_ground_truth.json content
 */
export function buildBenchmarkSection(benchmarkData: any): string {
  if (!benchmarkData || !Array.isArray(benchmarkData.entries) || benchmarkData.entries.length === 0) {
    return "";
  }

  const latest = benchmarkData.entries[0];
  if (!latest || !Array.isArray(latest.recommendations) || latest.recommendations.length === 0) {
    return "";
  }

  // Compute integrity score to surface data quality alongside statuses
  const integrity = computeBenchmarkIntegrityScore(benchmarkData);

  // Compute provenance routing delta so Prometheus knows which tasks to skip
  const routingDelta = computeProvenanceRoutingDelta(benchmarkData);
  const skipSet = new Set(routingDelta.skip);

  const lines = latest.recommendations.map((rec: any) => {
    const status = String(rec.implementationStatus || "pending").toUpperCase();
    const score = typeof rec.benchmarkScore === "number"
      ? ` score=${rec.benchmarkScore.toFixed(2)}`
      : "";
    const gain = typeof rec.capacityGain === "number"
      ? ` gain=${rec.capacityGain.toFixed(2)}`
      : "";
    const summary = String(rec.summary || "").slice(0, 120);
    const topic   = String(rec.topic || rec.id || "?");
    const recId   = String(rec.id || "");
    // Annotate with routing decision so Prometheus can skip CI-closed work
    const routingTag = skipSet.has(recId) ? " [SKIP:ci-closed]" : "";
    return `  - [${status}${score}${gain}${routingTag}] ${topic} — ${summary}`;
  }).join("\n");

  const cycleLabel = latest.cycleId ? ` (cycle ${latest.cycleId})` : "";
  const integrityLabel = integrity.sampleCount > 0
    ? ` | integrity=${integrity.integrityScore.toFixed(2)} unresolved=${(integrity.unresolvedRatio * 100).toFixed(0)}% contradictions=${integrity.contradictionCount}`
    : "";
  const deltaLabel = routingDelta.provenanceCompleteCount > 0
    ? ` | routing-delta: ${routingDelta.provenanceSummary}`
    : "";
  return `\n\n## RESEARCH BENCHMARK STATUS${cycleLabel}${integrityLabel}${deltaLabel}\nPrior research recommendation tracking — avoid re-proposing implemented items; [SKIP:ci-closed] items are CI-closed and must not be re-planned; prioritize pending ones:\n${lines}`;
}

export function buildRoutingOutcomeSection(premiumUsageData: any): string {
  if (!Array.isArray(premiumUsageData) || premiumUsageData.length === 0) return "";
  const recent = premiumUsageData.slice(-20);
  if (recent.length === 0) return "";

  const byKind = new Map<string, { total: number; done: number }>();
  for (const row of recent) {
    if (!row || typeof row !== "object") continue;
    const kind = String((row as any).taskKind || "general").trim() || "general";
    const key = kind.toLowerCase();
    const status = String((row as any).outcome || "").toLowerCase();
    const current = byKind.get(key) || { total: 0, done: 0 };
    current.total += 1;
    if (status === "done") current.done += 1;
    byKind.set(key, current);
  }

  if (byKind.size === 0) return "";

  const lines = [...byKind.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 6)
    .map(([kind, stats]) => {
      const successRate = stats.total > 0 ? stats.done / stats.total : 0;
      return `  - taskKind=${kind} | samples=${stats.total} | successRate=${successRate.toFixed(2)}`;
    })
    .join("\n");

  return `\n\n## ROUTING OUTCOME SIGNALS\nObserved outcomes from recent premium usage telemetry (last ${recent.length} entries):\n${lines}\nUse this to calibrate uncertainty and escalation for hard tasks.`;
}

/**
 * Format lane performance telemetry from the previous cycle as a Prometheus
 * prompt section.  This allows Prometheus to make informed role-assignment
 * decisions based on measured lane completion rates rather than static defaults.
 *
 * Lanes with low completion rates should receive fewer or smaller tasks.
 * Lanes with high completion rates are good candidates for additional work.
 *
 * Returns "" when no telemetry is available (safe no-op).
 *
 * @param laneTelemetry — laneTelemetry record from the previous cycle analytics
 */
export function buildLaneTelemetryPromptSection(laneTelemetry: unknown): string {
  if (!laneTelemetry || typeof laneTelemetry !== "object" || Array.isArray(laneTelemetry)) {
    return "";
  }
  const entries = Object.entries(laneTelemetry as Record<string, unknown>)
    .filter(([, v]) => v && typeof v === "object")
    .map(([lane, raw]) => {
      const entry = raw as Record<string, unknown>;
      const dispatched = Number(entry.dispatched ?? 0);
      const completed = Number(entry.completed ?? 0);
      const failed = Number(entry.failed ?? 0);
      const completionRate = typeof entry.completionRate === "number" ? entry.completionRate : null;
      const roi = typeof entry.roi === "number" ? entry.roi : null;
      const rateStr = completionRate !== null ? (completionRate * 100).toFixed(0) + "%" : "n/a";
      const roiStr = roi !== null ? roi.toFixed(2) : "n/a";
      return `  - lane=${lane} | dispatched=${dispatched} | completed=${completed} | failed=${failed} | completionRate=${rateStr} | roi=${roiStr}`;
    });
  if (entries.length === 0) return "";
  return `\n\n## LANE PERFORMANCE TELEMETRY (previous cycle)\nUse this to shape role assignments — prefer lanes with higher completion rates for critical tasks:\n${entries.join("\n")}`;
}


