/**
 * evidence_envelope.ts — Shared evidence contract between evolution executor
 * and Athena postmortem reviewer.
 *
 * Keeping these types in a standalone module avoids the circular import that
 * would result from evolution_executor.ts ↔ athena_reviewer.ts cross-importing.
 */

import type {
  AthenaReviewFindingArtifact,
  JanusStrategyBriefArtifact,
  PrometheusPlanArtifact,
} from "./plan_lifecycle_contract.js";
import { getPrometheusPlanArtifact } from "./plan_lifecycle_contract.js";
import {
  normalizeInterventionLineageContract,
  resolveInterventionLineageJoinKey,
  type InterventionLineageContract,
} from "./state_tracker.js";

// ── Verification evidence ──────────────────────────────────────────────────────

/**
 * Slot-level pass/fail evidence derived from local verification command results.
 * "n/a" means the corresponding check was not exercised in this run.
 */
export type VerificationEvidence = {
  build: "pass" | "fail" | "n/a";
  tests: "pass" | "fail" | "n/a";
  lint:  "pass" | "fail" | "n/a";
};

// ── PR checks snapshot ────────────────────────────────────────────────────────

export type PrChecksSnapshot = {
  ok: boolean;
  passed: boolean;
  failed: string[];
  pending: string[];
  total: number;
  error?: string;
};

export type DispatchReplayClosureSnapshot = {
  contractSatisfied?: boolean;
  canonicalCommands?: string[];
  executedCommands?: string[];
  rawArtifactEvidenceLinks?: string[];
};

export type DispatchContractSnapshot = {
  doneWorkerWithVerificationReportEvidence?: boolean;
  doneWorkerWithCleanTreeStatusEvidence?: boolean;
  dispatchBlockReason?: string | null;
  closureBoundaryViolation?: boolean;
  replayClosure?: DispatchReplayClosureSnapshot;
};

export type WorkerExecutionReportArtifact = {
  schemaVersion: 1;
  source: "worker_execution_report";
  roleName: string;
  status: string;
  summary: string;
  prUrl: string | null;
  filesTouched: string[];
  verificationPassed: boolean | null;
  verificationEvidence: VerificationEvidence;
  preReviewAssessment: string | null;
  preReviewIssues: string[];
  dispatchBlockReason: string | null;
  lineage: InterventionLineageContract | null;
  lineageJoinKey: string | null;
  emittedAt: string;
};

// ── Canonical evidence envelope ───────────────────────────────────────────────

/**
 * Canonical evidence envelope passed from the evolution executor to Athena's
 * postmortem reviewer.
 *
 * All fields that Athena reads must be declared here.  Adding ad-hoc fields on
 * the caller side is unsafe because Athena's deterministic fast-path gate reads
 * specific keys to decide whether to skip the premium AI call.
 *
 * Fast-path gate conditions (in runAthenaPostmortem):
 *   status === "done"
 *   && verificationPassed === true
 *   && verificationEvidence.build === "pass"
 *   && verificationEvidence.tests === "pass"
 */
export type EvidenceEnvelope = {
  /** Slug name of the worker role (e.g. "evolution-worker"). */
  roleName: string;
  /** BOX_STATUS emitted by the worker: "done" | "partial" | "blocked" | "error". */
  status: string;
  /** PR URL if the worker opened or updated a pull request. */
  prUrl?: string;
  /** Human-readable worker summary, may include a serialised VERIFICATION_REPORT. */
  summary: string;
  /** Files modified by the worker (BOX_FILES_TOUCHED). */
  filesTouched?: string[] | string;
  /** Concatenated stdout of local verification commands (human-readable). */
  verificationOutput?: string;
  /** True iff every non-blocked verification command exited 0. */
  verificationPassed?: boolean;
  /**
   * Slot-level evidence — required for Athena deterministic fast-path.
   * Must be populated by buildVerificationEvidence() before being passed to Athena.
   */
  verificationEvidence: VerificationEvidence;
  /** Remote CI check results read after the worker created/updated its PR. */
  prChecks?: PrChecksSnapshot;
  /** Athena pre-review summary given to the worker before execution. */
  preReviewAssessment?: string | null;
  /** Issues Athena flagged in the pre-review that the worker was asked to address. */
  preReviewIssues?: string[];
  /** Worker runner verification contract used by lifecycle admission gates. */
  dispatchContract?: DispatchContractSnapshot;
  /** Normalized runtime lineage contract shared across checkpoints, routing, and analytics. */
  lineage?: InterventionLineageContract | null;
  /** Deterministic join key derived from the runtime lineage contract. */
  lineageJoinKey?: string | null;
  /** Optional typed leadership artifact emitted by Janus. */
  strategyBrief?: JanusStrategyBriefArtifact | null;
  /** Optional typed plan artifact emitted by Prometheus. */
  planArtifact?: PrometheusPlanArtifact | null;
  /** Optional typed review findings emitted by Athena plan review. */
  reviewArtifact?: AthenaReviewFindingArtifact | null;
  /** Canonical worker execution report consumed by Athena postmortem. */
  executionReport?: WorkerExecutionReportArtifact | null;
};

// ── Envelope structure validation ─────────────────────────────────────────────

const VALID_EVIDENCE_VALUES = new Set(["pass", "fail", "n/a"]);

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function validateNestedVerificationEvidence(
  evidence: unknown,
  fieldPrefix: string,
): string[] {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return [`${fieldPrefix} must be a non-null object`];
  }
  const errors: string[] = [];
  const slots = evidence as Record<string, unknown>;
  for (const slot of ["build", "tests", "lint"] as const) {
    if (!VALID_EVIDENCE_VALUES.has(slots[slot] as string)) {
      errors.push(`${fieldPrefix}.${slot} must be "pass", "fail", or "n/a"; got ${JSON.stringify(slots[slot])}`);
    }
  }
  return errors;
}

function hasMeaningfulLineageContract(lineage: InterventionLineageContract): boolean {
  return Object.entries(lineage).some(([key, value]) => key !== "schemaVersion" && value !== null);
}

function normalizeLineageJoinTaskKind(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function resolveEnvelopeLineageJoinKey(
  lineage: InterventionLineageContract,
  opts: { explicitJoinKey?: unknown; taskKind?: unknown; role?: unknown } = {},
): string | null {
  const explicitJoinKey = String(opts.explicitJoinKey || "").trim();
  const taskKind = normalizeLineageJoinTaskKind(opts.taskKind ?? lineage.taskKind);
  const role = String(opts.role ?? lineage.role ?? "").trim().toLowerCase();
  const prefersPromptFamily = Boolean(
    lineage.promptFamilyKey
    && (
      taskKind === "planning"
      || taskKind === "plan-review"
      || taskKind === "review"
      || taskKind === "analysis"
      || role === "prometheus"
      || role === "athena"
      || role === "janus"
    ),
  );
  const derivedJoinKey = prefersPromptFamily
    ? `prompt-family:${lineage.promptFamilyKey}`
    : resolveInterventionLineageJoinKey(lineage)
      || (lineage.promptFamilyKey ? `prompt-family:${lineage.promptFamilyKey}` : null);
  if (explicitJoinKey && (!derivedJoinKey || explicitJoinKey === derivedJoinKey)) {
    return explicitJoinKey;
  }
  return derivedJoinKey ?? (explicitJoinKey || null);
}

function normalizeEnvelopeLineage(
  envelope: Partial<EvidenceEnvelope> & Record<string, unknown>,
): { lineage: InterventionLineageContract | null; lineageJoinKey: string | null } {
  const lineage = normalizeInterventionLineageContract(
    envelope.lineage && typeof envelope.lineage === "object"
      ? envelope.lineage
      : envelope.lineageContract && typeof envelope.lineageContract === "object"
        ? envelope.lineageContract
        : envelope,
    {
      taskId: typeof envelope.taskId === "string" ? envelope.taskId : null,
      taskKind: typeof envelope.taskKind === "string" ? envelope.taskKind : null,
      role: typeof envelope.roleName === "string" ? envelope.roleName : null,
    },
  );
  if (!hasMeaningfulLineageContract(lineage)) {
    return { lineage: null, lineageJoinKey: null };
  }
  return {
    lineage,
    lineageJoinKey: resolveEnvelopeLineageJoinKey(lineage, {
      explicitJoinKey: envelope.lineageJoinKey,
      taskKind: envelope.taskKind,
      role: envelope.roleName,
    }),
  };
}

function validateLineageSnapshot(
  value: unknown,
  joinKeyValue: unknown,
  fieldPrefix: string,
  opts: { taskKind?: unknown; role?: unknown } = {},
): string[] {
  if (value == null && joinKeyValue == null) return [];
  if (value == null && joinKeyValue != null) {
    return [`${fieldPrefix} must be a non-null object when ${fieldPrefix}JoinKey is provided`];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${fieldPrefix} must be a non-null object`];
  }
  const normalized = normalizeInterventionLineageContract(value);
  if (!hasMeaningfulLineageContract(normalized)) {
    return [`${fieldPrefix} must include at least one non-null lineage field`];
  }
  const derivedJoinKey = resolveEnvelopeLineageJoinKey(normalized, {
    taskKind: opts.taskKind,
    role: opts.role,
  });
  if (joinKeyValue != null) {
    const normalizedJoinKey = String(joinKeyValue).trim();
    if (!normalizedJoinKey) {
      return [`${fieldPrefix}JoinKey must be a non-empty string when provided`];
    }
    if (derivedJoinKey && normalizedJoinKey !== derivedJoinKey) {
      return [`${fieldPrefix}JoinKey must match the normalized ${fieldPrefix} contract`];
    }
  }
  return [];
}

function validatePlanArtifact(planArtifact: unknown): string[] {
  if (!planArtifact || typeof planArtifact !== "object" || Array.isArray(planArtifact)) {
    return ["planArtifact must be a non-null object"];
  }
  const artifact = planArtifact as Record<string, unknown>;
  const errors: string[] = [];
  if (artifact.source !== "prometheus_plan") {
    errors.push(`planArtifact.source must be "prometheus_plan"; got ${JSON.stringify(artifact.source)}`);
  }
  if (typeof artifact.task !== "string" || artifact.task.trim() === "") {
    errors.push("planArtifact.task must be a non-empty string");
  }
  if (typeof artifact.taskIdentity !== "string" || artifact.taskIdentity.trim() === "") {
    errors.push("planArtifact.taskIdentity must be a non-empty string");
  }
  if (!Array.isArray(artifact.targetFiles)) {
    errors.push("planArtifact.targetFiles must be an array");
  }
  return errors;
}

function validateReviewArtifact(reviewArtifact: unknown): string[] {
  if (!reviewArtifact || typeof reviewArtifact !== "object" || Array.isArray(reviewArtifact)) {
    return ["reviewArtifact must be a non-null object"];
  }
  const artifact = reviewArtifact as Record<string, unknown>;
  const errors: string[] = [];
  if (artifact.source !== "athena_review_findings") {
    errors.push(`reviewArtifact.source must be "athena_review_findings"; got ${JSON.stringify(artifact.source)}`);
  }
  if (typeof artifact.approved !== "boolean") {
    errors.push("reviewArtifact.approved must be a boolean");
  }
  if (!Array.isArray(artifact.findings)) {
    errors.push("reviewArtifact.findings must be an array");
  }
  return errors;
}

function validateExecutionReportArtifact(executionReport: unknown): string[] {
  if (!executionReport || typeof executionReport !== "object" || Array.isArray(executionReport)) {
    return ["executionReport must be a non-null object"];
  }
  const report = executionReport as Record<string, unknown>;
  const errors: string[] = [];
  if (report.source !== "worker_execution_report") {
    errors.push(`executionReport.source must be "worker_execution_report"; got ${JSON.stringify(report.source)}`);
  }
  if (typeof report.roleName !== "string" || report.roleName.trim() === "") {
    errors.push("executionReport.roleName must be a non-empty string");
  }
  if (typeof report.status !== "string" || report.status.trim() === "") {
    errors.push("executionReport.status must be a non-empty string");
  }
  if (typeof report.summary !== "string" || report.summary.trim() === "") {
    errors.push("executionReport.summary must be a non-empty string");
  }
  if (!Array.isArray(report.filesTouched)) {
    errors.push("executionReport.filesTouched must be an array");
  }
  errors.push(...validateNestedVerificationEvidence(report.verificationEvidence, "executionReport.verificationEvidence"));
  errors.push(...validateLineageSnapshot(report.lineage, report.lineageJoinKey, "executionReport.lineage", {
    role: report.roleName,
  }));
  return errors;
}

export function buildWorkerExecutionReportArtifact(
  envelope: Partial<EvidenceEnvelope> & Record<string, unknown>,
  opts: { emittedAt?: string } = {},
): WorkerExecutionReportArtifact {
  const verificationEvidence: VerificationEvidence = envelope.verificationEvidence && typeof envelope.verificationEvidence === "object"
    ? envelope.verificationEvidence as VerificationEvidence
    : { build: "n/a", tests: "n/a", lint: "n/a" };
  const dispatchContract = envelope.dispatchContract && typeof envelope.dispatchContract === "object"
    ? envelope.dispatchContract as DispatchContractSnapshot
    : {};
  const { lineage, lineageJoinKey } = normalizeEnvelopeLineage(envelope);
  return {
    schemaVersion: 1,
    source: "worker_execution_report",
    roleName: String(envelope.roleName || "").trim(),
    status: String(envelope.status || "").trim(),
    summary: String(envelope.summary || "").trim(),
    prUrl: typeof envelope.prUrl === "string" && envelope.prUrl.trim() ? envelope.prUrl.trim() : null,
    filesTouched: normalizeStringList(envelope.filesTouched),
    verificationPassed: typeof envelope.verificationPassed === "boolean" ? envelope.verificationPassed : null,
    verificationEvidence,
    preReviewAssessment: typeof envelope.preReviewAssessment === "string" && envelope.preReviewAssessment.trim()
      ? envelope.preReviewAssessment.trim()
      : null,
    preReviewIssues: normalizeStringList(envelope.preReviewIssues),
    dispatchBlockReason: typeof dispatchContract.dispatchBlockReason === "string" && dispatchContract.dispatchBlockReason.trim()
      ? dispatchContract.dispatchBlockReason.trim()
      : null,
    lineage,
    lineageJoinKey,
    emittedAt: String(opts.emittedAt || new Date().toISOString()),
  };
}

export function resolvePlanArtifactFromEnvelope(
  envelope: Partial<EvidenceEnvelope> & Record<string, unknown>,
): PrometheusPlanArtifact | null {
  if (envelope.planArtifact) {
    return getPrometheusPlanArtifact({ planArtifact: envelope.planArtifact });
  }
  return null;
}

/**
 * Known template placeholder literals that constitute unfilled post-merge artifact residue.
 * Any of these appearing in envelope string fields indicate the worker did not
 * replace the output template with real content.
 *
 * These must stay in sync with the constants exported from verification_gate.ts.
 * They are intentionally duplicated here (rather than imported) to avoid a
 * circular dependency: evidence_envelope ← verification_gate would form a cycle
 * because verification_gate already imports from evidence_envelope indirectly.
 */
const ENVELOPE_PLACEHOLDER_RESIDUES: readonly string[] = Object.freeze([
  "POST_MERGE_TEST_OUTPUT",
  "<paste git rev-parse HEAD here>",
  "<paste full raw npm test stdout here>",
]);

/**
 * Determine whether a string field in the envelope contains unfilled template
 * placeholder residue that must be rejected before the envelope reaches Athena.
 *
 * @param value — string value of an envelope field
 * @returns true when the value contains a known unfilled placeholder literal
 */
export function envelopeFieldHasPlaceholderResidue(value: string): boolean {
  return ENVELOPE_PLACEHOLDER_RESIDUES.some(p => value.includes(p));
}

/**
 * Validate the structure of an EvidenceEnvelope before it is passed to Athena.
 *
 * Required fields: roleName (string), status (string), summary (string),
 * verificationEvidence (object with build/tests/lint slots).
 * Each evidence slot must be "pass" | "fail" | "n/a".
 *
 * Additionally, the summary field must not contain unfilled post-merge artifact
 * template placeholders — such residue indicates the worker did not complete
 * the required artifact fields before submitting.
 *
 * @param envelope — value to validate (untrusted)
 * @returns { valid: boolean; errors: string[] }
 */
export function validateEvidenceEnvelope(envelope: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!envelope || typeof envelope !== "object") {
    return { valid: false, errors: ["envelope must be a non-null object"] };
  }

  const e = envelope as Record<string, unknown>;

  if (typeof e.roleName !== "string" || e.roleName.trim() === "") {
    errors.push("roleName must be a non-empty string");
  }
  if (typeof e.status !== "string" || e.status.trim() === "") {
    errors.push("status must be a non-empty string");
  }
  if (typeof e.summary !== "string" || e.summary.trim() === "") {
    errors.push("summary must be a non-empty string");
  } else if (envelopeFieldHasPlaceholderResidue(e.summary)) {
    errors.push("summary contains unfilled template placeholder residue — replace placeholder text with actual content");
  }

  const ev = e.verificationEvidence;
  errors.push(...validateNestedVerificationEvidence(ev, "verificationEvidence"));
  errors.push(...validateLineageSnapshot(e.lineage, e.lineageJoinKey, "lineage", {
    taskKind: e.taskKind,
    role: e.roleName,
  }));

  if (e.planArtifact != null) {
    errors.push(...validatePlanArtifact(e.planArtifact));
  }
  if (e.reviewArtifact != null) {
    errors.push(...validateReviewArtifact(e.reviewArtifact));
  }
  if (e.executionReport != null) {
    errors.push(...validateExecutionReportArtifact(e.executionReport));
  }

  return { valid: errors.length === 0, errors };
}

// ── Plan dispatch evidence coupling validation ────────────────────────────────

/**
 * Validate that a plan packet has adequate evidence coupling before it enters
 * the dispatch pipeline.
 *
 * A plan must carry at least one non-empty verification command and at least
 * one acceptance criterion so that automated completion signals can be verified
 * after the worker runs.  Plans that fail this check must be blocked at the
 * governance gate, not silently dispatched with unverifiable outcomes.
 *
 * @param plan — plan object as produced by Prometheus normalization (untrusted)
 * @returns { valid: boolean; errors: string[] }
 */
export function validatePlanEvidenceCoupling(plan: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!plan || typeof plan !== "object") {
    return { valid: false, errors: ["plan must be a non-null object"] };
  }

  const p = plan as Record<string, unknown>;

  // verification_commands: must be a non-empty array with ≥1 non-empty string.
  const cmds = p.verification_commands;
  if (!Array.isArray(cmds) || cmds.length === 0) {
    errors.push("plan.verification_commands must be a non-empty array");
  } else {
    const nonEmpty = cmds.filter(c => typeof c === "string" && String(c).trim().length > 0);
    if (nonEmpty.length === 0) {
      errors.push("plan.verification_commands must contain at least one non-empty command string");
    }
  }

  // acceptance_criteria: must be a non-empty string or non-empty array of strings.
  const ac = p.acceptance_criteria;
  const acValid =
    (typeof ac === "string" && ac.trim().length > 0) ||
    (Array.isArray(ac) && ac.length > 0 &&
      ac.some(a => typeof a === "string" && String(a).trim().length > 0));
  if (!acValid) {
    errors.push("plan.acceptance_criteria must be a non-empty string or array");
  }

  return { valid: errors.length === 0, errors };
}

// ── Unambiguous envelope check (deterministic fast-path gate) ─────────────────

/**
 * Check whether an evidence envelope is both structurally complete AND
 * unambiguous enough to allow the deterministic fast-path to skip premium AI
 * review.
 *
 * "Complete" means validateEvidenceEnvelope passes.
 * "Unambiguous" means all of the following hold:
 *   - verificationEvidence.build  === "pass"
 *   - verificationEvidence.tests  === "pass"
 *   - verificationEvidence.lint   is "pass" or "n/a" (not "fail")
 *   - verificationPassed          === true
 *   - status                      === "done"
 *   - No pre-review issues remain unaddressed (preReviewIssues must be absent or empty)
 *
 * If the original plan carries riskLevel="high", this gate always returns
 * unambiguous=false — high-risk plans require full AI review regardless of
 * evidence quality.
 *
 * @param envelope  — EvidenceEnvelope passed from the evolution executor
 * @param opts      — optional { planRiskLevel?: string }
 * @returns {{ unambiguous: boolean; reasons: string[] }}
 */
export function isEnvelopeUnambiguous(
  envelope: unknown,
  opts: { planRiskLevel?: string } = {}
): { unambiguous: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // High-risk plans always require AI review.
  if (opts.planRiskLevel === "high") {
    reasons.push("plan riskLevel=high always requires full AI review");
    return { unambiguous: false, reasons };
  }

  // Structural completeness is required first.
  const structuralCheck = validateEvidenceEnvelope(envelope);
  if (!structuralCheck.valid) {
    reasons.push(...structuralCheck.errors.map(e => `structural: ${e}`));
    return { unambiguous: false, reasons };
  }

  const e = envelope as Record<string, unknown>;
  const ve = e.verificationEvidence as Record<string, unknown> | undefined;

  if (e.status !== "done") {
    reasons.push(`status must be "done", got "${e.status}"`);
  }
  if (e.verificationPassed !== true) {
    reasons.push("verificationPassed must be true");
  }
  if (!ve || ve.build !== "pass") {
    reasons.push(`verificationEvidence.build must be "pass", got "${ve?.build}"`);
  }
  if (!ve || ve.tests !== "pass") {
    reasons.push(`verificationEvidence.tests must be "pass", got "${ve?.tests}"`);
  }
  if (ve && ve.lint === "fail") {
    reasons.push('verificationEvidence.lint must not be "fail"');
  }
  // Pre-review issues that are unfixed make the result ambiguous.
  const preReviewIssues = Array.isArray(e.preReviewIssues) ? e.preReviewIssues : [];
  if (preReviewIssues.length > 0) {
    reasons.push(`preReviewIssues present (${preReviewIssues.length} unfixed) — not unambiguous`);
  }

  return { unambiguous: reasons.length === 0, reasons };
}

