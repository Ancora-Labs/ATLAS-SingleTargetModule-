/**
 * Janus — CEO AI Supervisor
 *
 * Janus activates ONCE at system startup.
 * He reads everything: GitHub state, worker sessions, last coordination, last Prometheus analysis.
 * He calls the AI agent with NO restrictions — free thinking, full analysis.
 *
 * His output:
 *   - A comprehensive directive for Prometheus including his full reasoning
 *   - Optional: request Prometheus for a fresh deep repo scan
 *   - Optional: wait if there is genuinely nothing to do
 *
 * Escalations come back to Janus via state/janus_escalation.json.
 * Janus writes his directive to state/janus_directive.json for dashboard visibility.
 */

import path from "node:path";
import { appendFileSync } from "node:fs";
import { readJson, readJsonSafe, writeJson, spawnAsync, buildIncrementalSignatureIndex, READ_JSON_REASON } from "./fs_utils.js";
import { appendProgress, appendAlert, ALERT_SEVERITY, loadCapabilityExecutionSummary, loadGovernanceBlockSummary } from "./state_tracker.js";
import { getRoleRegistry } from "./role_registry.js";
import { buildAgentArgs, parseAgentOutput, logAgentThinking } from "./agent_loader.js";
import { chatLog, emitEvent, warn } from "./logger.js";
import {
  validateLeadershipContract,
  LEADERSHIP_CONTRACT_TYPE,
  TRUST_BOUNDARY_ERROR,
} from "./trust_boundary.js";
import { getRecentCapacity, computeTrend } from "./capacity_scoreboard.js";
import {
  buildExpectedOutcome,
  computeCalibrationRecord,
  appendCalibrationHistory,
} from "./janus_calibration.js";
import { buildSpanEvent, EVENTS, EVENT_DOMAIN, JANUS_SOFT_TIMEOUT_POLICY_CONTRACT, SPAN_CONTRACT } from "./event_schema.js";
import { computeQueueViability, readPipelineProgress } from "./pipeline_progress.js";
import { resolveJanusFallbackModel, ROUTING_REASON } from "./model_policy.js";
import {
  WORKER_CYCLE_ARTIFACTS_FILE,
  migrateWorkerCycleArtifacts,
  selectWorkerCycleRecord,
  extractSessionsFromCycleRecord,
  filterStaleWorkerSessions,
  readCycleAnalytics,
  extractLatestBenchmarkRecommendations,
} from "./cycle_analytics.js";
import { buildJanusStrategyBriefArtifact } from "./plan_lifecycle_contract.js";
import { summarizeAgentControlPlane } from "./agent_control_plane.js";
import {
  AUTONOMY_EXECUTION_GATE_REASON_CODE,
  resolveAutonomyExecutionGateBlockReason,
} from "./governance_contract.js";
import {
  buildPromptTruthMaintenanceSection,
  buildPromptTruthMaintenanceSnapshot,
  collectPromptTruthSignals,
  resolveStructuredTruthRetirement,
} from "./learning_policy_compiler.js";
import { buildPromptAssemblyPrompt, resolvePromptTargetRepo } from "./prompt_overlay.js";
import { PLATFORM_MODE } from "./mode_state.js";

// ── CI system-learning debt detection ────────────────────────────────────────

/**
 * Returns true when any health finding describes CI-breaking debt in a
 * system-learning context. Used to set ciFastlaneRequired on the directive
 * so Prometheus generates a wave-1 CI-fix packet without waiting for the next
 * health audit cycle.
 */
export function hasCiSystemLearningDebt(findings: unknown[]): boolean {
  if (!Array.isArray(findings)) return false;
  const CI_DEBT_PATTERN = /\bci[-_\s]?(?:broken|break|fail(?:ed|ing)?|fix|repair)\b/i;
  return findings.some((f: any) => {
    if (!f || typeof f !== "object") return false;
    if (f.ciFastlaneRequired === true) return true;
    const severity = String(f.severity || "").trim().toLowerCase();
    if (severity !== "critical" && severity !== "warning") return false;
    const area = String(f.area || "").trim().toLowerCase();
    // Freshness gate: system-learning findings annotated with a live CI-success signal
    // reference past failures that have already been resolved.  Suppress them so stale
    // lesson debt does not force an unnecessary wave-1 CI-fix fastlane.
    if (
      area === "system-learning" &&
      String(f.latestMainCiConclusion || "").trim().toLowerCase() === "success"
    ) return false;
    const text = `${String(f.finding || "")} ${String(f.remediation || "")}`;
    return (
      area === "ci"
      || f.capabilityNeeded === "ci-fix"
      || (area === "system-learning" && CI_DEBT_PATTERN.test(text))
      || CI_DEBT_PATTERN.test(text)
    );
  });
}

const AUTONOMY_DEBT_PRIORITY_LEAD = "Resolve autonomy execution debt before feature work";

function normalizeDirectiveStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function extractKnowledgeMemoryLessons(knowledgeMemory: unknown): unknown[] {
  if (!knowledgeMemory || typeof knowledgeMemory !== "object" || Array.isArray(knowledgeMemory)) return [];
  const record = knowledgeMemory as Record<string, unknown>;
  const workingLessons = record.working && typeof record.working === "object" && Array.isArray((record.working as Record<string, unknown>).lessons)
    ? (record.working as Record<string, unknown>).lessons as unknown[]
    : [];
  const episodicLessons = record.episodic && typeof record.episodic === "object" && Array.isArray((record.episodic as Record<string, unknown>).lessons)
    ? (record.episodic as Record<string, unknown>).lessons as unknown[]
    : [];
  const flatLessons = Array.isArray(record.lessons) ? record.lessons as unknown[] : [];
  return Number(record.schemaVersion) >= 2
    ? [...workingLessons, ...episodicLessons]
    : flatLessons;
}

function isSingleTargetLeadershipIsolationActive(config: any): boolean {
  return config?.platformModeState?.currentMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY
    && Boolean(config?.activeTargetSession?.sessionId);
}

export function resolveDirectiveTargetSessionStamp(config: any): Record<string, unknown> | null {
  if (!isSingleTargetLeadershipIsolationActive(config)) {
    return null;
  }

  return {
    projectId: config.activeTargetSession.projectId,
    sessionId: config.activeTargetSession.sessionId,
    currentStage: config.activeTargetSession.currentStage,
    repoUrl: config.activeTargetSession.repo?.repoUrl || null,
  };
}

export function isDirectiveAlignedToTargetSession(config: any, directive: any): boolean {
  const runtimeTargetSession = resolveDirectiveTargetSessionStamp(config);
  const directiveTargetSession = directive?.targetSession && typeof directive.targetSession === "object"
    ? directive.targetSession
    : null;

  if (!runtimeTargetSession) {
    return !directiveTargetSession;
  }
  if (!directiveTargetSession) {
    return false;
  }

  return String(directiveTargetSession.projectId || "") === String(runtimeTargetSession.projectId || "")
    && String(directiveTargetSession.sessionId || "") === String(runtimeTargetSession.sessionId || "");
}

export function stampDirectiveTargetSession(config: any, directive: any): any {
  if (!directive || typeof directive !== "object") return directive;
  const runtimeTargetSession = resolveDirectiveTargetSessionStamp(config);
  if (!runtimeTargetSession) {
    if (directive.targetSession) {
      delete directive.targetSession;
    }
    return directive;
  }

  directive.targetSession = runtimeTargetSession;
  return directive;
}

function normalizeGitHubRepoIdentifier(repo: unknown): string | null {
  const raw = String(repo || "").trim();
  if (!raw) return null;
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) return raw;
  const match = raw.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function buildAutonomyDebtPriority(reasonCode: string, blockReason: string | null): string {
  const normalizedReasonCode = String(reasonCode || AUTONOMY_EXECUTION_GATE_REASON_CODE).trim() || AUTONOMY_EXECUTION_GATE_REASON_CODE;
  const normalizedBlockReason = String(blockReason || "").trim();
  return normalizedBlockReason
    ? `${AUTONOMY_DEBT_PRIORITY_LEAD} (${normalizedReasonCode}; ${normalizedBlockReason})`
    : `${AUTONOMY_DEBT_PRIORITY_LEAD} (${normalizedReasonCode})`;
}

function prependDirectivePriority(directive: Record<string, unknown>, priority: string): Record<string, unknown> {
  const normalizedPriority = String(priority || "").trim();
  if (!normalizedPriority) return directive;
  const existingPriorities = normalizeDirectiveStringList(directive?.priorities);
  return {
    ...directive,
    priorities: [normalizedPriority, ...existingPriorities.filter((entry) => entry !== normalizedPriority)],
  };
}

function findAutonomyDebtHealthFinding(findings: unknown[]): Record<string, unknown> | null {
  if (!Array.isArray(findings)) return null;
  return findings.find((finding): finding is Record<string, unknown> => {
    if (!finding || typeof finding !== "object") return false;
    const findingRecord = finding as Record<string, unknown>;
    return String(findingRecord.area || "").trim().toLowerCase() === "autonomy-debt"
      && String(findingRecord.reasonCode || "").trim().toLowerCase() === AUTONOMY_EXECUTION_GATE_REASON_CODE;
  }) ?? null;
}

async function readAutonomyDebtHealthFinding(config: unknown): Promise<Record<string, unknown> | null> {
  const configPaths = config
    && typeof config === "object"
    && (config as Record<string, unknown>).paths
    && typeof (config as Record<string, unknown>).paths === "object"
    ? (config as Record<string, unknown>).paths as Record<string, unknown>
    : null;
  const stateDir = typeof configPaths?.stateDir === "string" && configPaths.stateDir.trim()
    ? configPaths.stateDir
    : "state";
  const autonomyBandStatusPath = path.join(stateDir, "autonomy_band_status.json");
  const autonomyBandStatusResult = await readJsonSafe(autonomyBandStatusPath);
  if (!autonomyBandStatusResult.ok) {
    if (autonomyBandStatusResult.reason === READ_JSON_REASON.INVALID) {
      warn(`[janus_supervisor] autonomy band status unreadable: ${autonomyBandStatusPath}`);
    }
    return null;
  }
  const autonomyExecutionGate = resolveAutonomyExecutionGateBlockReason(autonomyBandStatusResult.data);
  if (!autonomyExecutionGate.blocked || !autonomyExecutionGate.reasonCode) {
    return null;
  }
  const blockReason = autonomyExecutionGate.blockReason || autonomyExecutionGate.reasonCode;
  return {
    area: "autonomy-debt",
    severity: "warning",
    finding: `Autonomy execution readiness is not ready for feature delivery (${blockReason})`,
    remediation: "Prioritize autonomy correction work and subordinate feature work until executionGate.exploitationReady becomes true",
    capabilityNeeded: "autonomy-correction",
    reasonCode: autonomyExecutionGate.reasonCode,
    blockReason,
    strategyPriority: buildAutonomyDebtPriority(autonomyExecutionGate.reasonCode, blockReason),
  };
}

// ── Span contract emitter ─────────────────────────────────────────────────────

/** Canonical agent identifier for Janus in span events. */
export const JANUS_AGENT_ID = "janus";
export const JANUS_WARNING_CODE = Object.freeze({
  DECISION_LATENCY_WARNING: "JANUS_DECISION_LATENCY_WARNING",
  LATENCY_ESCALATION: "JANUS_LATENCY_ESCALATION",
  LATENCY_FALLBACK_ACTIVATED: "JANUS_LATENCY_FALLBACK_ACTIVATED",
});

export function formatJanusTierEscalationMessage(
  previousTier: { label?: string; timeoutMs?: number; model?: string },
  nextTier: { label?: string; timeoutMs?: number; model?: string },
  routingReason: string,
): string {
  const previousLabel = String(previousTier?.label || "T?");
  const nextLabel = String(nextTier?.label || "T?");
  const previousTimeoutSec = Math.floor(Math.max(0, Number(previousTier?.timeoutMs || 0)) / 1000);
  const nextTimeoutSec = Math.floor(Math.max(0, Number(nextTier?.timeoutMs || 0)) / 1000);
  const nextModel = String(nextTier?.model || "unknown");
  const isFallbackActivation = routingReason === ROUTING_REASON.JANUS_LATENCY_FALLBACK;
  if (isFallbackActivation) {
    return `[JANUS] ${previousLabel} reached its ${previousTimeoutSec}s tier budget — activating ${nextLabel} (timeout=${nextTimeoutSec}s model=${nextModel} reason=${routingReason})`;
  }
  return `[JANUS] ${previousLabel} timed out after ${previousTimeoutSec}s — escalating to ${nextLabel} (timeout=${nextTimeoutSec}s model=${nextModel} reason=${routingReason})`;
}

export function shouldWarnJanusDecisionLatency(elapsedMs: number, warningThresholdMs: number): boolean {
  const safeElapsedMs = Number.isFinite(elapsedMs) ? Number(elapsedMs) : 0;
  const safeThresholdMs = Number.isFinite(warningThresholdMs) ? Number(warningThresholdMs) : 900_000;
  return safeElapsedMs >= Math.max(1, safeThresholdMs);
}

export function hasReachedJanusSoftTimeout(elapsedMs: number, softTimeoutMs: number): boolean {
  const safeElapsedMs = Number.isFinite(elapsedMs) ? Number(elapsedMs) : 0;
  const safeSoftTimeoutMs = Number.isFinite(softTimeoutMs) ? Number(softTimeoutMs) : 600_000;
  return safeElapsedMs >= Math.max(1, safeSoftTimeoutMs);
}

/**
 * Build a PLANNING_STAGE_TRANSITION span event for Janus.
 * Conforms to SPAN_CONTRACT: stamps spanId, parentSpanId, traceId, agentId.
 *
 * @param correlationId — non-empty cycle trace ID
 * @param stageFrom     — stage being left (one of ORCHESTRATION_LOOP_STEPS)
 * @param stageTo       — stage being entered
 * @param opts          — optional parentSpanId, durationMs
 * @returns validated event envelope
 */
export function emitJanusSpanTransition(
  correlationId: string,
  stageFrom: string,
  stageTo: string,
  opts: { parentSpanId?: string | null; durationMs?: number | null } = {},
) {
  return buildSpanEvent(
    EVENTS.PLANNING_STAGE_TRANSITION,
    EVENT_DOMAIN.PLANNING,
    correlationId,
    { agentId: JANUS_AGENT_ID, parentSpanId: opts.parentSpanId ?? null },
    {
      [SPAN_CONTRACT.stageTransition.taskId]:     null,
      [SPAN_CONTRACT.stageTransition.stageFrom]:  stageFrom,
      [SPAN_CONTRACT.stageTransition.stageTo]:    stageTo,
      [SPAN_CONTRACT.stageTransition.durationMs]: opts.durationMs ?? null,
    },
  );
}

async function _callCopilotAgent(command, agentSlug, contextPrompt) {
  const args = buildAgentArgs({ agentSlug, prompt: contextPrompt, allowAll: true, noAskUser: true });
  const result: any = await spawnAsync(command, args, {
    env: process.env,
    timeoutMs: 180_000,
    // Kill CLI immediately when output is complete — avoids hanging in
    // interactive 'continue?' mode that Copilot CLI enters after long outputs.
    earlyExitMarker: "===END===",
  });
  const stdout = result.stdout;
  const stderr = result.stderr;
  if (result.status !== 0) {
    return { ok: false, raw: stdout || stderr, parsed: null, thinking: "", error: `exited ${result.status}` };
  }
  return parseAgentOutput(stdout || stderr);
}

function liveLogPath(stateDir: string): string {
  return path.join(stateDir, "live_worker_janus.log");
}

function appendLiveLogSync(stateDir: string, text: string): void {
  try {
    appendFileSync(liveLogPath(stateDir), text, "utf8");
  } catch { /* best-effort */ }
}

function appendPromptPreviewSync(stateDir: string, promptText: string): void {
  const prompt = String(promptText || "").trim();
  if (!prompt) return;
  appendLiveLogSync(
    stateDir,
    [
      "",
      "[janus_runtime_prompt_start]",
      prompt,
      "[janus_runtime_prompt_end]",
      ""
    ].join("\n")
  );
}

// ── Hierarchical System Health Audit ─────────────────────────────────────────
// Janus runs this audit on every cycle. It checks for structural problems that
// workers and Athena might have missed. When gaps are found, they're injected
// into the Janus directive as specific remediation items AND fed to the self-
// improvement system as capability gaps.


/**
 * Load capability-gap source evidence using an incremental per-file hash cache.
 * Only re-reads files whose content has changed since the last call, reducing
 * decision latency from O(N×fileSize) full concatenation to O(changed×fileSize).
 *
 * Returns a Set<string> of all lowercase signature strings found across the
 * source tree — same semantics as the old string index but without allocating
 * a giant concatenated string on every cycle.
 */
async function loadSourceEvidenceIndex(repoRoot: string): Promise<Set<string>> {
  const srcDir = path.join(repoRoot, "src");
  const allSignatures = Object.values(CAPABILITY_SOURCE_SIGNATURES).flat();
  try {
    return await buildIncrementalSignatureIndex(srcDir, allSignatures);
  } catch {
    return new Set<string>();
  }
}

/**
 * Deterministic capability signature registry.
 * Each entry maps a known capability ID to an exhaustive list of source-level
 * identifiers that MUST ALL be present for the capability to be considered
 * implemented.  Only capabilities with explicit entries in this registry can
 * be downgraded — all others stay at their original severity so they remain
 * actionable.  Heuristic substring / proposedFix / gapText matching has been
 * removed because it produced false-positives that suppressed real findings.
 */
const CAPABILITY_SOURCE_SIGNATURES: Readonly<Record<string, string[]>> = Object.freeze({
  "dispatch-block-reason-reporting":      ["dispatchblockreason", "dispatch blocked"],
  "janus-findings-to-plan-requirements":  ["mandatory_tasks", "buildmandatorytaskspromptsection", "extractmandatoryhealthauditfindings"],
  "athena-gate-pre-check":                ["gateblockrisk"],
  "athena-gate-feasibility-check":        ["gateblockrisk"],
  "athena-correction-fidelity-tracking":  ["aretrackedfieldvaluesequal", "legacycorrections", "repairedfields"],
  "prometheus-plan-structural-lint":      ["validateallplans", "plan_contract_validator"],
  "pre-athena-plan-structural-validation":["validateallplans", "plan_contract_validator"],
  "prometheus-token-budget-floor":        ["invalid_token_budget", "minimum token budgets", "token floor"],
  "ci-failure-log-injection":             ["hydratedispatchcontextwithcievidence", "ci failure evidence", "injectcifailurecontextifmissing"],
  "governance-gate-token-enforcement":    ["resolveathenacorrectiondispatchblockreason", "athena_correction_token", "rolling_yield_throttle", "autonomy_execution_gate_not_ready"],
  "packet-granularity-governor":          ["max_actionable_steps_per_packet", "autosplitpacket"],
  "output-fidelity-gate":                 ["detectprocessthoughtmarkers", "output-fidelity-gate"],
  "pre-wave-diversity-validation":        ["evaluatepredispatchgovernancegate", "lane_diversity_gate_blocked", "pre-dispatch governance gate"],
  "specialization-admission-control":     ["specialization_admission", "laneadmissiongate"],
});

type CapabilityExecutionEvidenceMatcher = Readonly<{
  capability: string;
  contextIncludes?: readonly string[];
}>;

const CAPABILITY_EXECUTION_EVIDENCE: Readonly<Record<string, readonly CapabilityExecutionEvidenceMatcher[]>> = Object.freeze({
  "athena-correction-fidelity-tracking": [
    { capability: "athena-review-entry" },
    { capability: "athena-review-exit" },
  ],
  "governance-gate-token-enforcement": [
    { capability: "athena-review-exit" },
    { capability: "dispatch-block-reason-reporting", contextIncludes: ["athena_correction_token"] },
    { capability: "governance-gate-evaluation" },
  ],
  "pre-wave-diversity-validation": [
    { capability: "dispatch-block-reason-reporting", contextIncludes: ["pre_dispatch_gate", "lane_diversity_gate_blocked"] },
    { capability: "governance-gate-evaluation" },
  ],
});

function getCapabilityExecutionEvidenceMatchers(capability: string): readonly CapabilityExecutionEvidenceMatcher[] {
  return CAPABILITY_EXECUTION_EVIDENCE[capability] ?? [{ capability }];
}

function getCapabilityExecutionEvidenceTimestamp(
  capabilityExecutionSummary: { recentTraces?: Array<{ capability?: string; observedAt?: string; context?: string }> } | null | undefined,
  capability: string,
): string | null {
  const traces = Array.isArray(capabilityExecutionSummary?.recentTraces)
    ? capabilityExecutionSummary.recentTraces
    : [];
  const matchers = getCapabilityExecutionEvidenceMatchers(capability);
  let latestTimestamp: number | null = null;

  for (const trace of traces) {
    const traceCapability = String(trace?.capability || "").trim().toLowerCase();
    if (!traceCapability) continue;
    const traceContext = String(trace?.context || "").toLowerCase();
    const matched = matchers.some((matcher) => {
      if (traceCapability !== matcher.capability) return false;
      return !matcher.contextIncludes || matcher.contextIncludes.every((snippet) => traceContext.includes(snippet));
    });
    if (!matched) continue;
    const observedAt = Date.parse(String(trace?.observedAt || ""));
    if (!Number.isFinite(observedAt)) continue;
    if (latestTimestamp == null || observedAt > latestTimestamp) {
      latestTimestamp = observedAt;
    }
  }

  return latestTimestamp == null ? null : new Date(latestTimestamp).toISOString();
}

/**
 * Return true only when ALL required source signatures for a known capability
 * are found in the signature index Set AND the capability has a recent execution
 * trace proving it was invoked in the active runtime path.
 *
 * Both gates must pass for a finding to be downgraded:
 *   1. Source-presence gate  — all declared signatures exist in source files.
 *   2. Execution-trace gate  — capability ID appears in the recent trace log,
 *      meaning it was actually called during a previous cycle (not just compiled).
 *
 * Unknown capabilities (not in the registry) always return false so their
 * findings remain actionable.
 */
function isCapabilityGapVerifiedPresentAndExecuted(
  sourceIndex: Set<string>,
  capabilityExecutionSummary: { recentTraces?: Array<{ capability?: string; observedAt?: string; context?: string }> } | null | undefined,
  gap: { capability?: unknown },
): boolean {
  if (!sourceIndex || sourceIndex.size === 0) return false;
  const capability = String(gap?.capability || "").trim().toLowerCase();
  const signatures = CAPABILITY_SOURCE_SIGNATURES[capability];
  if (!signatures || signatures.length === 0) return false;
  const sourcePresent = signatures.every((sig) => sourceIndex.has(sig));
  const executionPresent = getCapabilityExecutionEvidenceTimestamp(capabilityExecutionSummary, capability) != null;
  return sourcePresent && executionPresent;
}

export async function runSystemHealthAudit(
  config,
  githubState,
  AthenaCoordination,
  sessions,
  sessionMeta?: { source: "canonical" | "legacy" | "empty"; cycleId: string | null },
) {
  const findings = [];

  // 1. CI Health — is main branch green?
  if (githubState.latestMainCi) {
    if (githubState.latestMainCi.conclusion !== "success") {
      findings.push({
        area: "ci",
        severity: "critical",
        finding: `CI on ${githubState.latestMainCi.branch} is ${githubState.latestMainCi.conclusion} (commit ${githubState.latestMainCi.commit})`,
        remediation: "Dispatch a worker to fix CI immediately — broken main blocks all progress",
        capabilityNeeded: "ci-fix"
      });
    }
  } else {
    findings.push({
      area: "ci",
      severity: "warning",
      finding: "No CI runs found on default branch — CI may not be configured",
      remediation: "Set up GitHub Actions CI workflow if missing",
      capabilityNeeded: "ci-setup"
    });
  }

  const autonomyDebtFinding = await readAutonomyDebtHealthFinding(config);
  if (autonomyDebtFinding) {
    findings.push(autonomyDebtFinding);
  }

  // 2. Failed CI runs on open PR branches
  if (githubState.failedCiRuns.length > 0) {
    const latestMainSuccessful = githubState?.latestMainCi?.conclusion === "success";
    const latestMainUpdatedAt = githubState?.latestMainCi?.updatedAt
      ? new Date(githubState.latestMainCi.updatedAt).getTime()
      : Number.NaN;
    const latestMainHeadSha = String(githubState?.latestMainCi?.headSha || "");

    for (const run of githubState.failedCiRuns) {
      if (latestMainSuccessful) {
        const runUpdatedAt = run?.updatedAt ? new Date(run.updatedAt).getTime() : Number.NaN;
        const preHead = Boolean(latestMainHeadSha && run?.headSha && run.headSha !== latestMainHeadSha);
        const supersededByLatestMain =
          Number.isFinite(runUpdatedAt) &&
          Number.isFinite(latestMainUpdatedAt) &&
          runUpdatedAt <= latestMainUpdatedAt;
        if (preHead || supersededByLatestMain) {
          continue;
        }
      }

      findings.push({
        area: "ci",
        severity: "warning",
        finding: `Failed CI: ${run.name} on branch ${run.branch} (${run.commit})`,
        remediation: `Fix CI failure on ${run.branch} — this blocks PR merge`,
        capabilityNeeded: "ci-fix"
      });
    }
  }

  // 3. Stale PRs — open PRs that might be abandoned or forgotten
  if (githubState.pullRequests.length > 0) {
    const stalePRs = githubState.pullRequests.filter(p => !p.draft);
    if (stalePRs.length > 3) {
      findings.push({
        area: "github-hygiene",
        severity: "warning",
        finding: `${stalePRs.length} open non-draft PRs — possible stale or duplicate PRs`,
        remediation: "Review open PRs: close duplicates, merge ready ones, or update stale ones",
        capabilityNeeded: "pr-management"
      });
    }
  }

  // 4. Worker session health — detect stuck or errored workers.
  // When sessions came from the legacy worker_sessions.json file (not the canonical
  // worker_cycle_artifacts.json), worker-health findings are tagged with a reduced
  // livenessSource so downstream planners can trust them with appropriate caution.
  const livenessSource = sessionMeta?.source ?? "canonical";
  const workerIssues = [];
  for (const [role, session] of Object.entries(sessions) as any[]) {
    if (session?.status === "error") {
      workerIssues.push(`${role}: errored`);
    }
    if (session?.status === "working") {
      const lastActive = session.lastActiveAt
        ? new Date(session.lastActiveAt).getTime()
        : session.startedAt
          ? new Date(session.startedAt).getTime()
          : null;
      // Only report stuck when we have a meaningful timestamp; skip if neither
      // lastActiveAt nor startedAt is present to avoid Infinity false positives.
      if (lastActive === null) continue;
      const minutesSinceActive = (Date.now() - lastActive) / 60000;
      // Guard against NaN (invalid date string) or Infinity (Date parsing failure).
      // Non-finite values would produce false positives or crash toFixed().
      if (!Number.isFinite(minutesSinceActive)) continue;
      if (minutesSinceActive > 60) {
        workerIssues.push(`${role}: stuck working for ${minutesSinceActive.toFixed(0)}m`);
      }
    }
  }
  if (workerIssues.length > 0) {
    findings.push({
      area: "worker-health",
      severity: "warning",
      finding: `Worker issues detected: ${workerIssues.join("; ")}`,
      remediation: "Reset stuck workers, investigate error causes",
      capabilityNeeded: "worker-recovery",
      // Provenance: downstream planners should not treat legacy-sourced liveness
      // findings as authoritative — canonical artifacts are the ground truth.
      ...(livenessSource !== "canonical" ? { livenessSource, livenessConfidence: "low" } : {}),
    });
  }

  // 5. Athena coordination gaps — did Athena complete all planned waves?
  const completedTasks = Array.isArray(AthenaCoordination?.completedTasks)
    ? AthenaCoordination.completedTasks : [];
  const executionWaves = Array.isArray(AthenaCoordination?.executionStrategy?.waves)
    ? AthenaCoordination.executionStrategy.waves : [];
  if (executionWaves.length > 0) {
    const completedTaskSet = new Set<string>(completedTasks.map(t => String(t).trim()));
    const incompleteWaves = executionWaves.filter(w => {
      const waveTasks = Array.isArray(w?.tasks) ? w.tasks : null;
      // Only flag a wave as incomplete when it has an explicit tasks list
      // and at least one task in that list is not yet in completedTasks.
      // Without an explicit tasks list, we cannot determine incompleteness
      // from task IDs alone — skip to avoid substring-match false positives.
      if (waveTasks === null || waveTasks.length === 0) return false;
      return !waveTasks.every(t => completedTaskSet.has(String(t).trim()));
    });
    if (incompleteWaves.length > 0) {
      findings.push({
        area: "execution-gaps",
        severity: "warning",
        finding: `${incompleteWaves.length} wave(s) not yet completed: ${incompleteWaves.map(w => w.id).join(", ")}`,
        remediation: "Continue execution of incomplete waves in next Athena cycle",
        capabilityNeeded: "wave-continuation"
      });
    }
  }

  // 6. Knowledge memory — check if self-improvement detected critical issues
  try {
    const stateDir = config.paths?.stateDir || "state";
    const km = await readJson(path.join(stateDir, "knowledge_memory.json"), {});
    // Support v1 (flat .lessons) and v2 (partitioned .working.lessons + .episodic.lessons)
    const workingLessons  = Array.isArray(km.working?.lessons)  ? km.working.lessons  : [];
    const episodicLessons = Array.isArray(km.episodic?.lessons) ? km.episodic.lessons : [];
    const flatLessons     = Array.isArray(km.lessons)           ? km.lessons          : [];
    const allLessons = km.schemaVersion >= 2
      ? [...workingLessons, ...episodicLessons]
      : flatLessons;
    const criticalLessons = allLessons.filter(l => l.severity === "critical").slice(-3);
    const capGaps = Array.isArray(km.capabilityGaps) ? km.capabilityGaps.slice(-5) : [];
    const sourceIndex = await loadSourceEvidenceIndex(process.cwd());
    const capabilityExecutionSummary = await loadCapabilityExecutionSummary(config);

    if (criticalLessons.length > 0) {
      // Annotate with the live CI conclusion so hasCiSystemLearningDebt (and downstream
      // consumers) can distinguish stale CI-break debt from active failures.
      const liveMainCiConclusion = String(githubState?.latestMainCi?.conclusion || "").trim().toLowerCase();
      findings.push({
        area: "system-learning",
        severity: "warning",
        finding: `Self-improvement flagged ${criticalLessons.length} critical lesson(s): ${criticalLessons.map(l => l.lesson).join("; ").slice(0, 300)}`,
        remediation: "Address critical lessons in next cycle planning",
        capabilityNeeded: "system-improvement",
        ...(liveMainCiConclusion ? { latestMainCiConclusion: liveMainCiConclusion } : {}),
      });
    }

    if (capGaps.length > 0) {
      for (const gap of capGaps.slice(0, 3)) {
        const originalSeverity = String(gap?.severity || "warning").toLowerCase();
        const verifiedPresent = isCapabilityGapVerifiedPresentAndExecuted(sourceIndex, capabilityExecutionSummary, gap);
        const shouldDowngrade =
          verifiedPresent && (originalSeverity === "critical" || originalSeverity === "warning" || originalSeverity === "important");
        findings.push({
          area: "capability-gap",
          severity: shouldDowngrade ? "info" : (gap.severity || "warning"),
          finding: `Missing capability: ${gap.gap}`,
          remediation: gap.proposedFix || "Add missing capability to system",
          capabilityNeeded: gap.capability || "unknown",
          ...(shouldDowngrade ? { note: "verified_present_in_source_and_executed" } : {})
        });
      }
    }
  } catch { /* knowledge memory not available — no-op */ }

  return findings;
}

function formatHealthAuditFindings(findings) {
  if (findings.length === 0) return "  No structural issues detected — system is healthy.";

  return findings.map((f, i) => {
    const icon = f.severity === "critical" ? "🔴" : f.severity === "warning" ? "🟡" : "🟢";
    return `  ${i + 1}. ${icon} [${f.area}] ${f.finding}\n     → ${f.remediation}`;
  }).join("\n");
}

// ── GitHub Intelligence ──────────────────────────────────────────────────────

async function fetchGitHubState(config) {
  const token = config?.env?.githubToken;
  const repo = normalizeGitHubRepoIdentifier(resolvePromptTargetRepo(config));
  if (!token || !repo) {
    return {
      issues: [],
      pullRequests: [],
      repoInfo: null,
      latestMainCi: null,
      failedCiRuns: [],
      recentlyMergedPrs: [],
    };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "BOX/1.0"
  };

  async function ghGet(url) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  const base = `https://api.github.com/repos/${repo}`;
  const [issues, prs, repoInfo, recentRuns, mergedPrs] = await Promise.all([
    ghGet(`${base}/issues?state=open&per_page=20&sort=updated`),
    ghGet(`${base}/pulls?state=open&per_page=20&sort=updated`),
    ghGet(base),
    ghGet(`${base}/actions/runs?per_page=15`),
    ghGet(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=10`)
  ]);

  const defaultBranch = (repoInfo as any)?.default_branch || "main";
  const allRuns = Array.isArray((recentRuns as any)?.workflow_runs) ? (recentRuns as any).workflow_runs : [];

  // Latest completed run on default branch — the real CI health signal
  const mainRuns = allRuns.filter(r => r.head_branch === defaultBranch && r.status === "completed");
  const latestMainRun = mainRuns[0] || null;

  // Only count failures from the last 24 hours on branches with open PRs or the default branch
  const cutoff = Date.now() - 86400000;
  const openPrBranches = new Set(
    (Array.isArray(prs) ? prs : []).map(p => p.head?.ref).filter(Boolean)
  );
  openPrBranches.add(defaultBranch);
  const recentFailures = allRuns
    .filter(r => r.conclusion === "failure" &&
      new Date(r.updated_at).getTime() > cutoff &&
      openPrBranches.has(r.head_branch))
    .slice(0, 5);

  return {
    issues: Array.isArray(issues) ? issues.slice(0, 15).map(i => ({ number: i.number, title: i.title, labels: i.labels?.map(l => l.name) || [], state: i.state })) : [],
    pullRequests: Array.isArray(prs) ? prs.slice(0, 10).map(p => ({ number: p.number, title: p.title, state: p.state, draft: p.draft })) : [],
    repoInfo: repoInfo ? { name: (repoInfo as any).name, defaultBranch: (repoInfo as any).default_branch, openIssuesCount: (repoInfo as any).open_issues_count } : null,
    latestMainCi: latestMainRun ? {
      runId: latestMainRun.id,
      conclusion: latestMainRun.conclusion,
      branch: latestMainRun.head_branch,
      headSha: latestMainRun.head_sha,
      commit: latestMainRun.head_sha?.slice(0, 7),
      updatedAt: latestMainRun.updated_at,
      htmlUrl: latestMainRun.html_url
    } : null,
    failedCiRuns: recentFailures.map(r => ({
      runId: r.id,
      name: r.name,
      branch: r.head_branch,
      headSha: r.head_sha,
      commit: r.head_sha?.slice(0, 7),
      conclusion: r.conclusion,
      updatedAt: r.updated_at,
      htmlUrl: r.html_url
    })),
    recentlyMergedPrs: Array.isArray(mergedPrs)
      ? mergedPrs.filter(p => p.merged_at).slice(0, 10).map(p => ({
          number: p.number,
          title: p.title,
          mergedAt: p.merged_at
        }))
      : []
  };
}

// ── Directive Payload Validation ─────────────────────────────────────────────

/**
 * Required string fields in a valid Janus directive payload.
 * These fields must be present and non-empty for the directive to be actionable.
 */
const REQUIRED_DIRECTIVE_STRING_FIELDS = ["decision", "systemHealth"] as const;

/**
 * Required boolean fields in a valid Janus directive payload.
 */
const REQUIRED_DIRECTIVE_BOOLEAN_FIELDS = ["wakeAthena", "callPrometheus"] as const;

/**
 * Valid health state values that produce measurable expectedOutcome forecasts.
 * "unknown" is permitted only as a transient system state, not as a stable forecast.
 */
const MEASURABLE_HEALTH_STATES = new Set(["good", "degraded", "critical", "unknown"]);

/**
 * Valid decision type values that produce meaningful calibration predictions.
 */
const VALID_DECISION_TYPES = new Set(["tactical", "strategic", "emergency", "wait"]);

/**
 * Validate that a directive payload has all required fields and that the
 * `expectedOutcome` block contains measurable (non-null, non-degenerate) values.
 *
 * "Fail-close" semantics:
 *   - If required fields are missing or have wrong types, `valid: false` is returned.
 *   - Callers should degrade to a safe fallback directive instead of writing an
 *     incomplete payload to disk.
 *
 * @param directive - The assembled directive object (post AI-parse, pre-write).
 * @param expectedOutcome - The expectedOutcome block attached to the directive.
 * @returns {{ valid: boolean, gaps: string[], hasMeasurableOutcome: boolean }}
 */

/**
 * Strip operational tool traces and free-form internal reasoning from a directive
 * text field before persistence.  Prevents tool_call lines, thinking blocks, and
 * role prefixes from leaking into janus_directive.json and polluting downstream
 * planning context for Prometheus.
 *
 * Exported for testing.
 */
export function sanitizeDirectiveFieldForPersistence(text: string): string {
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
    return true;
  });
  return filtered.join("\n").trim();
}

export function validateDirectivePayload(
  directive: Record<string, unknown>,
  expectedOutcome: Record<string, unknown>
): { valid: boolean; gaps: string[]; hasMeasurableOutcome: boolean } {
  const gaps: string[] = [];
  const shouldRequirePrometheusBrief = directive.callPrometheus === true;

  // Check required string fields
  for (const field of REQUIRED_DIRECTIVE_STRING_FIELDS) {
    const value = directive[field];
    if (value === null || value === undefined || String(value).trim() === "") {
      gaps.push(`directive.${field} is required but missing or empty`);
    }
  }

  if (shouldRequirePrometheusBrief) {
    const briefForPrometheus = directive.briefForPrometheus;
    if (briefForPrometheus === null || briefForPrometheus === undefined || String(briefForPrometheus).trim() === "") {
      gaps.push("directive.briefForPrometheus is required but missing or empty when callPrometheus=true");
    }
  }

  // Check required boolean fields
  for (const field of REQUIRED_DIRECTIVE_BOOLEAN_FIELDS) {
    if (typeof directive[field] !== "boolean") {
      gaps.push(`directive.${field} must be a boolean (got ${typeof directive[field]})`);
    }
  }

  // Validate decision type is a recognised value
  const decision = String(directive.decision || "").toLowerCase();
  if (decision && !VALID_DECISION_TYPES.has(decision)) {
    gaps.push(`directive.decision "${decision}" is not a valid decision type (expected: tactical|strategic|emergency|wait)`);
  }

  // Validate expectedOutcome has measurable fields
  const hasMeasurableOutcome = validateExpectedOutcomeMeasurable(expectedOutcome);
  if (!hasMeasurableOutcome) {
    gaps.push("expectedOutcome is missing required measurable fields — calibration will be unreliable");
  }

  return { valid: gaps.length === 0, gaps, hasMeasurableOutcome };
}

/**
 * Check whether an expectedOutcome block has all required measurable fields.
 *
 * Measurable means: all 6 fields are present and non-null, with concrete values
 * that can be compared against realized outcomes for calibration scoring.
 */
export function validateExpectedOutcomeMeasurable(expectedOutcome: Record<string, unknown>): boolean {
  if (!expectedOutcome || typeof expectedOutcome !== "object") return false;

  const requiredFields = [
    "expectedSystemHealthAfter",
    "expectedNextDecision",
    "expectedAthenaActivated",
    "expectedPrometheusRan",
    "expectedWorkItemCount",
    "forecastConfidence",
  ];

  for (const field of requiredFields) {
    const value = expectedOutcome[field];
    if (value === null || value === undefined) return false;
  }

  // Verify health and decision fields are concrete (in known valid sets)
  const healthAfter = String(expectedOutcome.expectedSystemHealthAfter || "");
  const nextDecision = String(expectedOutcome.expectedNextDecision || "");

  if (!MEASURABLE_HEALTH_STATES.has(healthAfter)) return false;
  if (!VALID_DECISION_TYPES.has(nextDecision)) return false;
  if (typeof expectedOutcome.expectedAthenaActivated !== "boolean") return false;
  if (typeof expectedOutcome.expectedPrometheusRan !== "boolean") return false;
  if (typeof expectedOutcome.expectedWorkItemCount !== "number") return false;

  return true;
}

export function buildDirectiveStrategyBrief(
  directive: Record<string, unknown>,
  expectedOutcome: Record<string, unknown>,
  opts: { repo?: string | null; emittedAt?: string } = {},
) {
  const autonomyExecutionDebt = directive?.autonomyExecutionDebt && typeof directive.autonomyExecutionDebt === "object"
    ? directive.autonomyExecutionDebt as Record<string, unknown>
    : null;
  const autonomyPriority = autonomyExecutionDebt?.active === true
    ? buildAutonomyDebtPriority(
      String(autonomyExecutionDebt.reasonCode || AUTONOMY_EXECUTION_GATE_REASON_CODE),
      typeof autonomyExecutionDebt.blockReason === "string" ? autonomyExecutionDebt.blockReason : null,
    )
    : "";
  const prioritizedDirective = autonomyPriority
    ? prependDirectivePriority(directive, autonomyPriority)
    : directive;
  return buildJanusStrategyBriefArtifact(prioritizedDirective, expectedOutcome, opts);
}

export function reconcileLeadershipHealthFindings(
  healthFindings: unknown[],
  opts: { latestMainCiConclusion?: unknown; resolvedAt?: string } = {},
): {
  activeFindings: Record<string, unknown>[];
  resolvedLineage: Record<string, unknown>[];
} {
  const latestMainCiConclusion = String(opts.latestMainCiConclusion || "").trim().toLowerCase();
  const liveMainCiSuccess = latestMainCiConclusion === "success";
  const resolvedAt = String(opts.resolvedAt || "").trim() || new Date().toISOString();
  const activeFindings: Record<string, unknown>[] = [];
  const resolvedLineage: Record<string, unknown>[] = [];
  const CI_DEBT_PATTERN = /\bci[-_\s]?(?:broken|break|fail(?:ed|ing)?|fix|repair)\b/i;

  for (const finding of Array.isArray(healthFindings) ? healthFindings : []) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) continue;
    const entry = finding as Record<string, unknown>;
    const area = String(entry.area || "").trim().toLowerCase();
    const capability = String(entry.capabilityNeeded || "").trim().toLowerCase();
    const text = `${String(entry.finding || "")} ${String(entry.remediation || "")}`.trim();
    const structuredRetirement = resolveStructuredTruthRetirement(entry, text);
    const isCiBreak = area === "ci" && (capability === "ci-fix" || capability === "ci-setup");
    const isSystemLearningCiDebt = area === "system-learning" && CI_DEBT_PATTERN.test(text);
    const staleCiRetirement = liveMainCiSuccess && (isCiBreak || isSystemLearningCiDebt)
      ? {
          reasonCode: isCiBreak
            ? "stale_ci_break:latestMainCiConclusion=success"
            : "stale_system_learning_ci_debt:latestMainCiConclusion=success",
          reason: isCiBreak
            ? "retired because fresh main-branch CI state supersedes the historical CI-break finding"
            : "retired because fresh main-branch CI state supersedes historical system-learning CI debt",
        }
      : null;
    const retirement = staleCiRetirement || structuredRetirement;
    if (!retirement) {
      activeFindings.push(entry);
      continue;
    }
    resolvedLineage.push({
      ...entry,
      _resolvedAt: resolvedAt,
      _resolutionReason: retirement.reasonCode,
      _resolutionNote: retirement.reason,
    });
  }

  return { activeFindings, resolvedLineage };
}

// ── Main Janus Cycle ─────────────────────────────────────────────────────────

/**
 * Build the capacity delta report for the Janus directive (Packet 13).
 * Identifies top bottlenecks, projected gains, and commanded interventions.
 *
 * @param {object} d — parsed AI decision
 * @param {object[]} healthFindings — from health audit
 * @param {object} kpis — parser confidence, plan count, etc.
 * @returns {{ topBottlenecks: Array, projectedGains: Array, commandedInterventions: Array }}
 */
function buildCapacityDeltaReport(d, healthFindings, kpis) {
  const topBottlenecks = [];
  const projectedGains = [];
  const commandedInterventions = [];

  // Extract bottlenecks from health findings
  const criticalFindings = (healthFindings || []).filter(f => f.severity === "critical");
  const warningFindings = (healthFindings || []).filter(f => f.severity === "warning");

  for (const f of criticalFindings.slice(0, 3)) {
    topBottlenecks.push({
      area: f.area,
      severity: f.severity,
      description: f.finding,
    });
    commandedInterventions.push({
      action: f.remediation,
      priority: "immediate",
      capability: f.capabilityNeeded,
    });
  }

  for (const f of warningFindings.slice(0, 2)) {
    topBottlenecks.push({
      area: f.area,
      severity: f.severity,
      description: f.finding,
    });
  }

  // Add capacity KPI-based insights
  if (kpis.parserConfidence !== "n/a" && Number(kpis.parserConfidence) < 0.5) {
    topBottlenecks.push({
      area: "parser-reliability",
      severity: "warning",
      description: `Parser confidence is ${kpis.parserConfidence} — plan quality may be degraded`,
    });
    projectedGains.push({
      improvement: "parser-reliability",
      estimatedGain: "20-40% reduction in plan retry churn",
    });
  }

  if (kpis.planCount === 0) {
    topBottlenecks.push({
      area: "planning-void",
      severity: "critical",
      description: "Prometheus produced zero plans — system cannot evolve",
    });
  }

  // Extract priorities from Janus decision if available
  const priorities = Array.isArray(d?.priorities) ? d.priorities : [];
  for (const p of priorities.slice(0, 3)) {
    const text = typeof p === "string" ? p : p?.description || "";
    if (text) {
      projectedGains.push({
        improvement: text.slice(0, 100),
        estimatedGain: "capacity increase per Janus priority",
      });
    }
  }

  return { topBottlenecks, projectedGains, commandedInterventions };
}


// ── Canonical session loader ────────────────────────────────────────────────

/**
 * Load worker sessions preferring the canonical worker_cycle_artifacts.json
 * (keyed to the active pipeline cycle) and only falling back to the legacy
 * worker_sessions.json when the canonical file is missing or unparseable.
 *
 * Returns structured evidence so callers can persist dual-source metadata and
 * detect source conflicts downstream.
 */
export async function loadWorkerSessionsForHealthAudit(
  config: unknown,
  stateDir: string,
): Promise<{
  sessions: Record<string, unknown>;
  source: "canonical" | "legacy" | "empty";
  cycleId: string | null;
  canonicalSessionsAvailable: boolean;
  legacySessionsAvailable: boolean;
  workerSessionSourceConflict: boolean;
  conflictReason: string | null;
  /** Number of legacy sessions excluded because they predate the current cycle. */
  staleSessionsFiltered: number;
  /** Roles that were excluded due to staleness. */
  filteredStaleRoles: string[];
}> {
  // Read canonical worker_cycle_artifacts and legacy sessions in parallel.
  const artifactsPath = path.join(stateDir, WORKER_CYCLE_ARTIFACTS_FILE);
  const legacyPath = path.join(stateDir, "worker_sessions.json");
  const [artifactsRaw, legacyRaw] = await Promise.all([
    readJsonSafe(artifactsPath),
    readJsonSafe(legacyPath),
  ]);

  const legacySessions = (legacyRaw.ok && legacyRaw.data && typeof legacyRaw.data === "object" && !Array.isArray(legacyRaw.data))
    ? (legacyRaw.data as Record<string, unknown>)
    : null;
  const legacyAvailable = legacySessions !== null && Object.keys(legacySessions).length > 0;

  // Attempt canonical resolution.
  if (artifactsRaw.ok && artifactsRaw.data && typeof artifactsRaw.data === "object") {
    try {
      const migrated = migrateWorkerCycleArtifacts(artifactsRaw.data);
      if (migrated.ok && migrated.data) {
        // Determine preferred cycle from active pipeline.
        let preferredCycleId: string | null = null;
        try {
          const progress = await readPipelineProgress(config as Parameters<typeof readPipelineProgress>[0]);
          preferredCycleId = progress?.startedAt ?? null;
        } catch {
          // pipeline progress unreadable — fall through with null preferred cycle
        }
        const { cycleId, record } = selectWorkerCycleRecord(migrated.data, preferredCycleId ?? undefined);
        const canonicalSessions = extractSessionsFromCycleRecord(record);

        if (canonicalSessions && Object.keys(canonicalSessions).length > 0) {
          // Conflict detection: canonical and legacy disagree on active worker count.
          const canonicalActive = Object.values(canonicalSessions).filter(
            (s) => s && typeof s === "object" && (s as Record<string, unknown>).status === "working",
          ).length;
          const legacyActive = legacySessions
            ? Object.values(legacySessions).filter(
                (s) => s && typeof s === "object" && (s as Record<string, unknown>).status === "working",
              ).length
            : 0;
          const conflict = legacyAvailable && canonicalActive !== legacyActive;
          const conflictReason = conflict
            ? `canonical_active=${canonicalActive} vs legacy_active=${legacyActive}`
            : null;

          return {
            sessions: canonicalSessions,
            source: "canonical",
            cycleId,
            canonicalSessionsAvailable: true,
            legacySessionsAvailable: legacyAvailable,
            workerSessionSourceConflict: conflict,
            conflictReason,
            staleSessionsFiltered: 0,
            filteredStaleRoles: [],
          };
        }
      }
    } catch {
      // Canonical read failed after a successful JSON parse.
    }
  }

  // Fallback: legacy worker_sessions.json is allowed only when the canonical
  // artifact is absent, not when it exists but is invalid/unusable.
  if (artifactsRaw.reason === READ_JSON_REASON.MISSING && legacySessions && Object.keys(legacySessions).length > 0) {
    // Filter sessions that predate the current pipeline cycle so stale legacy
    // "working" sessions cannot generate actionable worker-health findings.
    let pipelineStartedAt: string | null = null;
    try {
      const progress = await readPipelineProgress(config as Parameters<typeof readPipelineProgress>[0]);
      pipelineStartedAt = progress?.startedAt ?? null;
    } catch {
      // pipeline progress unreadable — staleness filter cannot run; pass sessions through
    }
    const { sessions: filteredSessions, staleRoles } = filterStaleWorkerSessions(
      legacySessions,
      pipelineStartedAt,
    );
    return {
      sessions: filteredSessions,
      source: "legacy",
      cycleId: null,
      canonicalSessionsAvailable: false,
      legacySessionsAvailable: true,
      workerSessionSourceConflict: false,
      conflictReason: null,
      staleSessionsFiltered: staleRoles.length,
      filteredStaleRoles: staleRoles,
    };
  }

  return {
    sessions: {},
    source: "empty",
    cycleId: null,
    canonicalSessionsAvailable: false,
    legacySessionsAvailable: legacyAvailable,
    workerSessionSourceConflict: false,
    conflictReason: null,
    staleSessionsFiltered: 0,
    filteredStaleRoles: [],
  };
}

export async function runJanusCycle(config) {
  const stateDir = config.paths?.stateDir || "state";
  const registry = getRoleRegistry(config);
  const janusName = registry?.ceoSupervisor?.name || "Janus";
  const janusModel = registry?.ceoSupervisor?.model || "Claude Sonnet 4.6";
  const command = config.env?.copilotCliCommand || "copilot";

  await appendProgress(config, `[JANUS] ${janusName} awakening — analyzing system state`);
  chatLog(stateDir, janusName, "Awakening — reading system state...");
  chatLog(stateDir, janusName, "[LIVE] loading state snapshots (directive, coordination, prometheus, github, sessions)");

  // Read all state (no budget)
  const [
    lastDirectiveRaw,
    AthenaCoordination,
    prometheusAnalysis,
    githubState,
    sessionLoadResult
  ] = await Promise.all([
    readJson(path.join(stateDir, "janus_directive.json"), {}),
    readJson(path.join(stateDir, "athena_coordination.json"), {}),
    readJson(path.join(stateDir, "prometheus_analysis.json"), {}),
    fetchGitHubState(config),
    loadWorkerSessionsForHealthAudit(config, stateDir)
  ]);
  const lastDirective = isDirectiveAlignedToTargetSession(config, lastDirectiveRaw)
    ? lastDirectiveRaw
    : {};

  const sessions = sessionLoadResult.sessions;
  const leadershipIsolationActive = isSingleTargetLeadershipIsolationActive(config);

  chatLog(
    stateDir,
    janusName,
    `[LIVE] state loaded issues=${githubState.issues.length} prs=${githubState.pullRequests.length} failedCI=${githubState.failedCiRuns.length} activeSessions=${Object.keys(sessions).filter(k => (sessions[k] as Record<string, unknown>)?.status === "working").length}`
  );

  // ── Hierarchical Health Audit — detect what lower layers missed ──────────
  chatLog(stateDir, janusName, "[LIVE] running hierarchical health audit");
  const sessionMeta = { source: sessionLoadResult.source, cycleId: sessionLoadResult.cycleId };
  const healthFindings = await runSystemHealthAudit(config, githubState, AthenaCoordination, sessions, sessionMeta);
  chatLog(stateDir, janusName, `[LIVE] health audit complete findings=${healthFindings.length}`);
  let promptHealthFindings: typeof healthFindings;

  // Always persist the findings file so Prometheus can perform freshness-aware
  // normalization.  Include latestMainCiConclusion and latestMainCiUpdatedAt so
  // the normalization layer can detect when a previously-stale CI-break finding
  // has been superseded by a healthy CI run.
  {
    const { activeFindings, resolvedLineage } = reconcileLeadershipHealthFindings(healthFindings, {
      latestMainCiConclusion: githubState.latestMainCi?.conclusion,
    });
    promptHealthFindings = leadershipIsolationActive ? [] : activeFindings;

    const healthFindingsPayload: Record<string, unknown> = {
      findings: activeFindings,
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: githubState.latestMainCi?.conclusion ?? null,
      latestMainCiUpdatedAt: githubState.latestMainCi?.updatedAt ?? null,
      // Historical CI-break context preserved for audit trail; not treated as active debt.
      ...(resolvedLineage.length > 0 ? { resolvedLineage } : {}),
      // Dual-source liveness evidence: downstream planners use these
      // fields to trust worker-health findings only when source-consistent and fresh.
      workerLivenessSource: sessionLoadResult.source,
      canonicalCycleId: sessionLoadResult.cycleId,
      canonicalSessionsAvailable: sessionLoadResult.canonicalSessionsAvailable,
      legacySessionsAvailable: sessionLoadResult.legacySessionsAvailable,
      workerSessionSourceConflict: sessionLoadResult.workerSessionSourceConflict,
      workerSessionSourceConflictReason: sessionLoadResult.conflictReason ?? null,
      // Staleness provenance: how many legacy sessions were suppressed before the audit.
      staleSessionsFiltered: sessionLoadResult.staleSessionsFiltered,
      filteredStaleRoles: sessionLoadResult.filteredStaleRoles,
    };

    if (activeFindings.length > 0 || resolvedLineage.length > 0) {
      const criticalCount = activeFindings.filter(f => f.severity === "critical").length;
      const resolvedCount = resolvedLineage.length;
      await appendProgress(config,
        `[JANUS][AUDIT] ${activeFindings.length} active finding(s) — ${criticalCount} critical` +
        (resolvedCount > 0 ? ` (${resolvedCount} moved to resolvedLineage — historical CI-break context)` : "")
      );
      chatLog(stateDir, janusName,
        `Health audit: ${activeFindings.length} active findings (${criticalCount} critical)` +
        (resolvedCount > 0 ? `, ${resolvedCount} resolved lineage` : "")
      );

      // Persist capability execution status alongside findings so self-improvement
      // can distinguish "code present in source" from "actually invoked at runtime".
      const capabilityExecutionSummary = await loadCapabilityExecutionSummary(config);
      const capabilityInvocationStatus = Object.keys(CAPABILITY_SOURCE_SIGNATURES).map(id => ({
        capability: id,
        status: getCapabilityExecutionEvidenceTimestamp(capabilityExecutionSummary, id) ? "invoked" : "absent",
        lastInvokedAt: getCapabilityExecutionEvidenceTimestamp(capabilityExecutionSummary, id),
      }));
      healthFindingsPayload.capabilityExecutionSummary = capabilityExecutionSummary;
      healthFindingsPayload.capabilityExecutionTraces = capabilityExecutionSummary.recentTraces;
      healthFindingsPayload.capabilityInvocationStatus = capabilityInvocationStatus;
    }

    await writeJson(path.join(stateDir, "health_audit_findings.json"), healthFindingsPayload);
  }

  // ── Strategic Calibration — compare previous directive expectations vs reality ──
  // This runs every cycle (before AI call) to build a feedback loop on decision quality.
  const activeSessions = Object.keys(sessions).filter(k => (sessions[k] as Record<string, unknown>)?.status === "working").length;
  const lastCycleAt = lastDirective?.decidedAt ? new Date(lastDirective.decidedAt).toLocaleString() : "never";
  const prometheusLastRunAt = prometheusAnalysis?.analyzedAt ? new Date(prometheusAnalysis.analyzedAt).toLocaleString() : "never";

  // Cost guard: skip the AI call if GitHub state hasn't changed and last directive is fresh
  const now = Date.now();
  const lastDecisionMs = lastDirective?.decidedAt ? new Date(lastDirective.decidedAt).getTime() : 0;
  const minutesSinceLast = (now - lastDecisionMs) / 60000;
  const ghFingerprint = [
    githubState.issues.map(i => i.number).join(","),
    githubState.pullRequests.map(p => p.number).join(","),
    githubState.failedCiRuns.length,
    githubState.latestMainCi?.conclusion || ""
  ].join("|");

  // Reuse directive if: (a) state unchanged + workers busy, OR (b) directive is very fresh with pending work
  const hasPendingWork = Array.isArray(lastDirective?.workItems) && lastDirective.workItems.length > 0;
  const isFreshDirective = minutesSinceLast < 2 && hasPendingWork && lastDirective?.wakeAthena;
  const directiveFreshnessMins = Number(config.runtime?.janusDirectiveFreshnessMinutes) || 30;
  if (
    (minutesSinceLast < directiveFreshnessMins && lastDirective?.decision && lastDirective?.githubStateHash === ghFingerprint && activeSessions > 0) ||
    isFreshDirective
  ) {
    await appendProgress(config, `[JANUS] State unchanged (${minutesSinceLast.toFixed(1)}m ago) — reusing last directive (AI call skipped)`);
    chatLog(stateDir, janusName, `State unchanged — reusing last directive (saved AI call)`);
    return lastDirective;
  }

  // Calibrate previous directive's expected outcome against realized current state.
  // We do this AFTER the fresh-directive check so we only calibrate on real new cycles.
  chatLog(stateDir, janusName, "[LIVE] calibration start (expected vs realized)");
  try {
    const calibrationHealthFindings = await runSystemHealthAudit(config, githubState, AthenaCoordination, sessions, sessionMeta);
    const criticalCount = calibrationHealthFindings.filter(f => f.severity === "critical").length;
    const warningCount = calibrationHealthFindings.filter(f => f.severity === "warning").length;
    let realizedHealth = "good";
    if (criticalCount > 0) realizedHealth = "critical";
    else if (warningCount > 0) realizedHealth = "degraded";

    const prevPrometheusAt = lastDirective?.decidedAt
      ? new Date(lastDirective.decidedAt).getTime() : 0;
    const prometheusRanAfter = prometheusAnalysis?.analyzedAt
      ? new Date(prometheusAnalysis.analyzedAt).getTime() > prevPrometheusAt
      : false;
    const athenaCoordinationAt = AthenaCoordination?.updatedAt || AthenaCoordination?.coordinatedAt;
    const athenaActivatedAfter = athenaCoordinationAt
      ? new Date(athenaCoordinationAt).getTime() > prevPrometheusAt
      : false;

    const calibRec = computeCalibrationRecord(lastDirective, {
      systemHealth: realizedHealth,
      decision: "tactical", // placeholder; actual decision determined after AI call this cycle
      athenaActivated: athenaActivatedAfter,
      prometheusRan: prometheusRanAfter,
      workItemCount: Array.isArray(AthenaCoordination?.completedTasks)
        ? AthenaCoordination.completedTasks.length : 0,
    });

    if (calibRec) {
      await appendCalibrationHistory(stateDir, calibRec);
      await appendProgress(config,
        `[JANUS][CALIBRATION] score=${calibRec.scores.overall}/100 healthMatch=${calibRec.scores.healthMatch} decisionMatch=${calibRec.scores.decisionMatch}`
      );
    }
  } catch { /* calibration is non-critical — never block the main cycle */ }
  chatLog(stateDir, janusName, "[LIVE] calibration complete");

  const prometheusAgeHours = prometheusAnalysis?.analyzedAt
    ? (now - new Date(prometheusAnalysis.analyzedAt).getTime()) / 3600000
    : Infinity;

  const workersList = Object.entries(registry?.workers || {})
    .map(([kind, w]) => `  - ${(w as any).name} (${kind}): ${(w as any).model}`)
    .join("\n");

  // English system state context — persona and output format are in janus.agent.md
  // ── Capacity KPIs for strategic decisions ──────────────────────────────────
  const parserConfidence = prometheusAnalysis?.parserConfidence ?? "n/a";
  const planCount = Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : 0;
  const optimizerStatus = prometheusAnalysis?.interventionOptimizer?.status || "n/a";
  const budgetUsed = prometheusAnalysis?.interventionOptimizer?.totalBudgetUsed ?? "n/a";
  const budgetLimit = prometheusAnalysis?.interventionOptimizer?.totalBudgetLimit ?? "n/a";

  // ── Capacity trends from scoreboard ────────────────────────────────────────
  let capacityTrendBlock = "";
  try {
    const recentEntries = await getRecentCapacity(config, 10);
    if (recentEntries.length >= 3) {
      const confTrend = computeTrend(recentEntries, "parserConfidence");
      const planTrend = computeTrend(recentEntries, "planCount");
      const budgetTrend = computeTrend(recentEntries, "budgetUsed");
      const workerTrend = computeTrend(recentEntries, "workersDone");
      capacityTrendBlock = `\n**Capacity Trends (last ${recentEntries.length} cycles):**
  Parser confidence trend: ${confTrend}
  Plan count trend: ${planTrend}
  Budget usage trend: ${budgetTrend}
  Worker completion trend: ${workerTrend}`;
    }
  } catch { /* non-critical */ }

  let realizedExecutionBlock = "";
  try {
    const [cycleAnalyticsState, governanceBlockSummary, agentControlSummary] = await Promise.all([
      readCycleAnalytics(config),
      loadGovernanceBlockSummary(config, 20),
      summarizeAgentControlPlane(config, 20),
    ]);
    const lastCycle = cycleAnalyticsState?.lastCycle;
    const workerTopology = lastCycle?.workerTopology;
    const routingSummary = lastCycle?.routingROISummary;
    const modelRoutingTelemetry = lastCycle?.modelRoutingTelemetry?.byTaskKind || {};
    const topTaskKindEntry = Object.entries(modelRoutingTelemetry)
      .sort((a: any, b: any) => Number((b?.[1] as any)?.default?.outcomeScore || 0) - Number((a?.[1] as any)?.default?.outcomeScore || 0))[0];
    realizedExecutionBlock = `\n**Realized Execution Signals (last recorded cycle):**
  Outcome status: ${String(lastCycle?.outcomes?.status || "unknown")}
  Dispatch block: ${String(lastCycle?.outcomes?.dispatchBlockReason || governanceBlockSummary.latestBlockReason || "none")}
  Worker topology: effectiveLanes=${Number(workerTopology?.effectiveLaneCount || 0)} nominalLanes=${Number(workerTopology?.nominalLaneCount || 0)} reservedSpecialistLanes=${Number(workerTopology?.reservedSpecialistLaneCount || 0)} collapseRate=${Number(workerTopology?.fallbackCollapseRate || 0)}
  Collapsed specialist lanes: ${Array.isArray(workerTopology?.collapsedReservedLanes) && workerTopology.collapsedReservedLanes.length > 0 ? workerTopology.collapsedReservedLanes.join(", ") : "none"}
  Linked routing ROI: ${routingSummary?.overallLinkedROI ?? "n/a"} across ${routingSummary?.linkedRequests ?? 0} linked requests
  Strongest realized taskKind: ${topTaskKindEntry ? `${topTaskKindEntry[0]} score=${Number((topTaskKindEntry[1] as any)?.default?.outcomeScore || 0).toFixed(3)}` : "n/a"}
  Recent governance blocks: ${governanceBlockSummary.recentBlockCount} (${Object.entries(governanceBlockSummary.byReasonCode).map(([code, count]) => `${code}=${count}`).join(", ") || "none"})
  Agent control plane: active=${agentControlSummary.activeAgents.join(", ") || "none"} completed=${agentControlSummary.completionCount} failed=${agentControlSummary.failureCount} handoffs=${agentControlSummary.handoffCount}`;
  } catch { /* advisory only */ }

  let truthMaintenanceSection = "";
  if (!leadershipIsolationActive) {
  try {
    const [knowledgeMemory, researchSynthesis, benchmarkData] = await Promise.all([
      readJson(path.join(stateDir, "knowledge_memory.json"), null),
      readJson(path.join(stateDir, "research_synthesis.json"), null),
      readJson(path.join(stateDir, "benchmark_ground_truth.json"), null),
    ]);
    const truthSignals = await collectPromptTruthSignals(process.cwd(), {
      latestMainCiConclusion: githubState.latestMainCi?.conclusion,
    });
    if (truthSignals.errors.length > 0) {
      await appendProgress(
        config,
        `[JANUS][WARN] Truth-maintenance signal collection degraded: ${truthSignals.errors.join("; ")}`,
      );
    }
    const plannerPriorityActions = Array.isArray((researchSynthesis as any)?.plannerSignals?.priorityActions)
      ? (researchSynthesis as any).plannerSignals.priorityActions
      : [];
    const truthSnapshot = buildPromptTruthMaintenanceSnapshot({
      signals: truthSignals.signals,
      lessons: extractKnowledgeMemoryLessons(knowledgeMemory),
      researchRecommendations: [
        ...extractLatestBenchmarkRecommendations(benchmarkData),
        ...plannerPriorityActions,
      ],
      leadershipPriorities: Array.isArray(lastDirective?.priorities) ? lastDirective.priorities : [],
    });
    truthMaintenanceSection = buildPromptTruthMaintenanceSection({
      activeLessons: truthSnapshot.lessons.activeText,
      activeRecommendations: truthSnapshot.recommendations.activeText,
      activePriorities: truthSnapshot.priorities.activeText,
      retiredLessons: truthSnapshot.lessons.retired.map(({ label, reason }) => ({ label, reason })),
      retiredRecommendations: truthSnapshot.recommendations.retired.map(({ label, reason }) => ({ label, reason })),
      retiredPriorities: truthSnapshot.priorities.retired.map(({ label, reason }) => ({ label, reason })),
    }, { maxActivePerKind: 4, maxRetiredPerKind: 4 });
  } catch (truthErr) {
    await appendProgress(
      config,
      `[JANUS][WARN] Failed to assemble truth-maintenance prompt context: ${String((truthErr as Error)?.message || truthErr)}`,
    );
  }
  }

  const janusLayerPrompt = buildPromptAssemblyPrompt({ agentName: "janus", config });
  const effectivePromptTargetRepo = resolvePromptTargetRepo(config);
  const activeTargetSession = config?.activeTargetSession && typeof config.activeTargetSession === "object"
    ? config.activeTargetSession
    : null;

  const runtimeStateSection = leadershipIsolationActive
    ? `## CURRENT TARGET DELIVERY STATE

**Target Session:** ${String(activeTargetSession?.projectId || "unknown")} / ${String(activeTargetSession?.sessionId || "unknown")}
**Target Stage:** ${String(activeTargetSession?.currentStage || "unknown")}
**Objective:** ${String(activeTargetSession?.objective?.summary || "unknown")}
**Planning Gates:** planning=${Boolean(activeTargetSession?.gates?.allowPlanning)} shadow=${Boolean(activeTargetSession?.gates?.allowShadowExecution)} active=${Boolean(activeTargetSession?.gates?.allowActiveExecution)} quarantine=${Boolean(activeTargetSession?.gates?.quarantine)}
**Repo State:** ${String(activeTargetSession?.repoProfile?.repoState || activeTargetSession?.intent?.repoState || "unknown")}
**Clarification Status:** ${String(activeTargetSession?.clarification?.status || "unknown")}
**Intent Status:** ${String(activeTargetSession?.intent?.status || "unknown")}
**Intent Summary:** ${String(activeTargetSession?.intent?.summary || "unknown")}
**Required Human Inputs:** ${Array.isArray(activeTargetSession?.handoff?.requiredHumanInputs) && activeTargetSession.handoff.requiredHumanInputs.length > 0 ? activeTargetSession.handoff.requiredHumanInputs.join("; ") : "none"}
**Protected Paths:** ${Array.isArray(activeTargetSession?.constraints?.protectedPaths) && activeTargetSession.constraints.protectedPaths.length > 0 ? activeTargetSession.constraints.protectedPaths.join(", ") : "none"}
**Forbidden Actions:** ${Array.isArray(activeTargetSession?.constraints?.forbiddenActions) && activeTargetSession.constraints.forbiddenActions.length > 0 ? activeTargetSession.constraints.forbiddenActions.join(", ") : "none"}

**GitHub State — ${effectivePromptTargetRepo}:**
Open Issues (${githubState.issues.length}):
${githubState.issues.length > 0
  ? githubState.issues.map(i => `  #${i.number}: ${i.title} [${i.labels.join(", ") || "no labels"}]`).join("\n")
  : "  No open issues"}

Open PRs (${githubState.pullRequests.length}):
${githubState.pullRequests.length > 0
  ? githubState.pullRequests.map(p => `  #${p.number}: ${p.title} [${p.draft ? "draft" : "open"}]`).join("\n")
  : "  No open PRs"}

**Latest CI on default branch (${githubState.latestMainCi?.branch || "main"}):**
${githubState.latestMainCi
  ? `  ${githubState.latestMainCi.conclusion} (${githubState.latestMainCi.commit}) [${githubState.latestMainCi.updatedAt}]`
  : "  No CI runs found"}

**Recent CI Failures (last 24h): ${githubState.failedCiRuns.length}**
${githubState.failedCiRuns.length > 0
  ? githubState.failedCiRuns.map(r => `  ${r.name} on ${r.branch} (${r.commit}) — ${r.conclusion} [${r.updatedAt}]`).join("\n")
  : "  No recent failures"}

**Leadership Rule For Single-Target Mode:**
  - Treat the active target session as the only planning authority.
  - Do not inject BOX self-dev health audit, postmortem debt, trusted memory, or architecture drift pressure into the directive.
  - If target clarification is incomplete or planning gates are closed, direct Prometheus to resolve target-session blockers only.`
    : `## CURRENT SYSTEM STATE

**Active Worker Sessions:** ${activeSessions}
**Last Cycle:** ${lastCycleAt}
**Prometheus Last Analysis:** ${prometheusLastRunAt}${prometheusAgeHours < 6 ? ` (${prometheusAgeHours.toFixed(1)}h ago — FRESH, only set callPrometheus=true if health is critical)` : ""}

**GitHub State — ${effectivePromptTargetRepo}:**
Open Issues (${githubState.issues.length}):
${githubState.issues.length > 0
  ? githubState.issues.map(i => `  #${i.number}: ${i.title} [${i.labels.join(", ") || "no labels"}]`).join("\n")
  : "  No open issues"}

Open PRs (${githubState.pullRequests.length}):
${githubState.pullRequests.length > 0
  ? githubState.pullRequests.map(p => `  #${p.number}: ${p.title} [${p.draft ? "draft" : "open"}]`).join("\n")
  : "  No open PRs"}

**Latest CI on default branch (${githubState.latestMainCi?.branch || "main"}):**
${githubState.latestMainCi
  ? `  ${githubState.latestMainCi.conclusion} (${githubState.latestMainCi.commit}) [${githubState.latestMainCi.updatedAt}]`
  : "  No CI runs found"}

**Recent CI Failures (last 24h): ${githubState.failedCiRuns.length}**
${githubState.failedCiRuns.length > 0
  ? githubState.failedCiRuns.map(r => `  ${r.name} on ${r.branch} (${r.commit}) — ${r.conclusion} [${r.updatedAt}]`).join("\n")
  : "  No recent failures"}

**Recently Merged PRs (${githubState.recentlyMergedPrs.length}):**
${githubState.recentlyMergedPrs.length > 0
  ? githubState.recentlyMergedPrs.map(p => `  #${p.number}: ${p.title} [merged ${p.mergedAt}]`).join("\n")
  : "  No recently merged PRs"}

**Last Coordination:**
${AthenaCoordination?.summary ? `  ${AthenaCoordination.summary}` : "  No previous coordination"}
${AthenaCoordination?.completedTasks ? `  Completed tasks: ${AthenaCoordination.completedTasks}` : ""}

**Prometheus's Last Analysis:**
${prometheusAnalysis?.projectHealth ? `  Health: ${prometheusAnalysis.projectHealth}` : "  No analysis available"}
${prometheusAnalysis?.keyFindings ? `  Key findings: ${prometheusAnalysis.keyFindings}` : ""}
${prometheusAnalysis?.projectClassification ? `  Project type: ${prometheusAnalysis.projectClassification.type} (${prometheusAnalysis.projectClassification.confidence})` : ""}

**Capacity KPIs (use for strategic decisions):**
  Parser confidence: ${parserConfidence}
  Plans produced: ${planCount}
  Optimizer: status=${optimizerStatus} budget=${budgetUsed}/${budgetLimit}
  Prometheus age: ${prometheusAgeHours < Infinity ? `${prometheusAgeHours.toFixed(1)}h` : "never"}
${capacityTrendBlock}
${realizedExecutionBlock}

**Hierarchical System Health Audit (detected by YOU — issues workers/Athena may have missed):**
${formatHealthAuditFindings(promptHealthFindings)}
${promptHealthFindings.filter(f => f.severity === "critical").length > 0 ? "\n⚠️ CRITICAL FINDINGS ABOVE — these MUST be addressed. Workers and Athena missed them." : ""}
${promptHealthFindings.filter(f => f.area === "capability-gap").length > 0 ? "\n⚠️ CAPABILITY GAPS DETECTED — the system is missing abilities that caused failures. Consider requesting Prometheus to plan fixes." : ""}
${truthMaintenanceSection ? `\n\n${truthMaintenanceSection}` : ""}`;

  const contextPrompt = `TARGET REPO: ${effectivePromptTargetRepo}

${janusLayerPrompt}

${runtimeStateSection}

**Leadership Fast Path Rules:**
  - Use the supplied state artifacts, health findings, GitHub state, and prior analysis as the source of truth.
  - Do not run repository-wide validation commands such as npm test, npm run lint, or npm run typecheck during Janus analysis.
  - If CI/test health is unclear, say so explicitly and delegate verification work to Prometheus/workers instead of re-running the full suite here.

**Available Workers:**
${workersList}`;

  appendPromptPreviewSync(stateDir, contextPrompt);
  chatLog(stateDir, janusName, `Calling Copilot CLI (agent=janus, allowAll=true)...`);

  const janusTimeoutMs = Math.max(60_000, Number(config?.runtime?.janusTimeoutMs || 1_800_000));
  const janusDecisionLatencyWarningMs = Math.max(
    30_000,
    Number(config?.runtime?.janusDecisionLatencyWarningMs ?? config?.slo?.thresholds?.decisionLatencyMs ?? 900_000),
  );
  // Latency-aware tiered routing: T1 (fast) → T2 (normal) → T3 (full+fallback).
  // maxRetries=1 means 2 attempts, maxRetries=2 means all 3 tiers.
  const tier1Ms = Math.max(30_000, Math.min(Number(config?.runtime?.janusLatencyTier1Ms ?? 60_000), janusTimeoutMs));
  const tier2Ms = Math.max(tier1Ms + 1, Math.min(Number(config?.runtime?.janusLatencyTier2Ms ?? 600_000), janusTimeoutMs));
  const disableTier1 = config?.runtime?.janusDisableTier1 === true;
  const janusSoftTimeoutMs = Math.max(
    disableTier1 ? tier2Ms : tier1Ms,
    Math.min(Number(config?.runtime?.janusSoftTimeoutMs ?? tier2Ms), janusTimeoutMs),
  );
  const maxRetries = Math.max(0, Math.min(Number(config?.runtime?.janusMaxRetries ?? 1), 2));
  const fallbackModel = resolveJanusFallbackModel(config);

  // Build tier list: each tier has its own timeout and model.
  // T3 uses the fallback model (may be the same as janusModel when no override is set).
  const allTiers = [
    { timeoutMs: tier1Ms, model: janusModel, label: "T1" },
    { timeoutMs: tier2Ms, model: janusModel, label: "T2" },
    { timeoutMs: janusTimeoutMs, model: fallbackModel, label: "T3" },
  ];
  const candidateTiers = disableTier1 ? allTiers.filter((tier) => tier.label !== "T1") : allTiers;
  const tiers = candidateTiers.slice(0, Math.min(maxRetries + 1, candidateTiers.length))
    .map((tier) => ({
      ...tier,
      // Every fallback-model tier is soft-timeout gated so activation semantics
      // stay deterministic: no fallback call before the cutoff is reached.
      softTimeoutGated: tier.model !== janusModel,
    }));
  if (!tiers.some((tier) => tier.model !== janusModel) && fallbackModel !== janusModel) {
    // Keep the existing T1/T2 retry profile, but guarantee a deterministic
    // fallback path once the soft-timeout threshold has been crossed.
    tiers.push({ timeoutMs: janusTimeoutMs, model: fallbackModel, label: "T3", softTimeoutGated: true });
  }

  let rawResult: any;
  let finalTierLabel = tiers[0]?.label || (disableTier1 ? "T2" : "T1");
  let finalTierModel = tiers[0]?.model || janusModel;
  const aiCallStartedAt = Date.now();
  const latencyWarningCorrelationId = `janus-latency-${aiCallStartedAt}`;
  const heartbeatIntervalMs = Math.max(30_000, Number(config?.runtime?.janusHeartbeatIntervalMs || 30_000));
  const heartbeatTimer = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - aiCallStartedAt) / 1000);
    chatLog(stateDir, janusName, `[LIVE] AI analysis in progress elapsed=${elapsedSec}s`);
  }, heartbeatIntervalMs);

  chatLog(stateDir, janusName, "Calling AI for strategic analysis...");
  appendLiveLogSync(stateDir, `\n[copilot_stream_start] ${new Date().toISOString().replace("T", " ").slice(0, 19)}\n`);

  try {
    for (let ti = 0; ti < tiers.length; ti++) {
      const tier = tiers[ti];
      const isEscalation = ti > 0;

      if (tier.softTimeoutGated) {
        const elapsedMsBeforeFallback = Date.now() - aiCallStartedAt;
        if (!hasReachedJanusSoftTimeout(elapsedMsBeforeFallback, janusSoftTimeoutMs)) {
          // Soft-timeout threshold not yet crossed — skip this fallback tier (cutoff).
          // Emit a deterministic analytics event so the cutoff decision is observable.
          emitEvent(EVENTS.POLICY_JANUS_SOFT_TIMEOUT_CUTOFF, EVENT_DOMAIN.POLICY, latencyWarningCorrelationId, {
            source: "janus_supervisor",
            tier: tier.label,
            softTimeoutMs: janusSoftTimeoutMs,
            elapsedMsAtCutoff: elapsedMsBeforeFallback,
            softTimeoutReached: JANUS_SOFT_TIMEOUT_POLICY_CONTRACT.softTimeoutCutoff.softTimeoutReached,
            baseModel: janusModel,
            fallbackModel: tier.model,
            hardTimeoutMs: janusTimeoutMs,
          });
          chatLog(stateDir, janusName,
            `[LIVE] tier=${tier.label} soft-timeout cutoff: elapsed=${elapsedMsBeforeFallback}ms < softTimeoutMs=${janusSoftTimeoutMs}ms — fallback skipped`
          );
          rawResult = { status: -1, stdout: "", stderr: "soft-timeout cutoff not reached", timedOut: false };
          finalTierLabel = tier.label;
          finalTierModel = tier.model;
          break;
        }
      }

      if (isEscalation) {
        const prevTier = tiers[ti - 1];
        const elapsedMsAtEscalation = Date.now() - aiCallStartedAt;
        const softTimeoutReached = tier.model !== janusModel
          ? true
          : hasReachedJanusSoftTimeout(elapsedMsAtEscalation, janusSoftTimeoutMs);
        const routingReason = tier.model !== janusModel ? ROUTING_REASON.JANUS_LATENCY_FALLBACK : "JANUS_LATENCY_ESCALATION";
        await appendProgress(config, formatJanusTierEscalationMessage(prevTier, tier, routingReason));
        chatLog(
          stateDir,
          janusName,
          tier.model !== janusModel
            ? `[LIVE] tier=${prevTier.label} reached tier budget — activating ${tier.label}`
            : `[LIVE] tier=${prevTier.label} timed out — escalating to ${tier.label}`
        );
        emitEvent(EVENTS.ORCHESTRATION_ALERT_EMITTED, EVENT_DOMAIN.ORCHESTRATION, latencyWarningCorrelationId, {
          severity: "warning",
          source: "janus_supervisor",
          warningCode: tier.model !== janusModel
            ? JANUS_WARNING_CODE.LATENCY_FALLBACK_ACTIVATED
            : JANUS_WARNING_CODE.LATENCY_ESCALATION,
          fromTier: prevTier.label,
          toTier: tier.label,
          fromTimeoutMs: prevTier.timeoutMs,
          toTimeoutMs: tier.timeoutMs,
          softTimeoutMs: janusSoftTimeoutMs,
          elapsedMsAtEscalation,
          softTimeoutReached,
          baseModel: janusModel,
          selectedModel: tier.model,
          routingReason,
        });
        if (tier.model !== janusModel) {
          emitEvent(EVENTS.POLICY_JANUS_FALLBACK_ACTIVATED, EVENT_DOMAIN.POLICY, latencyWarningCorrelationId, {
            source: "janus_supervisor",
            baseModel: janusModel,
            fallbackModel: tier.model,
            fromTier: prevTier.label,
            toTier: tier.label,
            softTimeoutMs: janusSoftTimeoutMs,
            elapsedMsAtActivation: elapsedMsAtEscalation,
            softTimeoutReached: JANUS_SOFT_TIMEOUT_POLICY_CONTRACT.fallbackActivated.softTimeoutReached,
            hardTimeoutMs: janusTimeoutMs,
            routingReason,
          });
          warn(
            `[janus_supervisor] fallback model activated after latency escalation: baseModel=${janusModel} fallbackModel=${tier.model} tier=${tier.label} softTimeoutReached=${softTimeoutReached}`
          );
        }
      }

      chatLog(stateDir, janusName, `[LIVE] invoking agent=janus tier=${tier.label} model=${tier.model} timeout=${Math.floor(tier.timeoutMs / 1000)}s`);
      const args = buildAgentArgs({ agentSlug: "janus", prompt: contextPrompt, allowAll: true, noAskUser: true, model: tier.model !== janusModel ? tier.model : undefined });

      let tierResult: any;
      try {
        tierResult = await spawnAsync(command, args, {
          env: process.env,
          timeoutMs: tier.timeoutMs,
          // Kill CLI immediately when output is complete — avoids hanging in
          // interactive 'continue?' mode that Copilot CLI enters after long outputs.
          earlyExitMarker: "===END===",
          onStdout(chunk) {
            appendLiveLogSync(stateDir, chunk.toString("utf8"));
          },
          onStderr(chunk) {
            appendLiveLogSync(stateDir, chunk.toString("utf8"));
          },
        });
      } catch (spawnErr) {
        // spawnAsync should not throw — treat as failure and proceed to next tier if available
        tierResult = { status: -1, stdout: "", stderr: String((spawnErr as any)?.message || spawnErr), timedOut: false };
      }

      // If this tier timed out and there is a next tier available, escalate
      if (tierResult?.timedOut && ti < tiers.length - 1) {
        continue;
      }

      rawResult = tierResult;
      finalTierLabel = tier.label;
      finalTierModel = tier.model;
      break;
    }
  } finally {
    clearInterval(heartbeatTimer);
  }

  appendLiveLogSync(stateDir, `\n[copilot_stream_end] ${new Date().toISOString().replace("T", " ").slice(0, 19)} exit=${rawResult?.status}\n`);

  const elapsedSec = Math.floor((Date.now() - aiCallStartedAt) / 1000);
  const elapsedMs = Date.now() - aiCallStartedAt;
  chatLog(stateDir, janusName, `[LIVE] AI call completed elapsed=${elapsedSec}s ok=${Boolean(rawResult?.status === 0)}`);
  if (shouldWarnJanusDecisionLatency(elapsedMs, janusDecisionLatencyWarningMs)) {
    const warningMessage =
      `[JANUS][LATENCY_WARNING] decision latency ${elapsedMs}ms exceeded warning threshold ${janusDecisionLatencyWarningMs}ms (tier=${finalTierLabel} model=${finalTierModel})`;
    await appendProgress(config, warningMessage);
    warn(`[janus_supervisor] ${warningMessage}`);
    try {
      await appendAlert(config, {
        severity: ALERT_SEVERITY.MEDIUM,
        source: "janus_supervisor",
        title: "Janus decision latency warning threshold exceeded",
        message: warningMessage,
        correlationId: latencyWarningCorrelationId,
      });
    } catch { /* non-fatal */ }
    emitEvent(EVENTS.ORCHESTRATION_ALERT_EMITTED, EVENT_DOMAIN.ORCHESTRATION, latencyWarningCorrelationId, {
      severity: "warning",
      source: "janus_supervisor",
      warningCode: JANUS_WARNING_CODE.DECISION_LATENCY_WARNING,
      latencyMs: elapsedMs,
      warningThresholdMs: janusDecisionLatencyWarningMs,
      timeoutMs: janusTimeoutMs,
      tier: finalTierLabel,
      model: finalTierModel,
      usedFallbackModel: finalTierModel !== janusModel,
    });
  }

  const rawOut = String(rawResult?.stdout || rawResult?.stderr || "");
  const finalTierTimeoutMs = Math.max(1, Number(tiers.find((tier) => tier.label === finalTierLabel)?.timeoutMs || janusTimeoutMs));
  const aiResult = rawResult?.status === 0
    ? parseAgentOutput(rawOut)
    : { ok: false, raw: rawOut, parsed: null, thinking: "", error: rawResult?.timedOut ? `timed out after ${Math.floor(finalTierTimeoutMs / 1000)}s` : `exited ${rawResult?.status}` };

  if (!aiResult.ok || !aiResult.parsed) {
    await appendProgress(config, `[JANUS] AI call failed — ${(aiResult as any).error || "no JSON"}`);
    chatLog(stateDir, janusName, `AI failed: ${(aiResult as any).error || "no JSON"}`);
    const needsPrometheus = prometheusAgeHours > 6;
    return {
      wait: false,
      wakeAthena: true,
      callPrometheus: needsPrometheus,
      prometheusReason: needsPrometheus ? "AI call failed and no recent Prometheus analysis — must scan" : undefined,
      decision: "tactical",
      systemHealth: "unknown",
      thinking: "",
      fullOutput: (aiResult as any).raw || "",
      briefForPrometheus: `Check GitHub issues and activate appropriate workers. Target repo: ${effectivePromptTargetRepo}`,
      priorities: [],
      workerSuggestions: []
    };
  }

  logAgentThinking(stateDir, janusName, aiResult.thinking);

  // ── Trust boundary validation ────────────────────────────────────────────
  const tbMode = config?.runtime?.trustBoundaryMode === "warn" ? "warn" : "enforce";
  const trustCheck = validateLeadershipContract(
    LEADERSHIP_CONTRACT_TYPE.SUPERVISOR, aiResult.parsed, { mode: tbMode }
  );
  if (!trustCheck.ok && tbMode === "enforce") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    await appendProgress(config, `[JANUS][TRUST_BOUNDARY] Supervisor output failed contract validation — class=${TRUST_BOUNDARY_ERROR} reasonCode=${trustCheck.reasonCode} errors=${tbErrors}`);
    try {
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "janus_supervisor",
        title: "Supervisor output failed trust-boundary validation",
        message: `class=${TRUST_BOUNDARY_ERROR} reasonCode=${trustCheck.reasonCode} errors=${tbErrors}`
      });
    } catch { /* non-fatal */ }
    // Degrade to safe fallback directive; never silently pass invalid output
    const needsPrometheus = prometheusAgeHours > 6;
    return {
      wait: false,
      wakeAthena: true,
      callPrometheus: needsPrometheus,
      prometheusReason: needsPrometheus ? "Trust-boundary violation in supervisor output and no recent Prometheus analysis" : undefined,
      decision: "tactical",
      systemHealth: "unknown",
      thinking: aiResult.thinking,
      fullOutput: (aiResult as any).raw || "",
      briefForPrometheus: `Check GitHub issues and activate appropriate workers. Target repo: ${effectivePromptTargetRepo}`,
      priorities: [],
      workerSuggestions: [],
      _trustBoundaryViolation: true,
      _trustBoundaryErrors: tbErrors
    };
  }
  if (trustCheck.errors.length > 0 && tbMode === "warn") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    await appendProgress(config, `[JANUS][TRUST_BOUNDARY][WARN] Contract violations (warn mode, not blocking): ${tbErrors}`);
  }

  const d = aiResult.parsed;

  // Safety net: force callPrometheus=true when no valid Prometheus analysis exists.
  // Queue-viability gate: if there are viable pending plans in the queue, suppress the
  // age-based replan so existing approved work is executed before an expensive replan.
  if (!d.callPrometheus && prometheusAgeHours > 6) {
    try {
      const queueViability = await computeQueueViability(config);
      if (queueViability.viable) {
        // Valid pending work exists — skip the age-based replan, let orchestrator execute
        await appendProgress(config,
          `[JANUS] Age-based replan suppressed — queue has ${queueViability.pendingCount}/${queueViability.totalCount} viable pending plan(s) (reason=${queueViability.reason} completionRate=${queueViability.completionRate ?? "n/a"})`
        );
      } else {
        d.callPrometheus = true;
        d.prometheusReason = (d.prometheusReason || "") + " [OVERRIDE: no recent Prometheus analysis and no viable queued plans — forced callPrometheus=true]";
        await appendProgress(config, `[JANUS] callPrometheus overridden to true — Prometheus analysis is ${prometheusAgeHours === Infinity ? "missing" : prometheusAgeHours.toFixed(1) + "h old"}, queueViability=${queueViability.reason}`);
      }
    } catch {
      // Fall back to age-only override on any error
      d.callPrometheus = true;
      d.prometheusReason = (d.prometheusReason || "") + " [OVERRIDE: no recent Prometheus analysis — forced callPrometheus=true]";
      await appendProgress(config, `[JANUS] callPrometheus overridden to true — Prometheus analysis is ${prometheusAgeHours === Infinity ? "missing" : prometheusAgeHours.toFixed(1) + "h old"}`);
    }
  }

  // ── Safety net: force replanning if Athena rejected the previous plan ──────
  // If the last plan was rejected and we're about to skip replanning, that's wrong.
  // Athena rejection = mandatory replan, regardless of Prometheus freshness.
  if (!d.callPrometheus) {
    try {
      const athenaRejection = await readJsonSafe(path.join(stateDir, "athena_plan_rejection.json"));
      const hasRejectedPlan = Boolean(
        athenaRejection?.ok &&
        athenaRejection.data &&
        typeof athenaRejection.data === "object" &&
        athenaRejection.data.rejectedAt
      );
      if (hasRejectedPlan) {
        d.callPrometheus = true;
        d.prometheusReason = (d.prometheusReason || "") + " [OVERRIDE: Athena rejected previous plan — forced callPrometheus=true for replan]";
        await appendProgress(config, `[JANUS] callPrometheus overridden to true — Athena rejection detected, mandatory replan`);
      }
    } catch { /* non-fatal: if athena_plan_rejection doesn't exist or is malformed, continue */ }
  }

  chatLog(stateDir, janusName,
    `Decision: ${d.decision || "?"} | Health: ${d.systemHealth || "?"} | callPrometheus: ${d.callPrometheus} | wakeAthena: ${d.wakeAthena}`
  );
  await appendProgress(config,
    `[JANUS] decision=${d.decision} health=${d.systemHealth} callPrometheus=${d.callPrometheus} wakeAthena=${d.wakeAthena}`
  );

  // ── Capacity Delta Report (Packet 13) ──────────────────────────────────
  // Extract top bottlenecks and projected gains from Janus's analysis.
  const capacityDelta = buildCapacityDeltaReport(d, promptHealthFindings, {
    parserConfidence, planCount, optimizerStatus, budgetUsed, budgetLimit
  });

  const expectedOutcome = buildExpectedOutcome(d);

  // ── Directive payload validation — fail-close on incomplete payloads ────
  // After the AI output passes the trust boundary, validate the assembled
  // directive has all required fields and a measurable expectedOutcome.
  // If validation fails, degrade to a safe fallback rather than writing an
  // incomplete payload to disk.
  const payloadValidation = validateDirectivePayload(
    d as Record<string, unknown>,
    expectedOutcome as unknown as Record<string, unknown>
  );
  if (!payloadValidation.valid) {
    const gapList = payloadValidation.gaps.join(" | ");
    await appendProgress(config,
      `[JANUS][PAYLOAD_GATE] Directive payload incomplete — fail-closing. Gaps: ${gapList}`
    );
    try {
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "janus_supervisor",
        title: "Directive payload failed validation — safe fallback returned",
        message: gapList
      });
    } catch { /* non-fatal */ }
    const needsPrometheus = prometheusAgeHours > 6;
    const fallbackStrategyBrief = buildDirectiveStrategyBrief({
      decision: "tactical",
      systemHealth: "unknown",
      wakeAthena: true,
      callPrometheus: needsPrometheus,
      briefForPrometheus: `Check GitHub issues and activate appropriate workers. Target repo: ${effectivePromptTargetRepo}`,
      priorities: [],
      workerSuggestions: [],
    }, expectedOutcome as unknown as Record<string, unknown>, {
      repo: effectivePromptTargetRepo || null,
    });
    return {
      wait: false,
      wakeAthena: true,
      callPrometheus: needsPrometheus,
      prometheusReason: needsPrometheus
        ? "Directive payload incomplete and no recent Prometheus analysis" : undefined,
      decision: "tactical",
      systemHealth: "unknown",
      thinking: aiResult.thinking,
      fullOutput: (aiResult as any).raw || "",
      briefForPrometheus: `Check GitHub issues and activate appropriate workers. Target repo: ${effectivePromptTargetRepo}`,
      priorities: [],
      workerSuggestions: [],
      _directivePayloadGaps: payloadValidation.gaps,
      strategyBrief: fallbackStrategyBrief,
    };
  }

  const ciFastlaneRequired = hasCiSystemLearningDebt(promptHealthFindings);
  const autonomyDebtFinding = findAutonomyDebtHealthFinding(promptHealthFindings);
  if (autonomyDebtFinding) {
    const autonomyExecutionDebt = {
      active: true,
      reasonCode: String(autonomyDebtFinding.reasonCode || AUTONOMY_EXECUTION_GATE_REASON_CODE),
      blockReason: String(autonomyDebtFinding.blockReason || autonomyDebtFinding.reasonCode || AUTONOMY_EXECUTION_GATE_REASON_CODE),
    };
    d.autonomyExecutionDebt = autonomyExecutionDebt;
    const autonomyPriority = buildAutonomyDebtPriority(
      autonomyExecutionDebt.reasonCode,
      autonomyExecutionDebt.blockReason,
    );
    d.priorities = prependDirectivePriority({ priorities: d.priorities }, autonomyPriority).priorities;
    await appendProgress(
      config,
      `[JANUS] Feature work subordinated — ${autonomyExecutionDebt.reasonCode} active (${autonomyExecutionDebt.blockReason})`,
    );
  }

  const strategyBrief = buildDirectiveStrategyBrief(d as Record<string, unknown>, expectedOutcome as unknown as Record<string, unknown>, {
    repo: config.env?.targetRepo || null,
  });
  const directive = stampDirectiveTargetSession(config, {
    ...d,
    briefForPrometheus: sanitizeDirectiveFieldForPersistence(String((d as any).briefForPrometheus || "")),
    thinking: aiResult.thinking,
    fullOutput: (aiResult as any).raw || "",
    decidedAt: new Date().toISOString(),
    model: janusModel,
    repo: config.env?.targetRepo,
    githubStateHash: ghFingerprint,
    githubCiContext: {
      latestMainCi: githubState.latestMainCi || null,
      failedCiRuns: Array.isArray(githubState.failedCiRuns) ? githubState.failedCiRuns : []
    },
    capacityDelta,
    expectedOutcome,
    strategyBrief,
    ciFastlaneRequired,
  });

  if (ciFastlaneRequired) {
    await appendProgress(config,
      `[JANUS] CI system-learning debt detected — ciFastlaneRequired=true set on directive; Prometheus will generate wave-1 CI-fix fastlane packet`
    );
  }

  await writeJson(path.join(stateDir, "janus_directive.json"), directive);

  return directive;
}

// ── Per-cycle Janus outcome ledger ─────────────────────────────────────────────
//
// Written at the end of every complete orchestration cycle.  The ledger feeds
// into planning context on the next cycle so the supervisor can reason about
// recent strategy-to-outcome closure rates.

/** Schema version for janus_outcome_ledger.jsonl entries. */
export const JANUS_OUTCOME_LEDGER_SCHEMA_VERSION = 1;

/**
 * Per-cycle Janus strategy-to-outcome closure record.
 * Emitted at the end of every completed cycle in the orchestrator.
 */
export interface JanusDecisionOutcome {
  schemaVersion: number;
  /**
   * Stable hash of the Janus directive for this cycle.
   * Matches directive.githubStateHash so records can be correlated with
   * the directive that drove them.
   */
  directiveHash: string;
  recordedAt: string;
  /** Number of plans generated by Prometheus this cycle. */
  plansGenerated: number;
  /** Number of worker batches that completed successfully this cycle. */
  plansExecuted: number;
  /**
   * Budget consumed by the optimizer (totalBudgetUsed), or null when the
   * optimizer did not run or its result is unavailable.
   */
  budgetDelta: number | null;
  /**
   * CI outcome from the latest main-branch run visible to Janus, or null
   * when unknown.  Derived from janusDirective.githubCiContext.latestMainCi.conclusion.
   */
  ciOutcome: string | null;
}

/**
 * Build a JanusDecisionOutcome record from cycle-level inputs.
 *
 * Pure function — no I/O.  Call appendJanusOutcomeLedger() to persist.
 *
 * @param opts.directiveHash  - stable hash from the Janus directive
 * @param opts.plansGenerated - Prometheus plan count
 * @param opts.plansExecuted  - completed worker count
 * @param opts.budgetDelta    - optimizer totalBudgetUsed (optional)
 * @param opts.ciOutcome      - latest CI conclusion string (optional)
 */
export function buildJanusDecisionOutcome(opts: {
  directiveHash: string;
  plansGenerated: number;
  plansExecuted: number;
  budgetDelta?: number | null;
  ciOutcome?: string | null;
}): JanusDecisionOutcome {
  return {
    schemaVersion: JANUS_OUTCOME_LEDGER_SCHEMA_VERSION,
    directiveHash: String(opts.directiveHash || ""),
    recordedAt: new Date().toISOString(),
    plansGenerated: Math.max(0, Math.floor(Number(opts.plansGenerated) || 0)),
    plansExecuted: Math.max(0, Math.floor(Number(opts.plansExecuted) || 0)),
    budgetDelta: typeof opts.budgetDelta === "number" && Number.isFinite(opts.budgetDelta)
      ? opts.budgetDelta
      : null,
    ciOutcome: opts.ciOutcome ? String(opts.ciOutcome) : null,
  };
}

/**
 * Append a JanusDecisionOutcome record to state/janus_outcome_ledger.jsonl.
 *
 * Uses appendFileSync for atomic per-line writes.
 * Never throws — all errors are silently swallowed to prevent blocking orchestration.
 *
 * @param stateDir - path to the state directory
 * @param outcome  - the record to persist
 */
export async function appendJanusOutcomeLedger(
  stateDir: string,
  outcome: JanusDecisionOutcome,
): Promise<void> {
  try {
    const filePath = path.join(stateDir, "janus_outcome_ledger.jsonl");
    const entry = JSON.stringify(outcome) + "\n";
    appendFileSync(filePath, entry, "utf8");
  } catch (err) {
    // Fail-open: ledger write is non-fatal but must be observable.
    warn(`[janus_supervisor] appendJanusOutcomeLedger write failed (degraded): ${String((err as any)?.message || err)}`);
  }
}


