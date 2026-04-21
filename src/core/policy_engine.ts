import path from "node:path";
import { readJson } from "./fs_utils.js";
import { runShadowEvaluation } from "./shadow_policy_evaluator.js";
import {
  validateGovernanceContract,
  GovernanceContractError
} from "./governance_contract.js";
import {
  assignCohort,
  COHORT,
  isGovernanceCanaryBreachActive
} from "./governance_canary.js";

/**
 * The reason code prefix used when a runtime hook enforcement denies a tool-use envelope.
 * Value matches the prefix of the blockReason string returned by enforcePreExecuteHookDecisions.
 * Consumers can use this constant to deterministically detect hook denial blocks without
 * hard-coding the string literal in every check.
 */
export const HOOK_DENIAL_REASON_CODE = "runtime_hook_denied";

export async function loadPolicy(config) {
  return readJson(config.paths.policyFile, {
    protectedPaths: [],
    requireReviewerApprovalForProtectedPaths: true,
    blockedCommands: [],
    rolePolicies: {}
  });
}

/**
 * Load policy and validate the embedded governance contract.
 *
 * On governance validation failure, throws GovernanceContractError with:
 *   - message format: "[governance] <errorCode>: <detail>"
 *   - err.errorCode : one of GOVERNANCE_ERROR_CODE values
 *   - err.exitCode  : GOVERNANCE_STARTUP_EXIT_CODE (1)
 *
 * Callers at startup SHOULD catch GovernanceContractError and call process.exit(err.exitCode).
 *
 * Recovery path: fix policy.json governanceContract section and restart.
 *
 * @param {object} config
 * @returns {Promise<object>} loaded and governance-validated policy
 * @throws {GovernanceContractError} when governance contract is missing or invalid
 */
export async function loadPolicyWithGovernance(config) {
  const policy = await loadPolicy(config);
  const result = validateGovernanceContract(policy);
  if (!result.ok) {
    throw new GovernanceContractError(result.errorCode, result.message.replace(`[governance] ${result.errorCode}: `, ""));
  }
  return policy;
}

// Re-export governance contract utilities for callers that import from policy_engine
export {
  validateGovernanceContract,
  GovernanceContractError,
  GOVERNANCE_STARTUP_EXIT_CODE
} from "./governance_contract.js";

// Re-export governance freeze utilities (T-040)
export {
  FREEZE_RISK_LEVEL,
  FREEZE_HIGH_RISK_LEVELS,
  FREEZE_NON_CRITICAL_LEVELS,
  FREEZE_GATE_RESULT,
  RISK_SCORE_THRESHOLDS,
  SYSTEMIC_GAP_SEVERITY,
  FREEZE_WEEKLY_METRICS_SCHEMA,
  YEAR_END_REPORT_SCHEMA,
  NEXT_YEAR_SEED_SCHEMA,
  isFreezeActive,
  classifyRiskLevel,
  evaluateFreezeGate,
  validateCriticalOverride,
  computeWeekKey,
  recordFreezeWeeklyMetrics,
  generateYearEndReport,
  generateNextYearSeedQuestion,
  checkFreezeRollbackCriteria
} from "./governance_freeze.js";

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function matchPathPattern(targetPath, pattern) {
  const pathNorm = normalizePath(targetPath);
  const patternNorm = normalizePath(pattern);
  if (!pathNorm || !patternNorm) return false;

  // Support prefix globs like "src/core/**"
  if (patternNorm.endsWith("/**")) {
    const prefix = patternNorm.slice(0, -3);
    return pathNorm === prefix || pathNorm.startsWith(`${prefix}/`);
  }

  // Support suffix globs like "**/orchestrator.js" or "**/*.test.ts".
  // The match is anchored to a path-separator boundary so that "bad_orchestrator.js"
  // does not falsely match "**/orchestrator.js". A bare "*" in the suffix matches
  // any run of non-separator characters (e.g. "**/*.test.ts" covers all .test.ts files).
  if (patternNorm.startsWith("**/")) {
    const suffix = patternNorm.slice(3);
    const reStr = suffix
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // escape regex metacharacters
      .replace(/\*/g, "[^/]*"); // glob * → match any non-separator chars
    return new RegExp(`(^|/)${reStr}$`).test(pathNorm);
  }

  return pathNorm === patternNorm;
}

export function isProtectedPath(policy, filePath) {
  const patterns = Array.isArray(policy?.protectedPaths) ? policy.protectedPaths : [];
  return patterns.some((pattern) => matchPathPattern(filePath, pattern));
}

export function getProtectedPathMatches(policy, filePaths) {
  const files = Array.isArray(filePaths) ? filePaths : [];
  return files.filter((file) => isProtectedPath(policy, file));
}

export function validateShellCommand(policy, command) {
  const normalized = String(command || "").toLowerCase();
  const blocked = (Array.isArray(policy?.blockedCommands) ? policy.blockedCommands : [])
    .find((item) => normalized.includes(String(item).toLowerCase()));
  if (blocked) {
    return { ok: false, reason: `blocked command matched: ${blocked}` };
  }
  return { ok: true };
}

export interface ToolIntentEnvelope {
  scope: string;
  intent: string;
  impact: "low" | "medium" | "high" | "critical";
  clearance: "read" | "write" | "admin";
  command?: string;
}

export interface ToolIntentDecision {
  allowed: boolean;
  decision: "allow" | "deny";
  reasonCode: string;
  ruleId: string;
}

const CLEARANCE_LEVEL: Record<ToolIntentEnvelope["clearance"], number> = {
  read: 1,
  write: 2,
  admin: 3,
};

const IMPACT_MIN_CLEARANCE: Record<ToolIntentEnvelope["impact"], ToolIntentEnvelope["clearance"]> = {
  low: "read",
  medium: "write",
  high: "admin",
  critical: "admin",
};

function normalizeImpact(value: unknown): ToolIntentEnvelope["impact"] | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "critical") {
    return normalized;
  }
  return null;
}

function normalizeClearance(value: unknown): ToolIntentEnvelope["clearance"] | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "read" || normalized === "write" || normalized === "admin") {
    return normalized;
  }
  return null;
}

/**
 * Deterministic tool execution policy decision from an explicit intent envelope.
 *
 * Returns structured allow/deny output for pre-tool hooks so workers can emit
 * machine-readable verification telemetry before each execute call.
 */
export function evaluateToolIntentEnvelope(policy, roleName, envelope: Partial<ToolIntentEnvelope>): ToolIntentDecision {
  const scope = String(envelope?.scope || "").trim();
  const intent = String(envelope?.intent || "").trim();
  const impact = normalizeImpact(envelope?.impact);
  const clearance = normalizeClearance(envelope?.clearance);

  if (!scope || !intent || !impact || !clearance) {
    return {
      allowed: false,
      decision: "deny",
      reasonCode: "TOOL_INTENT_INVALID_ENVELOPE",
      ruleId: "deny-invalid-tool-intent-envelope",
    };
  }

  const minClearance = IMPACT_MIN_CLEARANCE[impact];
  if (CLEARANCE_LEVEL[clearance] < CLEARANCE_LEVEL[minClearance]) {
    return {
      allowed: false,
      decision: "deny",
      reasonCode: "TOOL_INTENT_INSUFFICIENT_CLEARANCE",
      ruleId: "deny-insufficient-clearance-for-impact",
    };
  }

  const rolePolicy = getRolePolicy(policy, roleName);
  const allowedClearances = Array.isArray(rolePolicy?.allowedToolClearances)
    ? rolePolicy.allowedToolClearances.map((item) => String(item || "").trim().toLowerCase())
    : [];
  if (allowedClearances.length > 0 && !allowedClearances.includes(clearance)) {
    return {
      allowed: false,
      decision: "deny",
      reasonCode: "TOOL_INTENT_CLEARANCE_NOT_ALLOWED_FOR_ROLE",
      ruleId: "deny-role-tool-clearance",
    };
  }

  if (envelope?.command) {
    const shellCheck = validateShellCommand(policy, envelope.command);
    if (!shellCheck.ok) {
      return {
        allowed: false,
        decision: "deny",
        reasonCode: "TOOL_INTENT_BLOCKED_COMMAND",
        ruleId: "deny-blocked-shell-command",
      };
    }
  }

  return {
    allowed: true,
    decision: "allow",
    reasonCode: "TOOL_INTENT_ALLOWED",
    ruleId: "allow-tool-intent-envelope",
  };
}

/**
 * Batch-evaluate TOOL_INTENT envelopes against the loaded policy at runtime.
 *
 * This is the authoritative hook decision generator used by the worker runner.
 * Workers are no longer required to self-report HOOK_DECISION lines; the runner
 * evaluates each emitted TOOL_INTENT independently and produces deterministic
 * enforcement records.
 *
 * @param policy   - loaded policy from loadPolicy/loadPolicyWithGovernance
 * @param roleName - the worker role being evaluated
 * @param envelopes - TOOL_INTENT envelopes parsed from worker output
 * @returns array of { envelope, decision } pairs
 */
export function generateRuntimeHookDecisions(
  policy: unknown,
  roleName: string,
  envelopes: unknown[],
): Array<{ envelope: Partial<ToolIntentEnvelope>; decision: ToolIntentDecision }> {
  if (!Array.isArray(envelopes)) return [];
  return envelopes.map((envelope) => ({
    envelope: envelope as Partial<ToolIntentEnvelope>,
    decision: evaluateToolIntentEnvelope(policy, roleName, envelope as Partial<ToolIntentEnvelope>),
  }));
}

/**
 * Typed result from authoritative pre-execute hook decision enforcement.
 * Callers use `allowed` to gate worker execution and `blockReason` to
 * populate dispatchBlockReason when denying.
 */
export interface PreExecuteEnforcementResult {
  /** True when no envelope was denied; false when at least one denial exists. */
  allowed: boolean;
  /** Number of denied envelopes in this evaluation. */
  deniedCount: number;
  /** reasonCode from the first denied decision, or null when all allowed. */
  firstDeniedReasonCode: string | null;
  /** scope from the first denied envelope, or null when all allowed. */
  firstDeniedScope: string | null;
  /** All runtime-generated decisions for audit/telemetry. */
  decisions: Array<{ envelope: Partial<ToolIntentEnvelope>; decision: ToolIntentDecision }>;
  /** Structured block reason string suitable for dispatchBlockReason, or null when allowed. */
  blockReason: string | null;
}

/**
 * Authoritative pre-execute hook decision enforcement.
 *
 * Wraps generateRuntimeHookDecisions() as the single source of truth for whether
 * worker tool usage should be allowed. Workers are NOT trusted to self-report
 * HOOK_DECISION lines — only the runtime-generated decisions govern enforcement.
 *
 * @param policy    - loaded policy from loadPolicy/loadPolicyWithGovernance
 * @param roleName  - the worker role being evaluated
 * @param envelopes - TOOL_INTENT envelopes parsed from worker output
 * @returns PreExecuteEnforcementResult
 */
export function enforcePreExecuteHookDecisions(
  policy: unknown,
  roleName: string,
  envelopes: unknown[],
): PreExecuteEnforcementResult {
  const decisions = generateRuntimeHookDecisions(policy, roleName, envelopes);
  const denied = decisions.filter((r) => r.decision.decision === "deny");
  const firstDenied = denied.length > 0 ? denied[0] : null;
  const firstDeniedReasonCode = firstDenied?.decision?.reasonCode
    ? String(firstDenied.decision.reasonCode)
    : null;
  const firstDeniedScope = firstDenied?.envelope?.scope
    ? String(firstDenied.envelope.scope)
    : null;
  return {
    allowed:              denied.length === 0,
    deniedCount:          denied.length,
    firstDeniedReasonCode,
    firstDeniedScope,
    decisions,
    blockReason: firstDenied
      ? `runtime_hook_denied:${firstDeniedReasonCode ?? "unknown"}`
      : null,
  };
}

function normalizeRoleName(roleName) {
  return String(roleName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function getRolePolicy(policy, roleName) {
  const all = policy?.rolePolicies;
  if (!all || typeof all !== "object") return null;

  const normalized = normalizeRoleName(roleName);
  if (!normalized) return null;

  if (all[normalized]) return all[normalized];

  const direct = String(roleName || "").trim();
  if (direct && all[direct]) return all[direct];
  return null;
}

function matchesAnyPattern(text, patterns) {
  const normalized = String(text || "").toLowerCase();
  return patterns.some((item) => normalized.includes(String(item).toLowerCase()));
}

export function validateRoleInstruction(policy, roleName, taskText) {
  const rolePolicy = getRolePolicy(policy, roleName);
  if (!rolePolicy) return { ok: true };

  const blockedTaskPatterns = Array.isArray(rolePolicy?.blockedTaskPatterns)
    ? rolePolicy.blockedTaskPatterns
    : [];
  if (blockedTaskPatterns.length > 0 && matchesAnyPattern(taskText, blockedTaskPatterns)) {
    return {
      ok: false,
      reason: `role policy blocked task for ${roleName}`
    };
  }

  const requiredTaskPatterns = Array.isArray(rolePolicy?.requiredTaskPatterns)
    ? rolePolicy.requiredTaskPatterns
    : [];
  if (requiredTaskPatterns.length > 0 && !matchesAnyPattern(taskText, requiredTaskPatterns)) {
    return {
      ok: false,
      reason: `role policy missing required task intent for ${roleName}`
    };
  }

  return { ok: true };
}
export function getRolePathViolations(policy, roleName, filePaths) {
  const rolePolicy = getRolePolicy(policy, roleName);
  const files = Array.isArray(filePaths) ? filePaths : [];
  if (!rolePolicy || files.length === 0) {
    return {
      role: String(roleName || ""),
      deniedMatches: [],
      outsideAllowed: [],
      hasViolation: false
    };
  }

  const allowedPaths = Array.isArray(rolePolicy?.allowedPaths) ? rolePolicy.allowedPaths : [];
  const deniedPaths = Array.isArray(rolePolicy?.deniedPaths) ? rolePolicy.deniedPaths : [];

  const deniedMatches = deniedPaths.length > 0
    ? files.filter((file) => deniedPaths.some((pattern) => matchPathPattern(file, pattern)))
    : [];

  const outsideAllowed = allowedPaths.length > 0
    ? files.filter((file) => !allowedPaths.some((pattern) => matchPathPattern(file, pattern)))
    : [];

  return {
    role: String(roleName || ""),
    deniedMatches,
    outsideAllowed,
    hasViolation: deniedMatches.length > 0 || outsideAllowed.length > 0
  };
}

// ── Typed interfaces for decision branches ────────────────────────────────────

/** Options forwarded to runShadowEvaluation for policy promotion gating. */
export interface ShadowEvaluationOptions {
  stateDir?: string;
  threshold?: number;
  owner?: string;
  [key: string]: unknown;
}

/** Inputs for the composed governance decision (guardrail > freeze > canary). */
export interface GovernanceDecisionInputs {
  guardrailActive?: boolean;
  freezeActive?: boolean;
  canaryBreachActive?: boolean;
}

/**
 * Gate a policy promotion through shadow evaluation.
 *
 * Runs runShadowEvaluation against recent cycle history before any policy change
 * is applied to the runtime. Returns the evaluation result; callers must inspect
 * result.blocked to decide whether to proceed.
 *
 * @param {object}   currentPolicy    The currently loaded policy.
 * @param {object[]} proposedChanges  Proposed changes (see shadow_policy_evaluator.js schema).
 * @param {ShadowEvaluationOptions}   [options]        Forwarded to runShadowEvaluation (stateDir, threshold, owner).
 * @returns {Promise<object>}         Shadow evaluation result (schemaVersion: 1).
 */
export async function evaluatePolicyPromotion(currentPolicy, proposedChanges, options: ShadowEvaluationOptions = {}) {
  return runShadowEvaluation(currentPolicy, proposedChanges, options);
}

/**
 * Apply a single composed governance decision with guardrail > freeze > canary precedence.
 *
 * Precedence order (highest to lowest):
 *   1. guardrail — active hardware-level guard takes absolute priority
 *   2. freeze    — year-end stabilization freeze blocks changes
 *   3. canary    — active canary breach halts new governance rules
 *
 * All three inputs are booleans; the caller is responsible for resolving their
 * true/false status from the respective sub-systems before calling this function.
 *
 * @param {GovernanceDecisionInputs} inputs
 * @returns {{ blocked: boolean, reason: string, precedenceLevel: number }}
 */
export function applyGovernanceDecision({
  guardrailActive    = false,
  freezeActive       = false,
  canaryBreachActive = false
}: GovernanceDecisionInputs = {}) {
  if (guardrailActive) {
    return { blocked: true,  reason: "guardrail:active",      precedenceLevel: 1 };
  }
  if (freezeActive) {
    return { blocked: true,  reason: "freeze:active",         precedenceLevel: 2 };
  }
  if (canaryBreachActive) {
    return { blocked: true,  reason: "canary:breach-active",  precedenceLevel: 3 };
  }
  return { blocked: false, reason: "all-gates-passed", precedenceLevel: 0 };
}

/**
 * Determine whether a governance rule should be applied to a given cycle.
 *
 * Uses the governance canary cohort selection algorithm to deterministically
 * assign the cycle to "canary" or "control". Canary cycles have new governance
 * rules applied; control cycles use the existing policy baseline.
 *
 * If a governance canary breach is active (status=rolled_back with
 * breachAction=halt_new_assignments), new governance rules are NOT applied
 * to ANY cycle until the breach is cleared (AC4 — rollback behavior).
 *
 * @param {object} config   - full runtime config
 * @param {string} cycleId  - opaque cycle identifier (entropy source for hash-mod)
 * @returns {Promise<{ cohort: "canary"|"control", applyNewRules: boolean, reason: string }>}
 */
export async function shouldApplyGovernanceRule(config, cycleId) {
  if (!cycleId || typeof cycleId !== "string") {
    // AC9: missing input → explicit reason code, default to control (safe)
    return {
      cohort:       COHORT.CONTROL,
      applyNewRules: false,
      reason:       "MISSING_CYCLE_ID:defaulting_to_control"
    };
  }

  // Check if a breach is active — if so, halt new assignments (AC4)
  let breachStatus;
  try {
    breachStatus = await isGovernanceCanaryBreachActive(config);
  } catch {
    // Non-fatal: if the check fails, default to control (safe fallback)
    return {
      cohort:        COHORT.CONTROL,
      applyNewRules: false,
      reason:        "BREACH_CHECK_FAILED:defaulting_to_control"
    };
  }

  if (breachStatus.breachActive) {
    return {
      cohort:        COHORT.CONTROL,
      applyNewRules: false,
      reason:        `BREACH_ACTIVE:${breachStatus.reason || "halt_new_assignments"}`
    };
  }

  const ratio  = config?.canary?.governance?.canaryRatio
    ?? config?.canary?.defaultRatio
    ?? 0.2;
  const cohort = assignCohort(cycleId, ratio);

  return {
    cohort,
    applyNewRules: cohort === COHORT.CANARY,
    reason:        `COHORT_ASSIGNED:${cohort}:algorithm=hash-mod:ratio=${ratio}`
  };
}

// ── Hook governance runtime contract ─────────────────────────────────────────

export const DEFAULT_HOOK_POLICY_PATH = ".github/hooks/box.policy.json";

export interface HookPolicy {
  schemaVersion: string;
  description?: string;
  preToolUse: {
    required: boolean;
    mandatoryFields: string[];
    validImpactValues: string[];
    validClearanceValues: string[];
    impactMinClearance: Record<string, string>;
  };
  hookDecision: {
    required: boolean;
    validDecisions: string[];
    mandatoryFields: string[];
  };
  enforcement: {
    requirePairedEnvelopeDecision: boolean;
    denyOnMissingEnvelope: boolean;
    denyOnMalformedEnvelope: boolean;
    denyOnDeniedDecision: boolean;
    requireEnvelopeBeforeDecision: boolean;
  };
}

/** Minimal telemetry shape accepted by validateHookTelemetryConsistency. */
export interface HookTelemetryInput {
  envelopes: Array<{ scope: string; intent: string; impact: string; clearance: string }>;
  hookDecisions: Array<{ envelopeScope: string; envelopeIntent: string; envelopeImpact: string; envelopeClearance: string }>;
  gaps: string[];
  hasDeterministicCoverage?: boolean;
}

/**
 * Load the preToolUse hook governance policy from .github/hooks/box.policy.json.
 *
 * Returns null when the file is absent or unreadable (fail-open).
 * Callers should log a warning but must not block on missing policy.
 *
 * @param rootDir - repo root directory (defaults to process.cwd())
 */
export async function loadHookPolicy(rootDir?: string): Promise<HookPolicy | null> {
  const root = String(rootDir || process.cwd());
  const policyPath = path.join(root, DEFAULT_HOOK_POLICY_PATH);
  try {
    const data = await readJson(policyPath, null);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data as HookPolicy;
  } catch {
    return null;
  }
}

/**
 * Validate hook telemetry consistency against the runtime policy contract.
 *
 * When the policy's enforcement.requirePairedEnvelopeDecision is true, checks:
 *   - cardinality: every TOOL_INTENT must have a paired HOOK_DECISION
 *   - field echo: each HOOK_DECISION's envelope_* fields must match its TOOL_INTENT
 *
 * @param telemetry - parsed hook telemetry from the worker output
 * @param policy    - loaded hook policy (from loadHookPolicy)
 * @returns { consistent: boolean; gaps: string[] }
 */
export function validateHookTelemetryConsistency(
  telemetry: HookTelemetryInput,
  policy: HookPolicy,
): { consistent: boolean; gaps: string[] } {
  const gaps: string[] = [];

  if (!policy.enforcement.requirePairedEnvelopeDecision) {
    return { consistent: true, gaps };
  }

  const { envelopes, hookDecisions } = telemetry;

  if (envelopes.length === 0 && hookDecisions.length === 0) {
    return { consistent: true, gaps };
  }

  if (envelopes.length !== hookDecisions.length) {
    if (envelopes.length > hookDecisions.length) {
      gaps.push(
        `HOOK_TELEMETRY_UNPAIRED: ${envelopes.length - hookDecisions.length} TOOL_INTENT envelope(s) missing a paired HOOK_DECISION`,
      );
    } else {
      gaps.push(
        `HOOK_TELEMETRY_UNPAIRED: ${hookDecisions.length - envelopes.length} HOOK_DECISION(s) missing a preceding TOOL_INTENT envelope`,
      );
    }
  }

  const pairCount = Math.min(envelopes.length, hookDecisions.length);
  for (let i = 0; i < pairCount; i++) {
    const env = envelopes[i];
    const dec = hookDecisions[i];
    if (dec.envelopeScope !== env.scope) {
      gaps.push(`HOOK_TELEMETRY_MISMATCH[${i}]: envelope_scope="${dec.envelopeScope}" does not match TOOL_INTENT scope="${env.scope}"`);
    }
    if (dec.envelopeIntent !== env.intent) {
      gaps.push(`HOOK_TELEMETRY_MISMATCH[${i}]: envelope_intent="${dec.envelopeIntent}" does not match TOOL_INTENT intent="${env.intent}"`);
    }
    if (dec.envelopeImpact !== env.impact) {
      gaps.push(`HOOK_TELEMETRY_MISMATCH[${i}]: envelope_impact="${dec.envelopeImpact}" does not match TOOL_INTENT impact="${env.impact}"`);
    }
    if (dec.envelopeClearance !== env.clearance) {
      gaps.push(`HOOK_TELEMETRY_MISMATCH[${i}]: envelope_clearance="${dec.envelopeClearance}" does not match TOOL_INTENT clearance="${env.clearance}"`);
    }
  }

  return { consistent: gaps.length === 0, gaps };
}

export interface AuthoritativeHookCoverageAuditInput {
  sessionInputPolicy: "allow_all" | "no_tools" | "auto";
  hookCoverage: "required" | "not_required";
  telemetry: HookTelemetryInput | null | undefined;
  runtimeDecisions: Array<unknown>;
  runtimeAuditGaps?: string[];
}

export interface AuthoritativeHookCoverageAuditResult {
  required: boolean;
  covered: boolean;
  reasonCode: string | null;
  gaps: string[];
  runtimeDecisionCount: number;
  workerDecisionCount: number;
}

function firstHookCoverageReasonCode(gaps: string[]): string | null {
  const firstGap = String(gaps[0] || "");
  if (!firstGap) return null;
  if (firstGap.startsWith("HOOK_TELEMETRY_UNPAIRED")) return "HOOK_COVERAGE_UNPAIRED";
  if (firstGap.startsWith("HOOK_TELEMETRY_MISMATCH")) return "HOOK_COVERAGE_MISMATCH";
  if (firstGap.startsWith("RUNTIME_HOOK_COUNT_MISMATCH")) return "HOOK_COVERAGE_RUNTIME_COUNT_MISMATCH";
  if (firstGap.startsWith("RUNTIME_HOOK_DECISION_MISMATCH")) return "HOOK_COVERAGE_RUNTIME_DECISION_MISMATCH";
  return firstGap.replace(/[^A-Z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toUpperCase() || null;
}

export function auditAuthoritativeHookCoverage(
  input: AuthoritativeHookCoverageAuditInput,
): AuthoritativeHookCoverageAuditResult {
  const required = input.sessionInputPolicy === "allow_all" && input.hookCoverage === "required";
  const telemetry = input.telemetry;
  const runtimeDecisionCount = Array.isArray(input.runtimeDecisions) ? input.runtimeDecisions.length : 0;
  const workerDecisionCount = Array.isArray(telemetry?.hookDecisions) ? telemetry!.hookDecisions.length : 0;
  if (!required) {
    return {
      required: false,
      covered: true,
      reasonCode: null,
      gaps: [],
      runtimeDecisionCount,
      workerDecisionCount,
    };
  }

  const gaps: string[] = [];
  if (!telemetry) {
    gaps.push("HOOK_COVERAGE_TELEMETRY_MISSING");
  } else {
    for (const gap of Array.isArray(telemetry.gaps) ? telemetry.gaps : []) gaps.push(String(gap));
    if (telemetry.hasDeterministicCoverage !== true) {
      gaps.push("HOOK_COVERAGE_NOT_DETERMINISTIC");
    }
  }
  for (const gap of Array.isArray(input.runtimeAuditGaps) ? input.runtimeAuditGaps : []) {
    gaps.push(String(gap));
  }
  if (runtimeDecisionCount === 0) {
    gaps.push("HOOK_COVERAGE_MISSING_RUNTIME_DECISIONS");
  }

  const uniqueGaps = Array.from(new Set(gaps.filter(Boolean)));
  return {
    required,
    covered: uniqueGaps.length === 0,
    reasonCode: firstHookCoverageReasonCode(uniqueGaps),
    gaps: uniqueGaps,
    runtimeDecisionCount,
    workerDecisionCount,
  };
}
