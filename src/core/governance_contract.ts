/**
 * governance_contract.js — Machine-enforced governance policy contract for BOX.
 *
 * Defines who can change what, under which evidence, with which rollback SLA.
 * Versioned and validated at startup. Contract violations hard-block change application.
 *
 * Contract version: 1.0.0
 *
 * Risk classification rules (quantitative, Athena AC2/AC12 resolved):
 *   CRITICAL : riskScore >= CRITICAL_RISK_SCORE_THRESHOLD (0.9)
 *              OR (changeType === "security" AND any filesChanged matches policy.protectedPaths)
 *   HIGH     : riskScore >= HIGH_RISK_SCORE_THRESHOLD (0.7)
 *              OR changeType in HIGH_RISK_CHANGE_TYPE values
 *              OR any filesChanged matches policy.protectedPaths
 *   MEDIUM   : riskScore >= MEDIUM_RISK_SCORE_THRESHOLD (0.4)
 *   LOW      : everything else
 *
 * Dual-approval contract schema (required for HIGH and CRITICAL, Athena AC4/AC13 resolved):
 *   approvals: Array<{ approverRole: string, approvedAt: string, rationale: string }>
 *   MUST have >= DUAL_APPROVAL_MIN_APPROVERS (2) items with >= 2 distinct approverRole values.
 *
 * Approval evidence schema (persisted to state/approval_evidence.jsonl, Athena AC4/AC13 resolved):
 *   Required fields: changeId, changedBy, changedAt, riskLevel, filesChanged, approvals, contractVersion
 *   Format: JSONL — one JSON object per line, append-only.
 *
 * Startup validation failure contract (Athena AC1/AC11 resolved):
 *   - validateGovernanceContract returns { ok, errorCode, message } — never throws
 *   - errorCode values: POLICY_MISSING | POLICY_INVALID | CONTRACT_VERSION_MISMATCH
 *   - Distinguishes missing input from invalid input (Athena AC9 resolved)
 *   - Message format: "[governance] <errorCode>: <detail>"
 *   - Callers MUST exit with GOVERNANCE_STARTUP_EXIT_CODE (1) when ok=false
 *
 * Recovery path for startup failure:
 *   Fall back to static current policy file while governance validator is disabled,
 *   OR fix policy.json governanceContract section and restart.
 *
 * AC5 coverage mapping (Athena AC14 resolved):
 *   validateGovernanceContract  → AC1 startup validation
 *   classifyRiskLevel           → AC2 high-risk classification
 *   validateDualApproval        → AC2 dual-approval conditions
 *   validateApprovalEvidenceSchema → AC4 approval evidence schema
 *   recordApprovalEvidence      → AC4 evidence persistence
 *   enforceGovernance           → AC3 hard-block on violation
 *   GOVERNANCE_CONTRACT_VERSION → AC1 versioned contract
 *   GOVERNANCE_STARTUP_EXIT_CODE → AC1 exit code
 */

import path from "node:path";
import fs from "node:fs/promises";

// ── Contract version ──────────────────────────────────────────────────────────

/** Current governance contract version. Must match policy.governanceContract.version. */
export const GOVERNANCE_CONTRACT_VERSION = "1.0.0";

/**
 * Exit code callers MUST use when governance contract validation fails at startup.
 * Deterministic — enables machine-verifiable test assertions (Athena AC1/AC11 resolved).
 */
export const GOVERNANCE_STARTUP_EXIT_CODE = 1;

// ── Risk level enum ───────────────────────────────────────────────────────────

/**
 * Risk level classification for autonomous changes.
 * HIGH and CRITICAL require dual approval before change application.
 * @enum {string}
 */
export const RISK_LEVEL = Object.freeze({
  CRITICAL: "critical",
  HIGH:     "high",
  MEDIUM:   "medium",
  LOW:      "low"
});

// ── High-risk change type enum ────────────────────────────────────────────────

/**
 * Structural change types that are always classified as HIGH (or CRITICAL) risk.
 * A change with changeType matching any of these values requires dual approval.
 * (Athena AC2/AC12 resolved — explicit structural definition)
 * @enum {string}
 */
export const HIGH_RISK_CHANGE_TYPE = Object.freeze({
  CORE_MODULE: "core_module",
  POLICY:      "policy",
  SECURITY:    "security",
  SCHEMA:      "schema"
});

// ── Quantitative thresholds ───────────────────────────────────────────────────

/**
 * riskScore >= this value → HIGH risk (unless score also qualifies for CRITICAL).
 * Overridable via policy.governanceContract.highRiskScoreThreshold.
 */
export const HIGH_RISK_SCORE_THRESHOLD = 0.7;

/**
 * riskScore >= this value → CRITICAL risk.
 * Overridable via policy.governanceContract.criticalRiskScoreThreshold.
 */
export const CRITICAL_RISK_SCORE_THRESHOLD = 0.9;

/** riskScore >= this value → MEDIUM risk. */
export const MEDIUM_RISK_SCORE_THRESHOLD = 0.4;

/**
 * Minimum number of DISTINCT approverRole values required for dual approval.
 * Each approverRole must be a non-empty distinct string (case-insensitive).
 */
export const DUAL_APPROVAL_MIN_APPROVERS = 2;

// ── Error codes for startup validation ───────────────────────────────────────

/**
 * Machine-readable error codes returned by validateGovernanceContract.
 * Distinguishes missing input from invalid input (Athena AC9 resolved).
 *
 *   POLICY_MISSING            — policy is null/undefined (missing input — no file or null loaded)
 *   POLICY_INVALID            — policy present but governanceContract section missing or invalid (invalid input)
 *   CONTRACT_VERSION_MISMATCH — version field present but does not match GOVERNANCE_CONTRACT_VERSION
 * @enum {string}
 */
export const GOVERNANCE_ERROR_CODE = Object.freeze({
  POLICY_MISSING:            "POLICY_MISSING",
  POLICY_INVALID:            "POLICY_INVALID",
  CONTRACT_VERSION_MISMATCH: "CONTRACT_VERSION_MISMATCH"
});

/**
 * Machine-readable reason codes for agent contract governance violations.
 * Emitted by the governance gate when .github/agents/*.agent.md frontmatter
 * fails schema validation at startup or pre-dispatch time.
 *
 *   AGENT_FILE_MISSING        — the .agent.md file does not exist on disk
 *   AGENT_FRONTMATTER_MISSING — file exists but YAML frontmatter is absent
 *   AGENT_MODEL_MISSING       — frontmatter present but `model` field missing/empty
 *   AGENT_TOOLS_MISSING       — frontmatter present but `tools` array missing/empty
 *   AGENT_DESCRIPTION_MISSING — frontmatter present but `description` field missing/empty
 *   AGENT_SCHEMA_VIOLATION    — other structural schema violation in frontmatter
 * @enum {string}
 */
export const AGENT_CONTRACT_GOVERNANCE_REASON_CODE = Object.freeze({
  AGENT_FILE_MISSING:        "AGENT_FILE_MISSING",
  AGENT_FRONTMATTER_MISSING: "AGENT_FRONTMATTER_MISSING",
  AGENT_MODEL_MISSING:       "AGENT_MODEL_MISSING",
  AGENT_TOOLS_MISSING:       "AGENT_TOOLS_MISSING",
  AGENT_DESCRIPTION_MISSING: "AGENT_DESCRIPTION_MISSING",
  AGENT_SCHEMA_VIOLATION:    "AGENT_SCHEMA_VIOLATION",
});

export const AUTONOMY_EXECUTION_GATE_REASON_CODE = "autonomy_execution_gate_not_ready" as const;

export const GOVERNANCE_DISPATCH_BLOCK_REASON = Object.freeze({
  BUDGET_EXHAUSTED: "budget_exhausted",
  GUARDRAIL_PAUSE_WORKERS_ACTIVE: "guardrail_pause_workers_active",
  GUARDRAIL_FORCE_CHECKPOINT_ACTIVE: "force_checkpoint_validation_active",
  GOVERNANCE_FREEZE_ACTIVE: "governance_freeze_active",
  AUTONOMY_EXECUTION_GATE_NOT_READY: AUTONOMY_EXECUTION_GATE_REASON_CODE,
  LINEAGE_CYCLE_DETECTED: "lineage_cycle_detected",
  GOVERNANCE_CANARY_BREACH: "governance_canary_breach",
  CLOUD_AGENT_GOVERNANCE_POLICY_VIOLATION: "cloud_agent_governance_policy_violation",
  CRITICAL_DEBT_OVERDUE: "critical_debt_overdue",
  MANDATORY_DRIFT_DEBT_UNRESOLVED: "mandatory_drift_debt_unresolved",
  PLAN_EVIDENCE_COUPLING_INVALID: "plan_evidence_coupling_invalid",
  CROSS_CYCLE_PREREQUISITE_UNMET: "cross_cycle_prerequisite_unmet",
  DEPENDENCY_READINESS_INCOMPLETE: "dependency_readiness_incomplete",
  LANE_DIVERSITY_INSUFFICIENT: "lane_diversity_insufficient",
  ROLLING_YIELD_THROTTLE: "rolling_yield_throttle",
  SPECIALIZATION_ADMISSION_GATE: "specialization_admission_gate_failed",
  OVERSIZED_PACKET: "packet_exceeds_actionable_steps_cap",
} as const);

export function resolveAutonomyExecutionGateBlockReason(autonomyBandStatus: unknown): {
  blocked: boolean;
  reasonCode: typeof AUTONOMY_EXECUTION_GATE_REASON_CODE | null;
  reasonDetail: string | null;
  blockReason: string | null;
} {
  if (!autonomyBandStatus || typeof autonomyBandStatus !== "object") {
    return { blocked: false, reasonCode: null, reasonDetail: null, blockReason: null };
  }
  const executionGate = (autonomyBandStatus as Record<string, unknown>).executionGate;
  if (!executionGate || typeof executionGate !== "object") {
    return { blocked: false, reasonCode: null, reasonDetail: null, blockReason: null };
  }
  const exploitationReady = (executionGate as Record<string, unknown>).exploitationReady;
  if (exploitationReady !== false) {
    return { blocked: false, reasonCode: null, reasonDetail: null, blockReason: null };
  }
  const rawReason = String((executionGate as Record<string, unknown>).reason || "").trim().toLowerCase();
  const reasonDetail = rawReason || "execution_gate_not_ready";
  return {
    blocked: true,
    reasonCode: AUTONOMY_EXECUTION_GATE_REASON_CODE,
    reasonDetail,
    blockReason: `${AUTONOMY_EXECUTION_GATE_REASON_CODE}:${reasonDetail}`,
  };
}

export const GOVERNANCE_SIGNAL_REGISTRY = Object.freeze({
  budget_exhausted: {
    gateKey: "BUDGET_ELIGIBILITY",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.BUDGET_EXHAUSTED,
    blocking: true,
  },
  guardrail_pause_workers_active: {
    gateKey: "GUARDRAIL_PAUSE",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.GUARDRAIL_PAUSE_WORKERS_ACTIVE,
    blocking: true,
  },
  force_checkpoint_validation_active: {
    gateKey: "FORCE_CHECKPOINT",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.GUARDRAIL_FORCE_CHECKPOINT_ACTIVE,
    blocking: true,
  },
  autonomy_execution_gate_not_ready: {
    gateKey: "AUTONOMY_EXECUTION",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.AUTONOMY_EXECUTION_GATE_NOT_READY,
    blocking: true,
  },
  governance_freeze_active: {
    gateKey: "GOVERNANCE_FREEZE",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE,
    blocking: true,
  },
  cloud_agent_governance_policy_violation: {
    gateKey: "CLOUD_AGENT_GOVERNANCE",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.CLOUD_AGENT_GOVERNANCE_POLICY_VIOLATION,
    blocking: true,
  },
  lineage_cycle_detected: {
    gateKey: "LINEAGE_CYCLE",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.LINEAGE_CYCLE_DETECTED,
    blocking: true,
  },
  governance_canary_breach: {
    gateKey: "GOVERNANCE_CANARY",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.GOVERNANCE_CANARY_BREACH,
    blocking: true,
  },
  critical_debt_overdue: {
    gateKey: "CARRY_FORWARD_DEBT",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.CRITICAL_DEBT_OVERDUE,
    blocking: true,
  },
  mandatory_drift_debt_unresolved: {
    gateKey: "MANDATORY_DRIFT_DEBT",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED,
    blocking: true,
  },
  plan_evidence_coupling_invalid: {
    gateKey: "PLAN_EVIDENCE_COUPLING",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID,
    blocking: true,
  },
  cross_cycle_prerequisite_unmet: {
    gateKey: "CROSS_CYCLE_PREREQUISITE",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.CROSS_CYCLE_PREREQUISITE_UNMET,
    blocking: true,
  },
  dependency_readiness_incomplete: {
    gateKey: "DEPENDENCY_READINESS",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.DEPENDENCY_READINESS_INCOMPLETE,
    blocking: true,
  },
  lane_diversity_gate_blocked: {
    gateKey: "LANE_DIVERSITY",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.LANE_DIVERSITY_INSUFFICIENT,
    blocking: true,
  },
  lane_diversity_insufficient: {
    gateKey: "LANE_DIVERSITY",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.LANE_DIVERSITY_INSUFFICIENT,
    blocking: true,
  },
  rolling_yield_throttle: {
    gateKey: "ROLLING_COMPLETION_YIELD",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.ROLLING_YIELD_THROTTLE,
    blocking: true,
  },
  specialization_admission_gate_failed: {
    gateKey: "SPECIALIZATION_ADMISSION",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.SPECIALIZATION_ADMISSION_GATE,
    blocking: true,
  },
  packet_exceeds_actionable_steps_cap: {
    gateKey: "OVERSIZED_PACKET",
    dispatchBlockReason: GOVERNANCE_DISPATCH_BLOCK_REASON.OVERSIZED_PACKET,
    blocking: true,
  },
} as const);

// ── Approval evidence schema ──────────────────────────────────────────────────

/**
 * Required fields for a persisted approval evidence record (Athena AC4/AC13 resolved).
 *
 * Storage location : state/approval_evidence.jsonl
 * Format           : JSONL — one JSON object per line, append-only
 *
 * Field semantics:
 *   changeId        — string — unique change identifier (e.g. UUID or content hash)
 *   changedBy       — string — identity of agent/user applying the change
 *   changedAt       — string — ISO 8601 timestamp of change application
 *   riskLevel       — string — RISK_LEVEL enum value (critical|high|medium|low)
 *   filesChanged    — string[] — list of file/config paths modified
 *   approvals       — Array<{ approverRole, approvedAt, rationale }> — approval chain
 *   contractVersion — string — GOVERNANCE_CONTRACT_VERSION at time of change
 */
export const APPROVAL_EVIDENCE_REQUIRED_FIELDS = Object.freeze([
  "changeId",
  "changedBy",
  "changedAt",
  "riskLevel",
  "filesChanged",
  "approvals",
  "contractVersion"
]);

/**
 * Required fields on each approval object within an approval evidence record.
 *   approverRole — string — role identifier of the approver (must be distinct across approvals)
 *   approvedAt   — string — ISO 8601 timestamp of this approval
 *   rationale    — string — human/machine-readable reason for approval
 */
export const APPROVAL_EVIDENCE_APPROVAL_REQUIRED_FIELDS = Object.freeze([
  "approverRole",
  "approvedAt",
  "rationale"
]);

/** Risk level enum values array — used for schema enum validation. */
export const RISK_LEVEL_ENUM = Object.freeze(Object.values(RISK_LEVEL));

/** High-risk change type enum values array — used for risk classification. */
export const HIGH_RISK_CHANGE_TYPE_ENUM = Object.freeze(Object.values(HIGH_RISK_CHANGE_TYPE));

/** Default JSONL file path for approval evidence (relative to cwd when no config supplied). */
export const DEFAULT_APPROVAL_EVIDENCE_PATH = "state/approval_evidence.jsonl";

// ── GovernanceContractError ───────────────────────────────────────────────────

/**
 * Error thrown by loadPolicyWithGovernance when governance contract validation fails.
 *
 * Message format : "[governance] <errorCode>: <detail>"
 * errorCode      : one of GOVERNANCE_ERROR_CODE values
 * exitCode       : GOVERNANCE_STARTUP_EXIT_CODE (1)
 *
 * Callers that catch this error SHOULD call process.exit(err.exitCode) after logging.
 */
export class GovernanceContractError extends Error {
  errorCode: any;
  exitCode: any;
  constructor(errorCode, detail) {
    super(`[governance] ${errorCode}: ${detail}`);
    this.name = "GovernanceContractError";
    this.errorCode = errorCode;
    this.exitCode = GOVERNANCE_STARTUP_EXIT_CODE;
  }
}

// ── Contract validation ───────────────────────────────────────────────────────

/**
 * Validate the governance contract embedded in a loaded policy.
 *
 * Returns a deterministic result object — NEVER throws.
 *
 * Result contract:
 *   { ok: true,  errorCode: null,    message: null }    — valid contract
 *   { ok: false, errorCode: string,  message: string }  — invalid (log + exit)
 *
 * Distinguishes:
 *   POLICY_MISSING            — policy is null/undefined
 *   POLICY_INVALID            — governanceContract section absent or structurally invalid
 *   CONTRACT_VERSION_MISMATCH — version present but does not match GOVERNANCE_CONTRACT_VERSION
 *
 * Recovery path: fix policy.json governanceContract section and restart; or fall back
 *   to static policy with governance disabled (set governanceContract.disabled=true).
 *
 * @param {object|null|undefined} policy
 * @returns {{ ok: boolean, errorCode: string|null, message: string|null }}
 */
export function validateGovernanceContract(policy) {
  if (policy === null || policy === undefined) {
    return {
      ok: false,
      errorCode: GOVERNANCE_ERROR_CODE.POLICY_MISSING,
      message: `[governance] ${GOVERNANCE_ERROR_CODE.POLICY_MISSING}: policy is null or undefined`
    };
  }

  const gc = policy.governanceContract;

  if (!gc || typeof gc !== "object") {
    return {
      ok: false,
      errorCode: GOVERNANCE_ERROR_CODE.POLICY_INVALID,
      message: `[governance] ${GOVERNANCE_ERROR_CODE.POLICY_INVALID}: policy.governanceContract section is missing or not an object`
    };
  }

  // version: required, must be non-empty string
  if (typeof gc.version !== "string" || !gc.version.trim()) {
    return {
      ok: false,
      errorCode: GOVERNANCE_ERROR_CODE.POLICY_INVALID,
      message: `[governance] ${GOVERNANCE_ERROR_CODE.POLICY_INVALID}: policy.governanceContract.version must be a non-empty string`
    };
  }

  // version mismatch — separate error code from INVALID
  if (gc.version !== GOVERNANCE_CONTRACT_VERSION) {
    return {
      ok: false,
      errorCode: GOVERNANCE_ERROR_CODE.CONTRACT_VERSION_MISMATCH,
      message: `[governance] ${GOVERNANCE_ERROR_CODE.CONTRACT_VERSION_MISMATCH}: expected ${GOVERNANCE_CONTRACT_VERSION}, got ${gc.version}`
    };
  }

  // highRiskScoreThreshold: required, number in [0, 1]
  if (
    typeof gc.highRiskScoreThreshold !== "number" ||
    gc.highRiskScoreThreshold < 0 ||
    gc.highRiskScoreThreshold > 1
  ) {
    return {
      ok: false,
      errorCode: GOVERNANCE_ERROR_CODE.POLICY_INVALID,
      message: `[governance] ${GOVERNANCE_ERROR_CODE.POLICY_INVALID}: policy.governanceContract.highRiskScoreThreshold must be a number in [0, 1]`
    };
  }

  // approvedApproverRoles: required, non-empty array
  if (!Array.isArray(gc.approvedApproverRoles) || gc.approvedApproverRoles.length === 0) {
    return {
      ok: false,
      errorCode: GOVERNANCE_ERROR_CODE.POLICY_INVALID,
      message: `[governance] ${GOVERNANCE_ERROR_CODE.POLICY_INVALID}: policy.governanceContract.approvedApproverRoles must be a non-empty array`
    };
  }

  return { ok: true, errorCode: null, message: null };
}

// ── Risk classification ───────────────────────────────────────────────────────

/**
 * Classify the risk level of a proposed autonomous change.
 *
 * Classification rules (quantitative and structural, Athena AC2/AC12 resolved):
 *
 *   CRITICAL : change.riskScore >= criticalRiskScoreThreshold (default 0.9)
 *              OR (changeType === "security" AND any filesChanged matches policy.protectedPaths)
 *
 *   HIGH     : change.riskScore >= highRiskScoreThreshold (default 0.7)
 *              OR change.changeType in HIGH_RISK_CHANGE_TYPE values
 *              OR any of change.filesChanged matches policy.protectedPaths
 *
 *   MEDIUM   : change.riskScore >= MEDIUM_RISK_SCORE_THRESHOLD (0.4)
 *
 *   LOW      : everything else
 *
 * Note: CRITICAL supersedes HIGH. Thresholds are read from policy.governanceContract when present.
 *
 * @param {{ riskScore?: number, changeType?: string, filesChanged?: string[] }} change
 * @param {object} policy — loaded policy with optional protectedPaths and governanceContract
 * @returns {string} one of RISK_LEVEL values
 */
export function classifyRiskLevel(change, policy) {
  const riskScore   = typeof change?.riskScore === "number" ? change.riskScore : 0;
  const changeType  = String(change?.changeType || "").toLowerCase().trim();
  const filesChanged = Array.isArray(change?.filesChanged) ? change.filesChanged : [];

  const gc = policy?.governanceContract;

  const highThreshold = (typeof gc?.highRiskScoreThreshold === "number" && gc.highRiskScoreThreshold >= 0)
    ? gc.highRiskScoreThreshold
    : HIGH_RISK_SCORE_THRESHOLD;

  const criticalThreshold = (typeof gc?.criticalRiskScoreThreshold === "number" && gc.criticalRiskScoreThreshold >= 0)
    ? gc.criticalRiskScoreThreshold
    : CRITICAL_RISK_SCORE_THRESHOLD;

  const protectedPaths = Array.isArray(policy?.protectedPaths) ? policy.protectedPaths : [];

  const touchesProtectedPath = protectedPaths.length > 0 && filesChanged.some(f =>
    protectedPaths.some(p => _matchPathPattern(f, p))
  );

  // CRITICAL: score >= 0.9 OR (security change AND touches protected path)
  const isCritical = riskScore >= criticalThreshold ||
    (changeType === HIGH_RISK_CHANGE_TYPE.SECURITY && touchesProtectedPath);

  if (isCritical) return RISK_LEVEL.CRITICAL;

  // HIGH: score >= 0.7 OR high-risk change type OR touches protected path
  const highRiskTypes = Array.isArray(gc?.highRiskChangeTypes)
    ? gc.highRiskChangeTypes.map(t => String(t).toLowerCase())
    : HIGH_RISK_CHANGE_TYPE_ENUM;

  const isHigh = riskScore >= highThreshold ||
    highRiskTypes.includes(changeType) ||
    touchesProtectedPath;

  if (isHigh) return RISK_LEVEL.HIGH;

  // MEDIUM: score >= 0.4
  if (riskScore >= MEDIUM_RISK_SCORE_THRESHOLD) return RISK_LEVEL.MEDIUM;

  return RISK_LEVEL.LOW;
}

// ── Dual approval validation ──────────────────────────────────────────────────

/**
 * Validate dual approval requirements for a high-risk or critical change.
 *
 * Dual approval contract (Athena AC2/AC12 resolved — explicit field schema):
 *   approvalEvidence.approvals must be an array with:
 *     - >= DUAL_APPROVAL_MIN_APPROVERS (2) elements
 *     - >= 2 distinct approverRole values (case-insensitive)
 *     - each element satisfying APPROVAL_EVIDENCE_APPROVAL_REQUIRED_FIELDS
 *
 * Returns { ok, reason } — NEVER throws.
 * reason is a machine-readable code + detail string on failure:
 *   APPROVALS_MISSING          — approvals field is not an array
 *   INSUFFICIENT_APPROVERS     — fewer than DUAL_APPROVAL_MIN_APPROVERS entries
 *   APPROVAL_SCHEMA_INVALID    — an approval entry is missing a required field
 *   INSUFFICIENT_DISTINCT_ROLES — fewer than 2 distinct approverRole values
 *
 * @param {object} approvalEvidence
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function validateDualApproval(approvalEvidence) {
  const approvals = approvalEvidence?.approvals;

  if (!Array.isArray(approvals)) {
    return { ok: false, reason: "APPROVALS_MISSING: approvals field must be an array" };
  }

  if (approvals.length < DUAL_APPROVAL_MIN_APPROVERS) {
    return {
      ok: false,
      reason: `INSUFFICIENT_APPROVERS: requires >= ${DUAL_APPROVAL_MIN_APPROVERS} approvals, got ${approvals.length}`
    };
  }

  // Validate each approval entry has all required fields as non-empty strings
  for (let i = 0; i < approvals.length; i++) {
    const a = approvals[i];
    for (const field of APPROVAL_EVIDENCE_APPROVAL_REQUIRED_FIELDS) {
      if (!a || typeof a[field] !== "string" || !a[field].trim()) {
        return {
          ok: false,
          reason: `APPROVAL_SCHEMA_INVALID: approvals[${i}].${field} must be a non-empty string`
        };
      }
    }
  }

  // Require >= 2 distinct approverRole values (case-insensitive)
  const distinctRoles = new Set(
    approvals
      .map(a => String(a.approverRole || "").trim().toLowerCase())
      .filter(r => r.length > 0)
  );

  if (distinctRoles.size < DUAL_APPROVAL_MIN_APPROVERS) {
    return {
      ok: false,
      reason: `INSUFFICIENT_DISTINCT_ROLES: requires >= ${DUAL_APPROVAL_MIN_APPROVERS} distinct approverRole values, got ${distinctRoles.size}`
    };
  }

  return { ok: true, reason: null };
}

// ── Approval evidence schema validation ───────────────────────────────────────

/**
 * Validate an approval evidence object against the persisted schema (Athena AC8 resolved).
 *
 * Checks:
 *   - All APPROVAL_EVIDENCE_REQUIRED_FIELDS are present (not null/undefined)
 *   - riskLevel is a valid RISK_LEVEL enum value
 *   - filesChanged is an array
 *   - approvals is an array
 *
 * Returns { ok, missingFields, invalidFields } — NEVER throws.
 * Distinguishes missing fields from invalid field values (Athena AC9 resolved).
 *
 * @param {unknown} evidence
 * @returns {{ ok: boolean, missingFields: string[], invalidFields: string[] }}
 */
export function validateApprovalEvidenceSchema(evidence) {
  if (!evidence || typeof evidence !== "object") {
    return {
      ok: false,
      missingFields: [...APPROVAL_EVIDENCE_REQUIRED_FIELDS],
      invalidFields: []
    };
  }

  const missingFields = APPROVAL_EVIDENCE_REQUIRED_FIELDS.filter(
    field => evidence[field] === null || evidence[field] === undefined
  );

  const invalidFields = [];

  if (!missingFields.includes("riskLevel") && !RISK_LEVEL_ENUM.includes(evidence.riskLevel)) {
    invalidFields.push(
      `riskLevel: expected one of ${RISK_LEVEL_ENUM.join("|")}, got ${JSON.stringify(evidence.riskLevel)}`
    );
  }

  if (!missingFields.includes("filesChanged") && !Array.isArray(evidence.filesChanged)) {
    invalidFields.push("filesChanged: must be an array");
  }

  if (!missingFields.includes("approvals") && !Array.isArray(evidence.approvals)) {
    invalidFields.push("approvals: must be an array");
  }

  return {
    ok: missingFields.length === 0 && invalidFields.length === 0,
    missingFields,
    invalidFields
  };
}

// ── Approval evidence recording ───────────────────────────────────────────────

/**
 * Record approval evidence to the append-only JSONL audit log (Athena AC4/AC13 resolved).
 *
 * Storage : state/approval_evidence.jsonl (default)
 *           OR config.governanceContract.approvalEvidencePath (override)
 * Format  : JSONL — one JSON object per line, append-only
 * Schema  : APPROVAL_EVIDENCE_REQUIRED_FIELDS (all required)
 *
 * Returns { ok, reason } — NEVER throws.
 * reason codes on failure:
 *   SCHEMA_INVALID — evidence fails schema validation (missing/invalid fields)
 *   IO_ERROR       — filesystem write failed
 *
 * @param {object} evidence — must satisfy APPROVAL_EVIDENCE_REQUIRED_FIELDS schema
 * @param {object} [config] — box config (optional; uses DEFAULT_APPROVAL_EVIDENCE_PATH if absent)
 * @returns {Promise<{ ok: boolean, reason: string|null }>}
 */
export async function recordApprovalEvidence(evidence, config) {
  const schemaResult = validateApprovalEvidenceSchema(evidence);
  if (!schemaResult.ok) {
    return {
      ok: false,
      reason: `SCHEMA_INVALID: missing=[${schemaResult.missingFields.join(",")}] invalid=[${schemaResult.invalidFields.join(",")}]`
    };
  }

  const stateDir = config?.paths?.stateDir || "state";
  const evidencePath = config?.governanceContract?.approvalEvidencePath
    || path.join(stateDir, "approval_evidence.jsonl");

  try {
    await fs.mkdir(path.dirname(path.resolve(evidencePath)), { recursive: true });
    await fs.appendFile(evidencePath, JSON.stringify(evidence) + "\n", "utf8");
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `IO_ERROR: ${String(err?.message || err)}` };
  }
}

// ── Change enforcement gate ───────────────────────────────────────────────────

/**
 * Enforce the governance contract for a proposed autonomous change (Athena AC3 resolved).
 *
 * This is the single enforcement gate — all autonomous change application MUST call this.
 *
 * Enforcement rules:
 *   HIGH or CRITICAL risk → validateDualApproval(approvalEvidence) must pass
 *   MEDIUM or LOW risk    → no approval required (evidence still recorded by caller)
 *   Contract violation    → hard-block (ok=false, blocked=true) — NO silent fallback
 *
 * Returns: { ok, blocked, blockReason, riskLevel }
 *   ok=true   — change is permitted
 *   ok=false  — change is hard-blocked; blockReason is a machine-readable reason code
 *
 * @param {{ riskScore?: number, changeType?: string, filesChanged?: string[] }} change
 * @param {object} approvalEvidence — approval evidence to validate for high-risk changes
 * @param {object} policy           — loaded policy
 * @returns {{ ok: boolean, blocked: boolean, blockReason: string|null, riskLevel: string }}
 */
export function enforceGovernance(change, approvalEvidence, policy) {
  const riskLevel = classifyRiskLevel(change, policy);

  if (riskLevel === RISK_LEVEL.HIGH || riskLevel === RISK_LEVEL.CRITICAL) {
    const dualApprovalResult = validateDualApproval(approvalEvidence);
    if (!dualApprovalResult.ok) {
      return {
        ok: false,
        blocked: true,
        blockReason: `DUAL_APPROVAL_REQUIRED: ${dualApprovalResult.reason}`,
        riskLevel
      };
    }
  }

  return {
    ok: true,
    blocked: false,
    blockReason: null,
    riskLevel
  };
}

// ── Internal path matching helper ─────────────────────────────────────────────
// Mirrors the logic in policy_engine.js to avoid a circular dependency.

function _normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function _matchPathPattern(targetPath, pattern) {
  const pathNorm    = _normalizePath(targetPath);
  const patternNorm = _normalizePath(pattern);
  if (!pathNorm || !patternNorm) return false;

  if (patternNorm.endsWith("/**")) {
    const prefix = patternNorm.slice(0, -3);
    return pathNorm === prefix || pathNorm.startsWith(`${prefix}/`);
  }

  if (patternNorm.startsWith("**/")) {
    const suffix = patternNorm.slice(3);
    const reStr  = suffix
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*");
    return new RegExp(`(^|/)${reStr}$`).test(pathNorm);
  }

  return pathNorm === patternNorm;
}
