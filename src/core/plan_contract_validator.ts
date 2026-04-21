/**
 * plan_contract_validator.js — Contract-first plan validation (Packet 2)
 *
 * Every plan emitted by Prometheus must pass this validator before persistence.
 * Invalid plans are tagged with violation details but still included (Athena
 * makes the final accept/reject decision).
 *
 * Required fields: task, role, wave, verification
 * Recommended fields: dependencies, filesInScope, acceptance_criteria
 */

import { checkForbiddenCommands } from "./verification_command_registry.js";
import {
  buildWorkerTopologyContract,
  normalizeExecutionPattern,
  normalizePlanRoleToWorkerName,
  normalizePrometheusPlanningMode,
  PROMETHEUS_PLANNING_MODE,
  selectExecutionPatternForPlans,
  type ExecutionPattern,
  type PrometheusPlanningMode,
  type WorkerTopologyContract,
} from "./role_registry.js";

/**
 * Canonical health-audit severity set that triggers mandatory task obligations.
 * Findings with these severities emitted by Janus must either become plan tasks
 * or carry an explicit cycle-specific exclusion justification.
 *
 * Defined here (plan_contract_validator.ts) as the canonical source and re-exported
 * from prometheus.ts for backward compatibility.  Use this import when you only need
 * the taxonomy without importing the full prometheus module.
 *
 * "important" has been removed — findings previously using that severity must use
 * "warning" instead.  "important" is bridged to "warning" at extraction time in
 * normalizeMandatorySeverity() to handle legacy stored findings.
 */
export const PLAN_CONTRACT_MANDATORY_SEVERITIES: ReadonlySet<string> = new Set(["critical", "warning"]);

/**
 * Canonical deterministic violation code taxonomy.
 *
 * Used by both the pre-normalization generation-boundary gate
 * (checkPacketCompleteness in prometheus.ts) and the post-normalization
 * contract validator (validatePlanContract below).  Having a single source of
 * truth means log messages, rejection metadata, and filtering logic all
 * reference the same well-known codes rather than free-form field-name strings.
 *
 * Pre-normalization codes (shared with UNRECOVERABLE_PACKET_REASONS):
 *   NO_TASK_IDENTITY, MISSING_CAPACITY_DELTA, INVALID_CAPACITY_DELTA,
 *   MISSING_REQUEST_ROI, INVALID_REQUEST_ROI, MISSING_VERIFICATION_COUPLING
 *
 * Post-normalization contract codes:
 *   TASK_TOO_SHORT, MISSING_ROLE, INVALID_WAVE,
 *   MISSING_VERIFICATION, NON_SPECIFIC_VERIFICATION, FORBIDDEN_COMMAND,
 *   MISSING_ACCEPTANCE_CRITERIA, MISSING_DEPENDENCIES
 */
export const PACKET_VIOLATION_CODE = Object.freeze({
  // ── Identity ──────────────────────────────────────────────────────────────
  /** All identity fields (task/title/task_id/id) are absent. */
  NO_TASK_IDENTITY:              "no_task_identity",
  /** task field is present but too short (< 5 chars after normalization). */
  TASK_TOO_SHORT:                "task_too_short",
  /** role field is absent or empty. */
  MISSING_ROLE:                  "missing_role",

  // ── Wave ──────────────────────────────────────────────────────────────────
  /** wave is not a positive finite integer. */
  INVALID_WAVE:                  "invalid_wave",

  // ── Verification ─────────────────────────────────────────────────────────
  /** verification field is absent or blank. */
  MISSING_VERIFICATION:          "missing_verification",
  /** verification value is a bare CLI command with no test file reference. */
  NON_SPECIFIC_VERIFICATION:     "non_specific_verification",
  /** verification value or verification_commands entry contains a forbidden glob or shell pattern. */
  FORBIDDEN_COMMAND:             "forbidden_command",
  /** verification_commands is absent, empty, or contains only blank entries. */
  MISSING_VERIFICATION_COUPLING: "missing_verification_coupling",
  /**
   * No named verification target could be resolved from verification or
   * verification_commands — all entries are non-specific CLI commands.
   * Plans with unbound targets risk high-latency, low-yield worker calls.
   */
  UNBOUND_VERIFICATION_TARGET:   "unbound_verification_target",

  // ── Acceptance criteria ──────────────────────────────────────────────────
  /** acceptance_criteria is absent or empty — no measurable completion signal. */
  MISSING_ACCEPTANCE_CRITERIA:   "missing_acceptance_criteria",
  /**
   * One or more acceptance_criteria items are semantically invalid — they are
   * too short (< MIN_ACCEPTANCE_CRITERION_SEMANTIC_LENGTH chars) or contain
   * process-thought / tool-trace contamination markers.
   */
  INVALID_ACCEPTANCE_CRITERIA_ITEM: "invalid_acceptance_criteria_item",
  /** dependencies field is absent or not an array. */
  MISSING_DEPENDENCIES:          "missing_dependencies",

  // ── Decomposition / size ──────────────────────────────────────────────────
  /**
   * Task has too many acceptance criteria or files in scope — it is an oversized
   * compound task that must be decomposed into smaller work items.
   */
  TASK_TOO_LARGE:                "task_too_large",
  /**
   * Task description is too generic/vague — it does not specify a concrete
   * artifact, system component, or measurable outcome.
   */
  TASK_AMBIGUOUS:                "task_ambiguous",
  /**
   * Packet is too thin to admit dispatch after densification pass.
   * Thin packets must either be auto-bundled or rejected with explicit reasons.
   */
  THIN_PACKET_REJECTED:          "thin_packet_rejected",

  // ── Scoring fields (shared with generation-boundary gate) ────────────────
  /** capacityDelta is absent. */
  MISSING_CAPACITY_DELTA:        "missing_capacity_delta",
  /** capacityDelta is present but not a finite number ∈ [-1.0, 1.0]. */
  INVALID_CAPACITY_DELTA:        "invalid_capacity_delta",
  /** requestROI is absent. */
  MISSING_REQUEST_ROI:           "missing_request_roi",
  /** requestROI is present but not a positive finite number. */
  INVALID_REQUEST_ROI:           "invalid_request_roi",
  /** Low-leverage or redundant packets must include concrete implementation evidence. */
  MISSING_IMPLEMENTATION_EVIDENCE: "missing_implementation_evidence",
  /** Low-leverage or redundant packets must include measurable capacity-first justification. */
  MISSING_CAPACITY_FIRST_JUSTIFICATION: "missing_capacity_first_justification",
  /**
   * Plan silently softens an explicit operator requirement or quality bar into a
   * cheaper substitute (placeholder, mock, demo-only flow, simplified stand-in).
   */
  INTENT_REQUIREMENT_SOFTENED: "intent_requirement_softened",
  /**
   * Backward-compatible alias for media-specific drift; kept because media is one
   * concrete example of the broader intent-softening failure class.
   */
  MEDIA_REQUIREMENT_SOFTENED: "intent_requirement_softened",
  /**
   * Plan is tagged as backed by stale diagnostics data and lacks independent
   * justification.  Stale-backed plans must be quarantined until diagnostics
   * are refreshed or the plan provides independent evidence.
   */
  STALE_DIAGNOSTICS_BACKED: "stale_diagnostics_backed",

  // ── executionStrategy shape ───────────────────────────────────────────────
  /**
   * A task entry in executionStrategy.waves[*].tasks is a plain string rather
   * than the required {role, task, task_id} object shape.  The parser
   * (normalizeExecutionStrategyWaveTasks) must convert strings before the
   * validator runs; a string reaching the validator indicates a bypassed
   * normalization path.
   */
  WAVE_TASK_NOT_OBJECT:          "wave_task_not_object",
  /** executionStrategy.planningMode is absent. */
  MISSING_PLANNING_MODE:         "missing_planning_mode",
  /** executionStrategy.planningMode is not a registered planning mode. */
  INVALID_PLANNING_MODE:         "invalid_planning_mode",
  /** executionStrategy.executionPattern is absent. */
  MISSING_EXECUTION_PATTERN:     "missing_execution_pattern",
  /** executionStrategy.executionPattern is not a registered pattern. */
  INVALID_EXECUTION_PATTERN:     "invalid_execution_pattern",
  /** executionStrategy.workerTopology is absent. */
  MISSING_WORKER_TOPOLOGY:       "missing_worker_topology",
  /** executionStrategy.workerTopology does not match the authoritative plan shape. */
  INVALID_WORKER_TOPOLOGY:       "invalid_worker_topology",
});

/**
 * Verification values that are non-specific: bare CLI commands with no test file
 * reference or observable assertion description.
 * Per the Prometheus output format, `verification` MUST be a specific test file
 * path + expected test description, not a generic command invocation.
 *
 * SENTINEL CONTRACT: every entry here MUST have a corresponding entry in
 * NON_SPECIFIC_VERIFICATION_CANONICAL_FIXTURES (same index, same array length).
 * isNonSpecificVerification delegates to this array as its final check so the
 * function behaviour stays mechanically coupled to the declared patterns.
 */
export const NON_SPECIFIC_VERIFICATION_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /^npm\s+test\s*$/i,
  /^npm\s+run\s+test\s*$/i,
  /^npm\s+run\s+tests\s*$/i,
  /^node\s+--test\s*$/i,
  /^npx\s+[a-z][\w-]*\s*$/i,
  /^run\s+tests?\s*$/i,
  /^tests?\s+pass\s*$/i,
]);

/**
 * One canonical positive fixture per entry in NON_SPECIFIC_VERIFICATION_PATTERNS
 * (index-aligned).  The pre-merge sentinel test asserts:
 *   1. lengths are equal (no pattern without a fixture, no fixture without a pattern)
 *   2. isNonSpecificVerification(fixture) === true for every entry
 * Adding a pattern without also adding a fixture here will fail the sentinel.
 */
export const NON_SPECIFIC_VERIFICATION_CANONICAL_FIXTURES: ReadonlyArray<string> = Object.freeze([
  "npm test",
  "npm run test",
  "npm run tests",
  "node --test",
  "npx vitest",
  "run tests",
  "tests pass",
]);

/**
 * Maximum number of acceptance criteria a single plan task may declare.
 * Plans exceeding this threshold are oversized compound tasks that should be
 * decomposed into smaller, independently-verifiable work items.
 */
export const MAX_ACCEPTANCE_CRITERIA_PER_TASK = 10;

/**
 * Minimum character length for an individual acceptance criterion item to be
 * considered semantically valid. Items shorter than this are likely single-character
 * noise tokens or empty placeholders that carry no measurable completion signal.
 */
export const MIN_ACCEPTANCE_CRITERION_SEMANTIC_LENGTH = 2 as const;

/**
 * Maximum number of files a single plan task may declare in its scope
 * (filesInScope or target_files). Plans with broader file coverage are
 * oversized compound tasks.
 */
export const MAX_FILES_IN_SCOPE_PER_TASK = 30;

/**
 * Regex patterns matching ambiguous, underspecified task descriptions.
 * A description is ambiguous when it contains only generic action/noun
 * vocabulary without specifying a concrete artifact, system component, or
 * measurable outcome.
 */
export const AMBIGUOUS_TASK_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /^fix\s*(bugs?|issues?|things?|stuff|it|that|this|them)?\s*$/i,
  /^update\s*(code|system|things?|stuff|it|that|this|them)?\s*$/i,
  /^improve\s*(system|code|things?|stuff|it|performance|quality)?\s*$/i,
  /^refactor\s*(code|things?|stuff|it|that|this|them)?\s*$/i,
  /^clean\s*up\s*(code|things?|stuff|it|that|this|them)?\s*$/i,
  /^misc(ellaneous)?\s*(changes?|updates?|fixes?)?\s*$/i,
  /^general\s*(cleanup|refactor|update|fix|improvement|changes?)?\s*$/i,
  /^various\s*(updates?|changes?|fixes?|improvements?)?\s*$/i,
  /^add\s+tests?\s*$/i,
  /^write\s+tests?\s*$/i,
]);

/**
 * Minimum length for an exclusion justification to be considered cycle-specific.
 * Shared with mandatoryTaskCoverage validation in Prometheus.
 */
export const MANDATORY_EXCLUSION_JUSTIFICATION_MIN_LENGTH = 12;

const CI_CRITICAL_AREA_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /^ci$/,
  /continuous[\s_-]?integration/i,
  /github[\s_-]?actions/i,
  /\bbuild\b/i,
  /\btest(?:s|ing)?\b/i,
]);

const CI_CRITICAL_TEXT_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bci(?:[\s._-]?fix|[\s._-]?failure|[\s._-]?fail(?:ing|ed)?)\b/i,
  /\bworkflow\b/i,
  /\bpipeline\b/i,
  /\bchecks?\b/i,
]);

/** Pattern to detect CI-broken debt in system-learning findings. */
const CI_SYSTEM_LEARNING_DEBT_PATTERN = /\bci[-_\s]?(?:broken|break|fail(?:ed|ing)?|fix|repair)\b/i;

/**
 * Maximum age in ms for CI-break findings stored in health_audit_findings.json
 * before they are suppressed when fresh main-branch CI success evidence exists.
 *
 * Set to 2 hours — aligns with the general diagnostics freshness window and
 * allows short-lived CI flaps to surface without permanently gating healthy runs.
 */
export const CI_BREAK_FINDING_FRESHNESS_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Return true when a health audit finding is a direct CI-break finding emitted
 * by runSystemHealthAudit (area=ci with a CI repair capability).
 *
 * Used by freshness normalization (normalizeStaleCiBreakFindings in prometheus.ts)
 * to suppress stale CI-break findings when current main-branch CI evidence is healthy.
 *
 * Narrower than isCiCriticalMandatoryFinding: targets only the canonical shape
 * produced by runSystemHealthAudit, not arbitrary pattern-matched text findings.
 */
export function isCiBreakFinding(finding: unknown): boolean {
  if (!finding || typeof finding !== "object") return false;
  const entry = finding as Record<string, unknown>;
  const area = String(entry.area || "").trim().toLowerCase();
  if (area !== "ci") return false;
  const capability = String(entry.capabilityNeeded || "").trim().toLowerCase();
  return capability === "ci-fix" || capability === "ci-setup";
}

/**
 * Maximum age in ms for the health-audit snapshot beyond which a system-learning
 * CI-debt finding's per-finding CI-success annotation is considered unreliable.
 * Matches CI_BREAK_FINDING_FRESHNESS_MAX_AGE_MS (2 h) for consistency.
 */
export const SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS = CI_BREAK_FINDING_FRESHNESS_MAX_AGE_MS;

export function isCiBreakageText(value: unknown): boolean {
  const text = String(value || "").trim();
  if (!text) return false;
  return (
    CI_SYSTEM_LEARNING_DEBT_PATTERN.test(text)
    || /\b(ci|continuous[\s_-]?integration|workflow|pipeline|checks?)\b/i.test(text)
  );
}

/**
 * Return true when a finding is a system-learning entry that encodes CI-breaking
 * debt (text matches the CI-debt pattern).  Used by normalizeStaleCiBreakFindings
 * to identify findings eligible for freshness-based suppression when CI is healthy.
 */
export function isSystemLearningCiDebtFinding(finding: unknown): boolean {
  if (!finding || typeof finding !== "object") return false;
  const entry = finding as Record<string, unknown>;
  const area = String(entry.area || "").trim().toLowerCase();
  if (area !== "system-learning") return false;
  const text = `${String(entry.finding || "")} ${String(entry.remediation || "")}`;
  return isCiBreakageText(text);
}

export function hasFreshCiFailureEvidence(
  payload: unknown,
  finding: unknown,
  nowMs: number = Date.now(),
): boolean {
  if (!finding || typeof finding !== "object") return false;
  const entry = finding as Record<string, unknown>;
  if (!isCiBreakFinding(finding) && !isSystemLearningCiDebtFinding(finding)) {
    return false;
  }

  const payloadObj = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const payloadConclusion = String(payloadObj.latestMainCiConclusion || "").trim().toLowerCase();
  const findingConclusion = String(entry.latestMainCiConclusion || "").trim().toLowerCase();
  if (payloadConclusion === "success" || findingConclusion === "success") {
    return false;
  }

  const auditedAt = String(payloadObj.auditedAt || entry.auditedAt || "").trim();
  const auditedAtMs = auditedAt ? Date.parse(auditedAt) : NaN;
  if (!Number.isFinite(auditedAtMs)) return false;
  const auditAgeMs = nowMs - auditedAtMs;
  if (auditAgeMs < 0) return false;
  return auditAgeMs <= SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS;
}

export function hasUnresolvedCiFollowUpSignal(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  if (record.closedAt || record.taskCompleted === true || record.followUpNeeded === false) {
    return false;
  }
  const text = [
    record.followUpTask,
    record.lesson,
    record.lessonLearned,
    record.expectedOutcome,
    record.actualOutcome,
    record.finding,
    record.remediation,
  ].map((value) => String(value || "").trim()).filter(Boolean).join("\n");
  return isCiBreakageText(text);
}

export function isCiCriticalMandatoryFinding(finding: unknown): boolean {
  if (!finding || typeof finding !== "object") return false;
  const entry = finding as Record<string, unknown>;
  const severity = String(entry.severity || "").trim().toLowerCase();
  if (severity !== "critical") return false;

  // Explicit fastlane marker — highest-signal override.
  if (entry.ciFastlaneRequired === true) return true;

  const area = String(entry.area || "").trim().toLowerCase();
  const capability = String(entry.capabilityNeeded || "").trim().toLowerCase();
  const text = `${String(entry.finding || "")}\n${String(entry.remediation || "")}`.toLowerCase();

  // Standard CI-area / CI-text pattern matching.
  if (
    CI_CRITICAL_AREA_PATTERNS.some((pattern) => pattern.test(area))
    || CI_CRITICAL_TEXT_PATTERNS.some((pattern) => pattern.test(capability))
    || CI_CRITICAL_TEXT_PATTERNS.some((pattern) => pattern.test(text))
  ) return true;

  // System-learning findings that describe CI-breaking behavior are also CI-critical
  // when the finding text matches a CI-debt signal, regardless of area label.
  if (area === "system-learning" && CI_SYSTEM_LEARNING_DEBT_PATTERN.test(text)) return true;

  return false;
}

function collectUniqueMatches(text: string, matcher: RegExp): string[] {
  const src = String(text || "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of src.matchAll(matcher)) {
    const token = String(match[1] || match[0] || "").trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

export function extractCiEvidenceFromMandatoryFinding(finding: unknown): {
  failedTestIdentifiers: string[];
  errorMessages: string[];
  stackTraces: string[];
} {
  if (!finding || typeof finding !== "object") {
    return { failedTestIdentifiers: [], errorMessages: [], stackTraces: [] };
  }
  const entry = finding as Record<string, unknown>;
  const text = `${String(entry.finding || "")}\n${String(entry.remediation || "")}`;

  const failedTestIdentifiers = collectUniqueMatches(
    text,
    /\b(tests\/[A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]s)\b/g
  );
  const errorMessages = collectUniqueMatches(
    text,
    /(\b(?:\w+Error|AssertionError|TypeError|ReferenceError|SyntaxError):[^\n;]+)/g
  );
  const stackTraces = collectUniqueMatches(
    text,
    /(\bat\s+\S[^\n;]*)/g
  );

  if (errorMessages.length === 0) {
    const fallback = String(entry.finding || "").trim();
    if (fallback.length > 0) errorMessages.push(fallback);
  }

  return { failedTestIdentifiers, errorMessages, stackTraces };
}

/**
 * Return true when the plans array already contains at least one wave-1 CI fix plan.
 *
 * A plan is considered a CI repair plan when its taskKind equals "ci-fix",
 * OR its task text / task_id matches the canonical CI fix pattern, AND it sits
 * on wave 1.  This check is used by the pre-dispatch CI-closure gate to decide
 * whether non-CI plans can be dispatched alongside an outstanding CI repair.
 */
export function hasActiveCiRepairPlan(plans: unknown[]): boolean {
  if (!Array.isArray(plans)) return false;
  return plans.some((plan) => {
    if (!plan || typeof plan !== "object") return false;
    const p = plan as Record<string, unknown>;
    const wave = Number(p.wave);
    if (wave !== 1) return false;
    if (String(p.taskKind || "").trim().toLowerCase() === "ci-fix") return true;
    const taskText = String(p.task || p.title || p.task_id || "").toLowerCase();
    return /\bci[\s_-]?(fix|repair|failure)\b/.test(taskText);
  });
}
/**
 * Return true when the plans array contains ONLY CI-repair plans (taskKind=ci-fix).
 * Used to allow dispatch to proceed when all queued work is CI remediation.
 */
export function allPlansAreCiRepair(plans: unknown[]): boolean {
  if (!Array.isArray(plans) || plans.length === 0) return false;
  return plans.every((plan) => {
    if (!plan || typeof plan !== "object") return false;
    const p = plan as Record<string, unknown>;
    if (String(p.taskKind || "").trim().toLowerCase() === "ci-fix") return true;
    const taskText = String(p.task || p.title || p.task_id || "").toLowerCase();
    return /\bci[\s_-]?(fix|repair|failure)\b/.test(taskText);
  });
}
/**
 * Canonical shape for every entry in executionStrategy.waves[*].tasks.
 * All three fields are required; no plain-string tasks are permitted in
 * this position — the parser normalizes strings before validation.
 */
export interface WaveTaskObject {
  role: string;
  task: string;
  task_id: string;
  [key: string]: unknown;
}

function buildExecutionStrategyTopologySeedPlans(payload: any): any[] {
  const plans = Array.isArray(payload?.plans) ? payload.plans.filter(Boolean) : [];
  if (plans.length > 0) return plans;
  const waves = Array.isArray(payload?.executionStrategy?.waves) ? payload.executionStrategy.waves : [];
  const seeded: any[] = [];
  for (let i = 0; i < waves.length; i += 1) {
    const waveObj = waves[i] && typeof waves[i] === "object" ? waves[i] : {};
    const wave = normalizeWaveNumber((waveObj as any).wave, i + 1);
    const tasks = Array.isArray((waveObj as any).tasks) ? (waveObj as any).tasks : [];
    for (const task of tasks) {
      if (!task || typeof task !== "object") continue;
      seeded.push({
        role: normalizePlanRoleToWorkerName((task as any).role),
        wave,
      });
    }
  }
  return seeded;
}

export interface ExecutionStrategyContractValidationResult {
  valid: boolean;
  planningMode: PrometheusPlanningMode;
  executionPattern: ExecutionPattern | null;
  workerTopology: WorkerTopologyContract;
  violations: PlanViolation[];
}

export function validateExecutionStrategyContract(payload: any): ExecutionStrategyContractValidationResult {
  const source = payload && typeof payload === "object" ? payload : {};
  const executionStrategy = source.executionStrategy && typeof source.executionStrategy === "object"
    ? source.executionStrategy
    : {};
  const rawPlanningMode = (executionStrategy as any).planningMode ?? source.planningMode;
  const parsedPlanningMode = normalizePrometheusPlanningMode(rawPlanningMode, null);
  const planningMode = parsedPlanningMode || PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION;
  const planningModeExplicit = String(rawPlanningMode || "").trim().length > 0;
  const rawExecutionPattern = (executionStrategy as any).executionPattern;
  const executionPattern = normalizeExecutionPattern(rawExecutionPattern, null);
  const seedPlans = buildExecutionStrategyTopologySeedPlans(source);
  const workerTopology = buildWorkerTopologyContract(seedPlans, { planningMode });
  const expectedExecutionPattern = selectExecutionPatternForPlans(seedPlans, {
    planningMode,
    workerTopology,
    uncertainty:
      (executionStrategy as any).planningUncertainty
      ?? source.planningUncertainty
      ?? source.uncertainty,
  });
  const violations: PlanViolation[] = [];

  if (!planningModeExplicit) {
    violations.push({
      field: "executionStrategy.planningMode",
      message: "executionStrategy.planningMode must explicitly declare master_evolution or repair_plan",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.MISSING_PLANNING_MODE,
    });
  } else if (parsedPlanningMode == null) {
    violations.push({
      field: "executionStrategy.planningMode",
      message: `executionStrategy.planningMode is invalid: "${String(rawPlanningMode).trim()}"`,
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.INVALID_PLANNING_MODE,
    });
  }

  if (!String(rawExecutionPattern || "").trim()) {
    violations.push({
      field: "executionStrategy.executionPattern",
      message: "executionStrategy.executionPattern must explicitly declare the worker execution pattern",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.MISSING_EXECUTION_PATTERN,
    });
  } else if (!executionPattern) {
    violations.push({
      field: "executionStrategy.executionPattern",
      message: `executionStrategy.executionPattern is invalid: "${String(rawExecutionPattern).trim()}"`,
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.INVALID_EXECUTION_PATTERN,
    });
  } else if (executionPattern !== expectedExecutionPattern) {
    violations.push({
      field: "executionStrategy.executionPattern",
      message:
        `executionStrategy.executionPattern must match the authoritative pattern `
        + `"${expectedExecutionPattern}" derived from plan shape, uncertainty, and worker topology`,
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.INVALID_EXECUTION_PATTERN,
    });
  }

  const rawTopology = (executionStrategy as any).workerTopology;
  if (!rawTopology || typeof rawTopology !== "object" || Array.isArray(rawTopology)) {
    violations.push({
      field: "executionStrategy.workerTopology",
      message: "executionStrategy.workerTopology must be an object describing roles, lanes, and max parallel workers",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.MISSING_WORKER_TOPOLOGY,
    });
  } else {
    const roleList = Array.isArray((rawTopology as any).roles) ? (rawTopology as any).roles : [];
    const laneList = Array.isArray((rawTopology as any).lanes) ? (rawTopology as any).lanes : [];
    const workerCount = Math.floor(Number((rawTopology as any).workerCount || 0));
    const laneCount = Math.floor(Number((rawTopology as any).laneCount || 0));
    const maxParallelWorkers = Math.floor(Number((rawTopology as any).maxParallelWorkers || 0));
    const topologyMatches =
      workerCount === workerTopology.workerCount &&
      laneCount === workerTopology.laneCount &&
      maxParallelWorkers === workerTopology.maxParallelWorkers &&
      roleList.length === workerTopology.roles.length &&
      laneList.length === workerTopology.lanes.length;
    if (!topologyMatches) {
      violations.push({
        field: "executionStrategy.workerTopology",
        message:
          "executionStrategy.workerTopology must match the authoritative role/lane topology derived from the plan set",
        severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
        code: PACKET_VIOLATION_CODE.INVALID_WORKER_TOPOLOGY,
      });
    }
  }

  return {
    valid: violations.length === 0,
    planningMode,
    executionPattern,
    workerTopology,
    violations,
  };
}

export interface PacketDensityThresholds {
  minTargetFiles: number;
  minAcceptanceCriteria: number;
  minTaskChars: number;
  minExecutionTokens: number;
}

export interface PacketDensityMetrics {
  taskChars: number;
  targetFiles: number;
  acceptanceCriteria: number;
  estimatedExecutionTokens: number;
}

export function computePacketDensityMetrics(plan: any): PacketDensityMetrics {
  // Use NaN when the field is absent/null so isThinPacketForAdmission can distinguish
  // "field missing" from "field explicitly set to a low value".
  const rawTokens = plan?.estimatedExecutionTokens;
  const estimatedExecutionTokens = rawTokens != null && rawTokens !== ""
    ? Number(rawTokens)
    : NaN;
  return {
    taskChars: String(plan?.task || "").trim().length,
    targetFiles: Array.isArray(plan?.target_files) ? plan.target_files.filter(Boolean).length : 0,
    acceptanceCriteria: Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria.filter(Boolean).length : 0,
    estimatedExecutionTokens,
  };
}

export function isThinPacketForAdmission(
  metrics: PacketDensityMetrics,
  thresholds: PacketDensityThresholds,
): boolean {
  // estimatedExecutionTokens=NaN means the field was absent — treat as unknown, not thin.
  // Only reject when the field is explicitly present AND below threshold.
  const tokensThin = Number.isFinite(metrics.estimatedExecutionTokens)
    && metrics.estimatedExecutionTokens < thresholds.minExecutionTokens;
  return (
    metrics.taskChars < thresholds.minTaskChars
    || metrics.targetFiles < thresholds.minTargetFiles
    || metrics.acceptanceCriteria < thresholds.minAcceptanceCriteria
    || tokensThin
  );
}

export function buildThinPacketRejectionReason(
  metrics: PacketDensityMetrics,
  thresholds: PacketDensityThresholds,
): string {
  const tokenMetric = Number.isFinite(metrics.estimatedExecutionTokens)
    ? String(metrics.estimatedExecutionTokens)
    : "absent";
  return (
    `thin_packet_rejected: taskChars=${metrics.taskChars}/${thresholds.minTaskChars}, ` +
    `targetFiles=${metrics.targetFiles}/${thresholds.minTargetFiles}, ` +
    `acceptanceCriteria=${metrics.acceptanceCriteria}/${thresholds.minAcceptanceCriteria}, ` +
    `estimatedExecutionTokens=${tokenMetric}/${thresholds.minExecutionTokens}`
  );
}

/** Canonical packet scope lane names based on target-file count. */
export const PACKET_LANE = Object.freeze({
  /** 1–2 files: typical single-module fix or targeted feature. */
  SMALL:   "small",
  /** 3–4 files: cross-module feature or refactor. */
  MEDIUM:  "medium",
  /** 5+ files: multi-module evolution (system-learning: Prometheus underestimates token budget here). */
  LARGE:   "large",
  /** Fallback when file count is unknown. */
  DEFAULT: "default",
} as const);

/**
 * Per-lane minimum packet-density thresholds.
 *
 * System-learning: Prometheus consistently declares ~2 k tokens for plans covering
 * 5+ files.  The LARGE lane enforces a hard 8 k floor. Small and medium lanes
 * keep the base 2 k floor so single-feature and medium-scope product work does
 * not get rejected purely because the token estimate is low-resolution.
 */
export const LANE_PACKET_SIZE_DEFAULTS: Record<string, PacketDensityThresholds> = Object.freeze({
  [PACKET_LANE.SMALL]:   { minTargetFiles: 1, minAcceptanceCriteria: 1, minTaskChars: 20, minExecutionTokens: 2000 },
  [PACKET_LANE.MEDIUM]:  { minTargetFiles: 3, minAcceptanceCriteria: 2, minTaskChars: 30, minExecutionTokens: 2000 },
  [PACKET_LANE.LARGE]:   { minTargetFiles: 5, minAcceptanceCriteria: 3, minTaskChars: 40, minExecutionTokens: 8000 },
  [PACKET_LANE.DEFAULT]: { minTargetFiles: 1, minAcceptanceCriteria: 1, minTaskChars: 20, minExecutionTokens: 2000 },
});

/**
 * Classify a packet into its scope lane based on declared target-file count.
 */
export function classifyPacketLane(targetFileCount: number): string {
  if (!Number.isFinite(targetFileCount) || targetFileCount < 0) return PACKET_LANE.DEFAULT;
  if (targetFileCount >= 5) return PACKET_LANE.LARGE;
  if (targetFileCount >= 3) return PACKET_LANE.MEDIUM;
  return PACKET_LANE.SMALL;
}

/**
 * Return the density thresholds for a packet based on its target-file count.
 * Used by Prometheus to enforce lane-appropriate token floors at thin-packet admission.
 */
export function getPacketThresholdsForLane(targetFileCount: number): PacketDensityThresholds {
  const lane = classifyPacketLane(targetFileCount);
  return LANE_PACKET_SIZE_DEFAULTS[lane];
}


export const EQUAL_DIMENSION_SET = Object.freeze([
  "architecture",
  "speed",
  "task-quality",
  "prompt-quality",
  "parser-quality",
  "worker-specialization",
  "model-task-fit",
  "learning-loop",
  "cost-efficiency",
  "security",
]);

const DIMENSION_ALIAS_TO_CANONICAL = Object.freeze({
  architecture: "architecture",
  speed: "speed",
  quality: "task-quality",
  "task quality": "task-quality",
  "task-quality": "task-quality",
  prompts: "prompt-quality",
  prompt: "prompt-quality",
  "prompt quality": "prompt-quality",
  "prompt-quality": "prompt-quality",
  parser: "parser-quality",
  normalization: "parser-quality",
  "parser quality": "parser-quality",
  "parser-quality": "parser-quality",
  worker: "worker-specialization",
  workers: "worker-specialization",
  "worker specialization": "worker-specialization",
  "worker-specialization": "worker-specialization",
  routing: "model-task-fit",
  "model-task fit": "model-task-fit",
  "model-task-fit": "model-task-fit",
  learning: "learning-loop",
  "learning loop": "learning-loop",
  "learning-loop": "learning-loop",
  roi: "cost-efficiency",
  cost: "cost-efficiency",
  "cost efficiency": "cost-efficiency",
  "cost-efficiency": "cost-efficiency",
  security: "security",
}) as Readonly<Record<string, string>>;

/**
 * Determine whether a task description is ambiguous/underspecified.
 * Returns true when the description matches a known generic-vocabulary pattern.
 *
 * @param {string} value - the plan's `task` field
 * @returns {boolean} true when the task is ambiguous
 */
export function isAmbiguousTask(value: string): boolean {
  if (!value || !String(value).trim()) return true;
  const v = String(value).trim();
  return AMBIGUOUS_TASK_PATTERNS.some(pattern => pattern.test(v));
}

/**
 * Validate that an exclusion justification is concrete enough for cycle-specific
 * auditing (not just a generic placeholder).
 *
 * @param {string} value - mandatoryTaskCoverage exclusion justification
 * @returns {boolean} true when justification is non-empty and sufficiently specific
 */
export function isCycleSpecificExclusionJustification(value: string): boolean {
  return String(value || "").trim().length >= MANDATORY_EXCLUSION_JUSTIFICATION_MIN_LENGTH;
}

const PROTECTED_INTENT_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bpremium\b/i,
  /\bproduction(?:-grade)?\b/i,
  /\bpolished\b/i,
  /\btrust(?:-building|\s+signals?)\b/i,
  /\breal(?:-time)?\b/i,
  /\breal\s+(?:api|integration|payment|auth|data|photo(?:s|graphy)?)\b/i,
  /\bfull\s+(?:integration|experience|flow)\b/i,
  /\b(?:food|dish|menu|restaurant|cafe|bakery|chef|checkout|payment|auth|onboarding)\b/i,
  /\b(?:landing\s*page|hero|gallery|testimonial|story|brand)\b/i,
]);

const DOWNGRADE_SUBSTITUTE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bplaceholder(?:s)?\b/i,
  /\bmock(?:ed|ing|s|up)?\b/i,
  /\bstub(?:bed|s)?\b/i,
  /\bdemo(?:-only)?\b/i,
  /\bfake\b/i,
  /\bdummy\b/i,
  /\blorem(?:\s+ipsum|\s+picsum)?\b/i,
  /\bsimplif(?:y|ied)\b/i,
  /\bminimal\s+version\b/i,
  /\bstand-?ins?\b/i,
  /\bhardcoded\s+(?:sample|samples|data)\b/i,
  /\bgeneric\s+(?:illustration|illustrations|content|imagery)\b/i,
]);

const EXPLICIT_FALLBACK_DISCLOSURE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\btemporary\b/i,
  /\btemporarily\b/i,
  /\binterim\b/i,
  /\bshort-?term\b/i,
  /\buntil\b/i,
  /\bblocked\s+by\b/i,
  /\bexternal\s+(?:dependency|credentials|approval|token|service)\b/i,
  /\bfollow-?up\b/i,
  /\bunblock\b/i,
  /\bphase\s*[0-9]+\b/i,
  /\bpreserv(?:e|ing)\s+the\s+(?:real|final|production)\s+(?:contract|path|integration|experience)\b/i,
  /\bdocumented\s+fallback\b/i,
]);

function extractPlanIntentText(plan: any): string {
  const values: string[] = [
    plan?.title,
    plan?.task,
    plan?.scope,
    plan?.before_state,
    plan?.after_state,
    plan?.verification,
  ].map((value) => String(value || "").trim()).filter(Boolean);

  if (Array.isArray(plan?.acceptance_criteria)) {
    for (const item of plan.acceptance_criteria) {
      const text = String(item || "").trim();
      if (text) values.push(text);
    }
  }

  return values.join("\n");
}

function isSilentIntentDowngrade(plan: any): boolean {
  const text = extractPlanIntentText(plan);
  if (!text) return false;

  const hasProtectedIntent = PROTECTED_INTENT_PATTERNS.some((pattern) => pattern.test(text));
  if (!hasProtectedIntent) return false;

  const hasDowngradeSignal = DOWNGRADE_SUBSTITUTE_PATTERNS.some((pattern) => pattern.test(text));
  if (!hasDowngradeSignal) return false;

  const disclosedTemporaryFallback = EXPLICIT_FALLBACK_DISCLOSURE_PATTERNS.some((pattern) => pattern.test(text));
  if (disclosedTemporaryFallback) return false;

  return true;
}

export function normalizeLeverageRank(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const normalized = String(raw || "").toLowerCase().replace(/[_]+/g, "-").replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const directKey = normalized.replace(/\s+/g, "-");
    const mapped = DIMENSION_ALIAS_TO_CANONICAL[normalized] || DIMENSION_ALIAS_TO_CANONICAL[directKey];
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    canonical.push(mapped);
  }
  return canonical;
}

/**
 * Determine whether a `verification` field value is non-specific.
 * A value is non-specific when it contains no test file reference (`.test.ts`,
 * `.test.js`, `.spec.ts`, etc.) and no test description separator (`— test:`)
 * and matches a known bare CLI command pattern.
 *
 * @param {string} value - the plan's `verification` field
 * @returns {boolean} true when non-specific (should be rejected)
 */
export function isNonSpecificVerification(value: string): boolean {
  if (!value || !String(value).trim()) return true;
  const v = String(value).trim();
  // Specific: references a test file by extension
  if (/\.(test|spec)\.(ts|js|tsx|jsx)/i.test(v)) return false;
  // Specific: references a tests/ directory path (with or without leading slash/= separator)
  if (/(^|[/\\=])tests?\/[^\s]/i.test(v)) return false;
  // Specific: contains a --testPathPattern= argument pointing to a path
  if (/--testPathPattern=[^\s]/i.test(v)) return false;
  // Specific: contains a description separator used by the output format
  if (/[—\-–]\s*test[:\s]/i.test(v)) return false;
  // Specific: contains a --grep (or -t) flag with a substantive test-name pattern (≥4 chars).
  // Athena often writes `npm test -- --grep 'pattern'` which IS scoped to specific tests.
  if (/--grep\s+['"][^'"]{4,}['"]/i.test(v)) return false;
  // Specific: contains a --testNamePattern flag with a substantive pattern (aliased in some runners).
  if (/--testNamePattern\s*=\s*['"][^'"]{4,}['"]/i.test(v)) return false;
  // Non-specific: matches a known bare CLI command (no file argument).
  // pnpm, yarn, and bun are included because bare invocations like "pnpm vitest"
  // or "yarn test" carry no test-file specificity.
  // Delegates to NON_SPECIFIC_VERIFICATION_PATTERNS as the authoritative source so
  // that the function behaviour is mechanically coupled to the declared patterns array.
  return /^(npm|node|npx|pnpm|yarn|bun)\s/i.test(v)
    || /^run\s+(test|check)/i.test(v)
    || NON_SPECIFIC_VERIFICATION_PATTERNS.some(p => p.test(v));
}

/**
 * Resolve a deterministic, named verification target from plan fields.
 * Preference:
 *   1) plan.verification (if specific)
 *   2) first specific entry in verification_commands[]
 * Returns null when no specific target is available.
 */
export function resolveNamedVerificationTarget(plan: any): string | null {
  const direct = String(plan?.verification || "").trim();
  if (direct && !isNonSpecificVerification(direct)) return direct;
  const commands = Array.isArray(plan?.verification_commands) ? plan.verification_commands : [];
  for (const cmd of commands) {
    const value = String(cmd || "").trim();
    if (!value) continue;
    if (!isNonSpecificVerification(value)) return value;
  }
  return null;
}

/**
 * Bind resolved named verification targets onto plan objects in-place.
 *
 * This converts specific entries found in verification_commands[] into the
 * canonical verification field before dispatch, ensuring downstream workers
 * always receive deterministic, named verification targets when available.
 */
export function bindNamedVerificationTargets(
  plans: any[],
): { boundCount: number; unboundCount: number } {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { boundCount: 0, unboundCount: 0 };
  }

  let boundCount = 0;
  let unboundCount = 0;
  for (const plan of plans) {
    const boundTarget = resolveNamedVerificationTarget(plan);
    if (boundTarget) {
      plan.verification = boundTarget;
      plan._boundVerificationTarget = boundTarget;
      boundCount += 1;
    } else {
      unboundCount += 1;
    }
  }

  return { boundCount, unboundCount };
}

/**
 * Plan contract violation severity levels.
 * @enum {string}
 */
export const PLAN_VIOLATION_SEVERITY = Object.freeze({
  CRITICAL: "critical",
  WARNING: "warning",
});

/**
 * A single contract violation emitted by validatePlanContract.
 * `code` is a deterministic value from PACKET_VIOLATION_CODE and is the
 * canonical identifier for machine consumption; `message` is human-readable.
 */
export interface PlanViolation {
  field: string;
  message: string;
  severity: string;
  code: string;
}

/**
 * Validate a single plan against the contract schema.
 *
 * @param {object} plan
 * @returns {{ valid: boolean, violations: PlanViolation[] }}
 */
export function validatePlanContract(plan): { valid: boolean; violations: PlanViolation[] } {
  if (!plan || typeof plan !== "object") {
    return {
      valid: false,
      violations: [{
        field: "plan",
        message: "Plan is null or not an object",
        severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
        code: PACKET_VIOLATION_CODE.NO_TASK_IDENTITY,
      }],
    };
  }

  const violations: PlanViolation[] = [];

  if (plan._thinPacketRejected === true) {
    violations.push({
      field: "packetDensity",
      message: String(plan._thinPacketReason || "Thin packet rejected by dispatch admission contract"),
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.THIN_PACKET_REJECTED,
    });
  }

  // Stale diagnostics admission gate: plans tagged by the diagnostics freshness
  // gate are quarantined until diagnostics are refreshed or independent evidence
  // is supplied.  The tag is set by tagStaleDiagnosticsBackedPlans() in prometheus.ts
  // and carries a machine-readable reason string.
  if (plan._staleDiagnosticsGated === true) {
    violations.push({
      field: "diagnosticsFreshness",
      message: String(
        plan._staleDiagnosticsReason
        || "Plan is backed by stale diagnostics and must be quarantined until diagnostics are refreshed",
      ),
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.STALE_DIAGNOSTICS_BACKED,
    });
  }

  // Required fields
  if (!plan.task || String(plan.task).trim().length < 5) {
    violations.push({
      field: "task",
      message: "Task must be a non-empty string (≥5 chars)",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.TASK_TOO_SHORT,
    });
  } else if (isAmbiguousTask(String(plan.task))) {
    // Only flag ambiguity when the task passes the length check (avoids duplicate errors).
    // Hard admission: ambiguous task descriptions block dispatch — they cannot be
    // deterministically evaluated or routed to the correct worker.
    violations.push({
      field: "task",
      message: `Task description is too generic/ambiguous: "${String(plan.task).trim().slice(0, 80)}". ` +
        "Specify a concrete artifact, system component, or measurable outcome.",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.TASK_AMBIGUOUS,
    });
  }

  if (!plan.role || String(plan.role).trim().length === 0) {
    violations.push({
      field: "role",
      message: "Role must be specified",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.MISSING_ROLE,
    });
  }

  const wave = Number(plan.wave);
  if (!Number.isFinite(wave) || wave < 1) {
    violations.push({
      field: "wave",
      message: `Wave must be a positive integer, got: ${plan.wave}`,
      severity: PLAN_VIOLATION_SEVERITY.WARNING,
      code: PACKET_VIOLATION_CODE.INVALID_WAVE,
    });
  }

  if (!plan.verification || String(plan.verification).trim().length === 0) {
    violations.push({
      field: "verification",
      message: "Verification command must be specified",
      severity: PLAN_VIOLATION_SEVERITY.WARNING,
      code: PACKET_VIOLATION_CODE.MISSING_VERIFICATION,
    });
  } else if (isNonSpecificVerification(String(plan.verification))) {
    violations.push({
      field: "verification",
      message: `Verification target is non-specific: "${String(plan.verification).trim()}". ` +
        "Must reference a specific test file (e.g. tests/core/foo.test.ts — test: expected description). " +
        "Generic commands like 'npm test' alone are rejected.",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.NON_SPECIFIC_VERIFICATION,
    });
  }

  // Verification target binding check: warn when no named verification target can be
  // resolved from either verification or verification_commands.  Plans dispatched without
  // a bound target risk high-latency, low-yield worker calls that cannot be evaluated.
  // Only emitted when the plan has at least one verification field set (MISSING_VERIFICATION
  // already covers the fully-absent case above).
  const hasAnyVerificationField =
    (plan.verification && String(plan.verification).trim().length > 0) ||
    (Array.isArray(plan.verification_commands) && plan.verification_commands.some(
      (cmd) => String(cmd ?? "").trim().length > 0,
    ));
  if (hasAnyVerificationField && resolveNamedVerificationTarget(plan) === null) {
    violations.push({
      field: "verification",
      message: "No named verification target could be resolved from verification or verification_commands. " +
        "All entries resolve to non-specific CLI commands — bind a specific test file before dispatch.",
      severity: PLAN_VIOLATION_SEVERITY.WARNING,
      code: PACKET_VIOLATION_CODE.UNBOUND_VERIFICATION_TARGET,
    });
  }

  // Recommended fields
  if (!Array.isArray(plan.dependencies)) {
    violations.push({
      field: "dependencies",
      message: "Dependencies should be an array",
      severity: PLAN_VIOLATION_SEVERITY.WARNING,
      code: PACKET_VIOLATION_CODE.MISSING_DEPENDENCIES,
    });
  }

  if (!Array.isArray(plan.acceptance_criteria) || plan.acceptance_criteria.length === 0) {
    violations.push({
      field: "acceptance_criteria",
      message: "Acceptance criteria must be a non-empty array — plans without measurable AC are rejected",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.MISSING_ACCEPTANCE_CRITERIA,
    });
  } else if (plan.acceptance_criteria.length > MAX_ACCEPTANCE_CRITERIA_PER_TASK) {
    // Oversized AC list — hard admission: compound tasks cannot be routed, budgeted,
    // or reliably verified. Must be decomposed into independently-verifiable work items.
    violations.push({
      field: "acceptance_criteria",
      message: `Task has ${plan.acceptance_criteria.length} acceptance criteria (max ${MAX_ACCEPTANCE_CRITERIA_PER_TASK}). ` +
        "Oversized tasks must be decomposed into smaller, independently-verifiable work items.",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.TASK_TOO_LARGE,
    });
  } else {
    // Semantic validation of individual AC items: reject too-short items and items
    // that contain process-thought / tool-trace contamination markers.
    const invalidItems: string[] = [];
    for (let i = 0; i < plan.acceptance_criteria.length; i++) {
      const item = String(plan.acceptance_criteria[i] ?? "").trim();
      if (item.length < MIN_ACCEPTANCE_CRITERION_SEMANTIC_LENGTH) {
        invalidItems.push(`item[${i}] too short (len=${item.length})`);
      } else if (detectProcessThoughtMarkers(item)) {
        invalidItems.push(`item[${i}] contains process-thought markers`);
      }
    }
    if (invalidItems.length > 0) {
      violations.push({
        field: "acceptance_criteria",
        message: `${invalidItems.length} acceptance criterion item(s) are semantically invalid: ${invalidItems.slice(0, 3).join("; ")}`,
        severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
        code: PACKET_VIOLATION_CODE.INVALID_ACCEPTANCE_CRITERIA_ITEM,
      });
    }
  }

  if (isSilentIntentDowngrade(plan)) {
    violations.push({
      field: "protectedIntent",
      message: "Plan silently downgrades an explicit operator requirement or quality bar into a cheaper substitute. Temporary fallbacks are allowed only when they are clearly disclosed with the blocker reason and preserve the promised outcome class.",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.INTENT_REQUIREMENT_SOFTENED,
    });
  }

  // Decomposition cap: files-in-scope ceiling.
  const inScopeFiles: unknown[] | null = Array.isArray(plan.filesInScope)
    ? plan.filesInScope
    : Array.isArray(plan.target_files)
      ? plan.target_files
      : null;
  if (inScopeFiles !== null && inScopeFiles.length > MAX_FILES_IN_SCOPE_PER_TASK) {
    // Hard admission: tasks spanning more than MAX_FILES_IN_SCOPE_PER_TASK files
    // cannot be reliably verified or budgeted — decompose into focused work items.
    violations.push({
      field: "filesInScope",
      message: `Task declares ${inScopeFiles.length} files in scope (max ${MAX_FILES_IN_SCOPE_PER_TASK}). ` +
        "Tasks with broad file coverage are oversized — decompose into focused work items.",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.TASK_TOO_LARGE,
    });
  }

  // Measurable capacity delta — expected change in system capacity if plan succeeds.
  // Mandatory field: finite number ∈ [-1.0, 1.0]. Plans without a valid capacityDelta
  // are rejected — they cannot be ranked or compared against budget constraints.
  if (!("capacityDelta" in plan)) {
    violations.push({
      field: "capacityDelta",
      message: "capacityDelta is missing — plans must declare the expected measurable change in system capacity (number ∈ [-1.0, 1.0])",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.MISSING_CAPACITY_DELTA,
    });
  } else {
    const cd = Number(plan.capacityDelta);
    if (!Number.isFinite(cd) || cd < -1 || cd > 1) {
      violations.push({
        field: "capacityDelta",
        message: `capacityDelta must be a finite number ∈ [-1.0, 1.0]; got: ${plan.capacityDelta}`,
        severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
        code: PACKET_VIOLATION_CODE.INVALID_CAPACITY_DELTA,
      });
    }
  }

  // Request ROI — expected return-on-investment for the premium request consumed.
  // Mandatory field: positive finite number (dimensionless gain ratio). Plans without
  // a valid requestROI are rejected — they cannot be ranked by cost-effectiveness.
  if (!("requestROI" in plan)) {
    violations.push({
      field: "requestROI",
      message: "requestROI is missing — plans must declare the expected return-on-investment for the premium request consumed (positive finite number)",
      severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
      code: PACKET_VIOLATION_CODE.MISSING_REQUEST_ROI,
    });
  } else {
    const roi = Number(plan.requestROI);
    if (!Number.isFinite(roi) || roi <= 0) {
      violations.push({
        field: "requestROI",
        message: `requestROI must be a positive finite number; got: ${plan.requestROI}`,
        severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
        code: PACKET_VIOLATION_CODE.INVALID_REQUEST_ROI,
      });
    }
  }

  const leverageRank = normalizeLeverageRank(plan?.leverage_rank);
  const lowLeverage = Array.isArray(plan?.leverage_rank) && leverageRank.length < 2;
  const taskText = String(plan?.task || "").toLowerCase();
  const implementationStatus = String(plan?.implementationStatus || "").toLowerCase();
  const redundantCandidate =
    ["implemented", "implemented_correctly", "already_implemented", "completed", "complete"].includes(implementationStatus)
    || /\balready\b|\bredundant\b|\bduplicate\b|\bno-op\b/.test(taskText);
  const requiresEvidenceGate = lowLeverage || redundantCandidate;
  if (requiresEvidenceGate) {
    const evidence = Array.isArray(plan?.implementationEvidence) ? plan.implementationEvidence : [];
    const hasImplementationEvidence = evidence.some((entry: unknown) => String(entry || "").trim().length > 0);
    if (!hasImplementationEvidence) {
      violations.push({
        field: "implementationEvidence",
        message: "Low-leverage or redundant packets must include explicit implementationEvidence before admission.",
        severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
        code: PACKET_VIOLATION_CODE.MISSING_IMPLEMENTATION_EVIDENCE,
      });
    }

    const capacityDelta = Number(plan?.capacityDelta);
    const requestROI = Number(plan?.requestROI);
    const hasCapacityFirstJustification = Number.isFinite(capacityDelta) && capacityDelta > 0
      && Number.isFinite(requestROI) && requestROI > 1;
    if (!hasCapacityFirstJustification) {
      violations.push({
        field: "capacityDelta/requestROI",
        message: "Low-leverage or redundant packets should include measurable capacity-first justification (capacityDelta>0 and requestROI>1). When grounded evidence exists, keep the packet reviewable and surface this as a warning rather than fail-closing the cycle.",
        severity: PLAN_VIOLATION_SEVERITY.WARNING,
        code: PACKET_VIOLATION_CODE.MISSING_CAPACITY_FIRST_JUSTIFICATION,
      });
    }
  }

  // Forbidden verification command gate (Packet 5) — uses centralized registry.
  // Check all command-bearing fields: verification (string) and
  // verification_commands (array) so Windows false-fails can't slip through
  // a non-primary command field.
  const commandsToCheck: Array<{ field: string; value: string }> = [
    { field: "verification", value: String(plan.verification || "") },
  ];

  const extractExecutableVerificationFragment = (value: string): string => {
    const text = String(value || "").trim();
    if (!text) return "";

    const directTargetMatch = text.match(
      /^([^\s"'`]+?\.(?:test|spec)\.[cm]?[jt]sx?)(?=\s|$)/i
    );
    if (directTargetMatch?.[1]) return directTargetMatch[1];

    return text
      .split(/\s+[-—–]\s+test:/i)[0]
      .trim();
  };

  if (Array.isArray(plan.verification_commands)) {
    plan.verification_commands.forEach((cmd: unknown, idx: number) => {
      commandsToCheck.push({ field: `verification_commands[${idx}]`, value: String(cmd || "") });
    });
  }

  for (const { field, value } of commandsToCheck) {
    const forbidden = checkForbiddenCommands(
      field === "verification" ? extractExecutableVerificationFragment(value) : value
    );
    if (forbidden.forbidden) {
      for (const v of forbidden.violations) {
        violations.push({
          field,
          message: `Forbidden command: ${v.reason}`,
          severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
          code: PACKET_VIOLATION_CODE.FORBIDDEN_COMMAND,
        });
      }
    }
  }

  const criticalCount = violations.filter(v => v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL).length;
  return { valid: criticalCount === 0, violations };
}
/**
 * Validate all plans in a batch and compute aggregate pass rate.
 *
 * @param {object[]} plans
 * @returns {{ passRate: number, totalPlans: number, validCount: number, invalidCount: number, results: Array<{ planIndex: number, task: string, valid: boolean, violations: object[] }> }}
 */
export function validateAllPlans(plans) {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { passRate: 1.0, totalPlans: 0, validCount: 0, invalidCount: 0, results: [] };
  }

  const results = plans.map((plan, i) => {
    const r = validatePlanContract(plan);
    return {
      planIndex: i,
      task: String(plan?.task || "").slice(0, 80),
      valid: r.valid,
      violations: r.violations,
    };
  });

  const validCount = results.filter(r => r.valid).length;
  const invalidCount = results.length - validCount;
  const passRate = Math.round((validCount / results.length) * 100) / 100;

  return { passRate, totalPlans: results.length, validCount, invalidCount, results };
}

// ── Quarantine gate ───────────────────────────────────────────────────────────

/**
 * Confidence threshold below which a packet is considered quarantined.
 * Mirrors the value exported by prometheus.ts so both modules share the same gate.
 */
export const QUARANTINE_CONFIDENCE_THRESHOLD = 0.5 as const;

function getOwnPacketConfidence(packet: unknown): number | undefined {
  if (!packet || typeof packet !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(packet, "_admissionConfidence")) {
    const admissionConfidence = (packet as { _admissionConfidence?: unknown })._admissionConfidence;
    if (typeof admissionConfidence === "number") {
      return admissionConfidence;
    }
  }
  if (Object.prototype.hasOwnProperty.call(packet, "_provenance")) {
    const provenance = (packet as { _provenance?: unknown })._provenance;
    if (
      provenance &&
      typeof provenance === "object" &&
      Object.prototype.hasOwnProperty.call(provenance, "confidence")
    ) {
      const confidence = (provenance as { confidence?: unknown }).confidence;
      if (typeof confidence === "number") {
        return confidence;
      }
    }
  }
  return undefined;
}

/**
 * Determine whether a plan packet should be quarantined from dispatch.
 *
 * A packet is quarantined when:
 *   1. It carries `_quarantined: true` (explicitly set by quarantineLowConfidencePackets), or
 *   2. It has a packet admission confidence below QUARANTINE_CONFIDENCE_THRESHOLD.
 *      `_admissionConfidence` takes precedence when present; `_provenance.confidence`
 *      remains the backward-compatible fallback.
 *
 * Packets without provenance metadata pass through (backward compatible).
 *
 * @param packet — any plan object
 * @returns true when the packet must not be dispatched
 */
export function isPacketQuarantined(packet: any): boolean {
  if (!packet || typeof packet !== "object") return false;
  if (
    Object.prototype.hasOwnProperty.call(packet, "_quarantined") &&
    packet._quarantined === true
  ) {
    return true;
  }
  const confidence = getOwnPacketConfidence(packet);
  if (typeof confidence === "number") {
    return confidence < QUARANTINE_CONFIDENCE_THRESHOLD;
  }
  return false;
}

/**
 * Filter a plans array into dispatchable and quarantined sets using
 * `isPacketQuarantined` as the predicate.
 *
 * Complements `quarantineLowConfidencePackets` (which attaches provenance and
 * partitions by confidence) by filtering plans that were already tagged
 * `_quarantined: true` by any upstream mechanism (e.g. stale-diagnostics gate,
 * explicit provenance attachment).
 *
 * @param plans — plan objects to partition
 * @returns { dispatchable: any[], quarantined: any[] }
 */
export function filterQuarantinedPlans(
  plans: any[],
): { dispatchable: any[]; quarantined: any[] } {
  if (!Array.isArray(plans)) return { dispatchable: [], quarantined: [] };
  const dispatchable: any[] = [];
  const quarantined: any[] = [];
  for (const plan of plans) {
    if (isPacketQuarantined(plan)) {
      quarantined.push(plan);
    } else {
      dispatchable.push(plan);
    }
  }
  return { dispatchable, quarantined };
}

// ── Output fidelity gate ──────────────────────────────────────────────────────

/**
 * failReason value written to the persisted analysis when the output-fidelity
 * gate fires after both initial parse and one constrained retry both contain
 * process-thought markers in strategic fields.
 */
export const OUTPUT_FIDELITY_GATE_FAIL_REASON = "output-fidelity-gate" as const;

/**
 * Regex patterns that identify process-thought markers — internal reasoning
 * tokens emitted by some AI models that must NOT appear in persisted plan
 * output (plans[], analysis text, strategicNarrative, keyFindings).
 *
 * Patterns are purposely broad (case-insensitive) to catch all variants.
 */
export const PROCESS_THOUGHT_MARKER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /<think[\s>]/i,
  /<\/think>/i,
  /<reasoning[\s>]/i,
  /<\/reasoning>/i,
  /\[THINKING\]/i,
  /\[\/THINKING\]/i,
  /<internal>/i,
  /<\/internal>/i,
  /<!--\s*thinking/i,
  // Process narration: first-person agent action narration at sentence start — tool-use verbs
  /^(let\s+me|i'?m\s+going\s+to|i\s+am\s+going\s+to|i\s+will\s+now|i'?m\s+now|i\s+am\s+now|now\s+i\s+will|now\s+i'?m|i'?ll\s+now)\s+(read|scan|check|view|analyze|look|open|search|find|examine|browse|explore|fetch|get|inspect)/im,
  // Process narration: first-person procedural intent — investigation/gathering/evidence verbs
  /^(let\s+me|i'?m\s+going\s+to|i\s+am\s+going\s+to|i\s+will\s+now|i'?m\s+now|i\s+am\s+now|now\s+i\s+will|now\s+i'?m|i'?ll\s+now)\s+(gather|collect|investigate|review|document|compile|assess|evaluate|determine|identify|figure|understand|capture|record)\b/im,
  // Semantic tool-trace: direct tool invocation fragments
  /\b(view_file|read_file|write_file|list_files|search_files|create_file|delete_file)\s*\(/i,
  // Semantic tool-trace: tool/function output block markers
  /^(tool\s+output|function\s+output|tool\s+response|function\s+result)\s*:/im,
  // Semantic tool-trace: present-progressive tool operation at line start
  /^(reading|scanning|checking|viewing)\s+(the\s+)?(file|directory|repo|codebase|code|source)\b/im,
  // Unparsed decision blobs: structured planner/reviewer decision markers at line start
  /^(DECISION|APPROVE|REJECT|VOTE|VERDICT|OUTCOME|RATIONALE)\s*[:=]/im,
  // Unparsed decision blobs: JSON object with decision-related keys
  /^\s*\{[^{}]*"(decision|approve|reject|vote|confidence|rationale|verdict|outcome)"\s*:/im,
]);

/**
 * Detect whether a string contains process-thought markers.
 * Pure function — no side effects.
 *
 * Unicode NFKC normalization is applied before matching so homoglyph
 * substitutions (e.g. mathematical bold characters) cannot bypass ASCII-
 * anchored patterns.
 *
 * @param text — any string (plan task text, analysis narrative, etc.)
 * @returns true when at least one process-thought marker is present
 */
export function detectProcessThoughtMarkers(text: string): boolean {
  let s = String(text || "");
  try {
    s = s.normalize("NFKC");
  } catch {
    // normalize() should never throw on a valid string, but guard defensively.
  }
  return PROCESS_THOUGHT_MARKER_PATTERNS.some((pattern) => pattern.test(s));
}

/**
 * Scan the strategic fields of a parsed Prometheus output for process-thought
 * markers.  Returns the list of contaminated field paths for audit logging.
 *
 * Strategic fields checked:
 *   - analysis / strategicNarrative / keyFindings (top-level strings)
 *   - plans[*].task and plans[*].context (per-plan strings)
 *
 * @param parsed — raw parsed object from AI output
 * @returns array of field path strings that contain markers (empty = clean)
 */
export function scanParsedOutputForProcessThought(parsed: unknown): string[] {
  const contaminated: string[] = [];
  if (!parsed || typeof parsed !== "object") return contaminated;
  const obj = parsed as Record<string, unknown>;

  for (const field of ["analysis", "strategicNarrative", "keyFindings"]) {
    if (typeof obj[field] === "string" && detectProcessThoughtMarkers(obj[field] as string)) {
      contaminated.push(field);
    }
  }

  const plans = Array.isArray(obj.plans) ? obj.plans : [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (!plan || typeof plan !== "object") continue;
    const p = plan as Record<string, unknown>;
    if (typeof p.task === "string" && detectProcessThoughtMarkers(p.task)) {
      contaminated.push(`plans[${i}].task`);
    }
    if (typeof p.context === "string" && detectProcessThoughtMarkers(p.context)) {
      contaminated.push(`plans[${i}].context`);
    }
  }

  return contaminated;
}

/**
 * Maximum number of actionable steps (plans) allowed per packet bundle by default.
 * Operators may override via config.planner.maxActionableStepsPerPacket.
 * The hard maximum is enforced before dispatch admission.
 */
export const MAX_ACTIONABLE_STEPS_PER_PACKET = 3 as const;

/**
 * Violation code emitted when a packet bundle exceeds the actionable-steps cap.
 * Oversized bundles must be auto-split before admission.
 */
export const PACKET_OVERSIZE_REASON = "packet_exceeds_actionable_steps_cap" as const;

/**
 * Bounded packet-size policy defaults to prevent over-bundling.
 *
 * Over-bundling occurs when too many plans are packed into one worker batch,
 * causing context overflow and missed inter-plan ordering constraints.  These
 * defaults apply when no explicit config is provided, preventing unbounded
 * token accumulation in the common case.
 *
 * Token floor: plans covering 5+ files must declare at minimum 8k tokens
 * (derived from system learning: Prometheus consistently underestimates at 2k
 * per plan for 7-8 file scopes).
 *
 * Fields:
 *   maxPlansPerPacket      — hard cap on plans per batch (overrides MAX_ACTIONABLE_STEPS_PER_PACKET
 *                            when explicitly configured via config.planner.maxPlansPerPacket)
 *   minTokensPerPlan       — minimum estimated token cost per plan; plans below this
 *                            floor are treated as under-estimated and bumped up
 *   minTokensForMultiFile  — minimum token floor for plans with 5+ target files
 *   multiFileThreshold     — number of target files that triggers the higher token floor
 */
export const BOUNDED_PACKET_SIZE_POLICY = Object.freeze({
  maxPlansPerPacket:      5,
  minTokensPerPlan:       2000,
  minTokensForMultiFile:  8000,
  multiFileThreshold:     5,
});

/**
 * Resolve the bounded packet-size policy from config, merging operator overrides
 * with the defaults from BOUNDED_PACKET_SIZE_POLICY.
 *
 * All fields are clamped to safe ranges:
 *   maxPlansPerPacket:     [1, 20]
 *   minTokensPerPlan:      [500, 100_000]
 *   minTokensForMultiFile: [1000, 200_000]
 *   multiFileThreshold:    [1, 30]
 *
 * @param config — BOX config object (may be null/undefined)
 * @returns resolved packet-size policy object
 */
export function resolvePacketSizePolicy(config: unknown): { maxPlansPerPacket: number; minTokensPerPlan: number; minTokensForMultiFile: number; multiFileThreshold: number } {
  const planner = (config as any)?.planner ?? {};
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  const rawMaxPlans = Number(planner.maxPlansPerPacket);
  const maxPlansPerPacket = Number.isFinite(rawMaxPlans) && rawMaxPlans > 0
    ? clamp(Math.floor(rawMaxPlans), 1, 20)
    : BOUNDED_PACKET_SIZE_POLICY.maxPlansPerPacket;

  const rawMinTokens = Number(planner.minTokensPerPlan);
  const minTokensPerPlan = Number.isFinite(rawMinTokens) && rawMinTokens > 0
    ? clamp(Math.floor(rawMinTokens), 500, 100_000)
    : BOUNDED_PACKET_SIZE_POLICY.minTokensPerPlan;

  const rawMinMultiFile = Number(planner.minTokensForMultiFile);
  const minTokensForMultiFile = Number.isFinite(rawMinMultiFile) && rawMinMultiFile > 0
    ? clamp(Math.floor(rawMinMultiFile), 1000, 200_000)
    : BOUNDED_PACKET_SIZE_POLICY.minTokensForMultiFile;

  const rawMultiFileThreshold = Number(planner.multiFileThreshold);
  const multiFileThreshold = Number.isFinite(rawMultiFileThreshold) && rawMultiFileThreshold > 0
    ? clamp(Math.floor(rawMultiFileThreshold), 1, 30)
    : BOUNDED_PACKET_SIZE_POLICY.multiFileThreshold;

  return { maxPlansPerPacket, minTokensPerPlan, minTokensForMultiFile, multiFileThreshold };
}

/**
 * Apply bounded token floor to a plan's estimatedExecutionTokens.
 *
 * If the plan has >= multiFileThreshold target files but its token estimate
 * is below minTokensForMultiFile, the estimate is raised to the floor.
 * Otherwise, if the estimate is below minTokensPerPlan, it is raised to that floor.
 *
 * This corrects the systematic under-estimation observed in Prometheus output
 * for multi-file scoped plans.
 *
 * @param plan   — plan object (any shape; target_files and estimatedExecutionTokens read)
 * @param policy — resolved packet-size policy
 * @returns corrected token estimate (never lower than input)
 */
export function applyTokenFloorToEstimate(
  plan: unknown,
  policy: ReturnType<typeof resolvePacketSizePolicy>,
): number {
  const p = plan as any;
  const fileCount = Array.isArray(p?.target_files) ? p.target_files.filter(Boolean).length : 0;
  const rawEstimate = Number(p?.estimatedExecutionTokens);
  const estimate = Number.isFinite(rawEstimate) && rawEstimate > 0 ? rawEstimate : 0;

  if (fileCount >= policy.multiFileThreshold) {
    return Math.max(estimate, policy.minTokensForMultiFile);
  }
  if (estimate > 0) {
    return Math.max(estimate, policy.minTokensPerPlan);
  }
  return estimate;
}

/**
 * Hard admission check: validate that per-role plan groups do not exceed the
 * actionable-steps cap before dispatch.
 *
 * Plans are grouped by role. When Athena deterministic batch metadata is
 * present (`_batchIndex`), grouping becomes role+batch so independently
 * bounded batches are not rejected as one oversized role bucket.
 *
 * If any role(-batch) group exceeds the configured cap, dispatch must be
 * blocked with a deterministic reason — the caller must decompose or re-batch
 * before dispatch.
 *
 * @param plans            — all plans queued for dispatch
 * @param maxStepsPerGroup — per-role cap (default: MAX_ACTIONABLE_STEPS_PER_PACKET)
 * @returns { blocked, reason, oversizedRoles }
 */
export function validatePacketBatchAdmission(
  plans: any[],
  maxStepsPerGroup: number = MAX_ACTIONABLE_STEPS_PER_PACKET,
): { blocked: boolean; reason: string | null; oversizedRoles: string[] } {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { blocked: false, reason: null, oversizedRoles: [] };
  }

  const cap = Math.max(1, Math.floor(maxStepsPerGroup));

  const roleGroups = new Map<string, number>();
  const groupLabels = new Map<string, string>();
  for (const plan of plans) {
    const role = String(plan?._batchWorkerRole || plan?.role || "unknown").trim().toLowerCase();
    const rawBatchIndex = Number(plan?._batchIndex);
    const hasBatchIndex = Number.isFinite(rawBatchIndex) && rawBatchIndex > 0;
    const batchIndex = hasBatchIndex ? Math.floor(rawBatchIndex) : null;
    const groupKey = hasBatchIndex ? `${role}#batch:${batchIndex}` : role;
    const label = hasBatchIndex ? `${role}[batch ${batchIndex}]` : role;
    const orderedSteps = Array.isArray(plan?.orderedSteps) ? plan.orderedSteps.length
      : Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria.length
      : 1;
    roleGroups.set(groupKey, (roleGroups.get(groupKey) ?? 0) + Math.max(1, orderedSteps));
    if (!groupLabels.has(groupKey)) {
      groupLabels.set(groupKey, label);
    }
  }

  const oversizedRoles: string[] = [];
  for (const [groupKey, complexity] of roleGroups) {
    if (complexity > cap) {
      const label = groupLabels.get(groupKey) || groupKey;
      oversizedRoles.push(`${label}(${complexity}>${cap})`);
    }
  }

  if (oversizedRoles.length === 0) {
    return { blocked: false, reason: null, oversizedRoles: [] };
  }

  const reason = `${PACKET_OVERSIZE_REASON}: role group(s) [${oversizedRoles.join(", ")}] exceed per-role ordered-step complexity cap of ${cap} — decompose or split before dispatch`;
  return { blocked: true, reason, oversizedRoles };
}

/**
 * Final dispatch-boundary hard cap: split any batch descriptor whose plans array
 * exceeds MAX_ACTIONABLE_STEPS_PER_PACKET into smaller chunks.
 *
 * This is an unconditional last-resort safeguard applied at the dispatch boundary
 * after all batching paths (Athena-prebatched, token-first, standard role-split)
 * converge.  It guarantees no worker ever receives more than
 * MAX_ACTIONABLE_STEPS_PER_PACKET tasks, even when earlier packet checks pass or
 * are bypassed by alternate batching paths.
 *
 * Split chunks carry a `_dispatchHardCapSplit: true` marker so telemetry consumers
 * can observe when the hard cap triggered.
 *
 * @param batches — array of batch descriptors (any shape with a `plans` array)
 * @param cap     — maximum plans per batch (default: MAX_ACTIONABLE_STEPS_PER_PACKET)
 * @returns a new array of batch descriptors; no batch exceeds the cap
 */
export function applyDispatchBoundaryHardCap<T extends { plans: unknown[] }>(
  batches: T[],
  cap: number = MAX_ACTIONABLE_STEPS_PER_PACKET,
): T[] {
  if (!Array.isArray(batches) || batches.length === 0) return batches;
  const maxPerBatch = Math.max(1, Math.floor(cap));
  const result: T[] = [];
  for (const batch of batches) {
    const plans = Array.isArray(batch.plans) ? batch.plans : [];
    if (plans.length <= maxPerBatch) {
      result.push(batch);
    } else {
      for (let offset = 0; offset < plans.length; offset += maxPerBatch) {
        result.push({ ...batch, plans: plans.slice(offset, offset + maxPerBatch), _dispatchHardCapSplit: true } as T);
      }
    }
  }
  return result;
}

export interface RolePlanCoverageValidationResult {
  ok: boolean;
  requiredRoles: string[];
  missingRoles: string[];
  initialMissingRoles: string[];
  initialMissingRoleMarkers: string[];
  injectedRoles: string[];
  injectedSkeletonMetadata: Array<{
    role: string;
    wave: number;
    marker: string;
    source: string;
    task_id: string;
  }>;
  invalidRolePlans: string[];
  output: any;
}

export const ROLE_PLAN_COVERAGE_MISSING_MARKER_PREFIX = "missing_execution_strategy_role";
export const ROLE_PLAN_SKELETON_METADATA_SOURCE = "execution_strategy_role_coverage_fallback_v1";

function normalizeRoleValue(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeWaveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function roleSlug(value: string): string {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "worker";
}

function buildMissingRoleMarker(role: string, wave: number): string {
  return `${ROLE_PLAN_COVERAGE_MISSING_MARKER_PREFIX}:${role}:wave:${wave}`;
}

function collectExecutionStrategyTaskRoles(payload: any): Array<{ role: string; wave: number }> {
  const executionStrategy = payload?.executionStrategy;
  const waves = Array.isArray(executionStrategy?.waves) ? executionStrategy.waves : [];
  if (waves.length === 0) return [];

  const firstWaveByRole = new Map<string, number>();
  for (let i = 0; i < waves.length; i++) {
    const waveObj = (waves[i] && typeof waves[i] === "object") ? waves[i] : {};
    const wave = normalizeWaveNumber((waveObj as any).wave, i + 1);
    const tasks = Array.isArray((waveObj as any).tasks) ? (waveObj as any).tasks : [];

    for (const rawTask of tasks) {
      // Object-only contract: executionStrategy.waves[*].tasks must contain
      // WaveTaskObject instances only.  normalizeExecutionStrategyWaveTasks()
      // in prometheus.ts is the single normalization gate that converts any
      // string entries before validation runs.  A string reaching this point
      // indicates a code path that bypassed the parser — skip it so phantom
      // role-coverage entries are never created from malformed input.
      // (Violation code: PACKET_VIOLATION_CODE.WAVE_TASK_NOT_OBJECT)
      if (!rawTask || typeof rawTask !== "object") continue;
      const task = rawTask as WaveTaskObject;
      const role = normalizeRoleValue(
        (task as any).role
        ?? (task as any).workerRole
        ?? (task as any).owner
        ?? (task as any)._batchWorkerRole,
      );
      if (!role) continue;
      const currentWave = firstWaveByRole.get(role);
      if (currentWave == null || wave < currentWave) {
        firstWaveByRole.set(role, wave);
      }
    }
  }

  return [...firstWaveByRole.entries()]
    .map(([role, wave]) => ({ role, wave }))
    .sort((a, b) => a.wave - b.wave || a.role.localeCompare(b.role));
}

function toRoleCoverageContractCandidate(plan: any, role: string, wave: number): any {
  const hasTaskIdentity = String(plan?.task || plan?.title || plan?.task_id || plan?.id || "").trim().length > 0;
  const candidateTask = hasTaskIdentity
    ? String(plan?.task || plan?.title || plan?.task_id || plan?.id || "").trim()
    : `Role coverage task for ${role}`;
  const acceptanceCriteria = Array.isArray(plan?.acceptance_criteria) && plan.acceptance_criteria.length > 0
    ? plan.acceptance_criteria
    : [
      `Role "${role}" has a contract-valid plans[] entry.`,
      "Execution strategy role coverage validation passes without missing roles.",
    ];

  const capacityDelta = Number(plan?.capacityDelta);
  const requestROI = Number(plan?.requestROI);

  return {
    ...plan,
    task: candidateTask,
    role,
    wave: normalizeWaveNumber(plan?.wave, wave),
    verification: String(plan?.verification || "").trim()
      || "tests/core/prometheus_parse.test.ts — test: validates executionStrategy role coverage",
    dependencies: Array.isArray(plan?.dependencies) ? plan.dependencies : [],
    acceptance_criteria: acceptanceCriteria,
    capacityDelta: Number.isFinite(capacityDelta) ? capacityDelta : 0.01,
    requestROI: Number.isFinite(requestROI) && requestROI > 0 ? requestROI : 1.05,
  };
}

function buildRoleCoverageSkeleton(role: string, wave: number): any {
  const slug = roleSlug(role);
  const marker = buildMissingRoleMarker(role, wave);
  const taskId = `role-coverage-${slug}-wave-${wave}`;
  return {
    task_id: taskId,
    title: `Role coverage skeleton for ${role} (wave ${wave})`,
    task: `Inject contract-valid fallback plan coverage for role "${role}" in wave ${wave}`,
    role,
    wave,
    scope: `executionStrategy role coverage fallback for role "${role}"`,
    target_files: ["src/core/prometheus.ts", "src/core/plan_contract_validator.ts"],
    dependencies: [],
    acceptance_criteria: [
      `Role "${role}" is represented by a contract-valid plan entry.`,
      `Pre-Athena role-plan coverage validation reports role "${role}" as covered.`,
    ],
    verification: "tests/core/prometheus_parse.test.ts — test: validates role-plan skeleton fallback injection",
    capacityDelta: 0.01,
    requestROI: 1.05,
    estimatedExecutionTokens: 2000,
    riskLevel: "medium",
    _missingRoleMarker: marker,
    _rolePlanSkeletonSource: ROLE_PLAN_SKELETON_METADATA_SOURCE,
    _rolePlanSkeletonMetadata: {
      role,
      wave,
      marker,
      source: ROLE_PLAN_SKELETON_METADATA_SOURCE,
      task_id: taskId,
    },
    _rolePlanSkeletonInjected: true,
  };
}

export function validateAndInjectRolePlans(
  payload: any,
  opts: { injectMissing?: boolean } = {},
): RolePlanCoverageValidationResult {
  const source = (payload && typeof payload === "object") ? payload : {};
  const plans = Array.isArray(source.plans) ? source.plans.slice() : [];
  const requiredRoleRefs = collectExecutionStrategyTaskRoles(source);
  const requiredRoles = requiredRoleRefs.map((ref) => ref.role);
  if (requiredRoles.length === 0) {
    return {
      ok: true,
      requiredRoles: [],
      missingRoles: [],
      initialMissingRoles: [],
      initialMissingRoleMarkers: [],
      injectedRoles: [],
      injectedSkeletonMetadata: [],
      invalidRolePlans: [],
      output: { ...source, plans },
    };
  }

  const firstWaveByRole = new Map(requiredRoleRefs.map((ref) => [ref.role, ref.wave]));
  const validRoles = new Set<string>();
  const invalidRolePlans = new Set<string>();

  for (const plan of plans) {
    const role = normalizeRoleValue(plan?.role);
    if (!role || !firstWaveByRole.has(role)) continue;
    const candidate = toRoleCoverageContractCandidate(plan, role, firstWaveByRole.get(role) || 1);
    if (validatePlanContract(candidate).valid) {
      validRoles.add(role);
    } else {
      invalidRolePlans.add(role);
    }
  }

  const initialMissingRoles = requiredRoles.filter((role) => !validRoles.has(role));
  const initialMissingRoleMarkers = initialMissingRoles.map((role) =>
    buildMissingRoleMarker(role, firstWaveByRole.get(role) || 1)
  );
  const injectMissing = opts?.injectMissing === true;
  const injectedRoles: string[] = [];
  const injectedSkeletonMetadata: Array<{
    role: string;
    wave: number;
    marker: string;
    source: string;
    task_id: string;
  }> = [];

  if (injectMissing && initialMissingRoles.length > 0) {
    for (const role of initialMissingRoles) {
      const wave = firstWaveByRole.get(role) || 1;
      const skeleton = buildRoleCoverageSkeleton(role, wave);
      if (validatePlanContract(skeleton).valid) {
        plans.push(skeleton);
        validRoles.add(role);
        injectedRoles.push(role);
        const skeletonMeta = skeleton?._rolePlanSkeletonMetadata;
        if (skeletonMeta && typeof skeletonMeta === "object") {
          injectedSkeletonMetadata.push({
            role: String(skeletonMeta.role || role),
            wave: normalizeWaveNumber(skeletonMeta.wave, wave),
            marker: String(skeletonMeta.marker || buildMissingRoleMarker(role, wave)),
            source: String(skeletonMeta.source || ROLE_PLAN_SKELETON_METADATA_SOURCE),
            task_id: String(skeletonMeta.task_id || skeleton.task_id || ""),
          });
        } else {
          injectedSkeletonMetadata.push({
            role,
            wave,
            marker: buildMissingRoleMarker(role, wave),
            source: ROLE_PLAN_SKELETON_METADATA_SOURCE,
            task_id: String(skeleton.task_id || ""),
          });
        }
      }
    }
  }

  const missingRoles = requiredRoles.filter((role) => !validRoles.has(role));
  return {
    ok: missingRoles.length === 0,
    requiredRoles,
    missingRoles,
    initialMissingRoles,
    initialMissingRoleMarkers,
    injectedRoles,
    injectedSkeletonMetadata,
    invalidRolePlans: [...invalidRolePlans].sort(),
    output: { ...source, plans },
  };
}

