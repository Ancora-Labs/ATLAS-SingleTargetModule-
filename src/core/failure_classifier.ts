/**
 * failure_classifier.js — Semantic failure taxonomy classifier for BOX.
 *
 * Classifies task failures into one of six semantic categories with a
 * confidence score, and flags low-confidence results for human review.
 *
 * ── Taxonomy version ──────────────────────────────────────────────────────────
 *   CLASSIFIER_TAXONOMY_VERSION = "1.0.0"
 *   FAILURE_CLASSIFIER_SCHEMA_VERSION = 1
 *
 * ── Failure classes (FAILURE_CLASS enum) ─────────────────────────────────────
 *   environment   — OS/filesystem/network/infra failures; retries may help
 *   policy        — Policy gate rejections, access violations; human intervention needed
 *   verification  — Verification gate failures, test failures, rework exhausted
 *   model         — AI model errors, rate limits, quota exceeded
 *   external_api  — GitHub/external API failures, HTTP 4xx/5xx
 *   logic_defect  — Code bugs, logic errors, unexpected behaviour
 *
 * ── Confidence threshold (AC #3 / Athena missing item #1) ────────────────────
 *   LOW_CONFIDENCE_THRESHOLD = 0.6
 *   confidence < 0.6 → flagged: true
 *   This is the ONLY numeric gate for "low-confidence" in this classifier.
 *
 * ── Evidence schema (AC #2 / Athena missing item #3) ─────────────────────────
 *   Required fields stored in every ClassificationResult.evidence:
 *     error_message          {string}       — from input.errorMessage (or "")
 *     stack_trace            {string}       — from input.stackTrace (or "")
 *     log_lines              {string[]}     — from input.logLines (max 10 entries; or [])
 *     blocking_reason_class  {string|null}  — from input.blockingReasonClass (or null)
 *     worker_status          {string}       — from input.workerStatus
 *   Optional phase-aware fields:
 *     failure_phase          {string|null}  — plan|edit|test|push when deterministically inferred
 *     phase_evidence         {object[]}     — compact evidence objects supporting failure_phase
 *
 * ── ClassificationResult schema (AC #8 / Athena missing item #7) ─────────────
 *   Required fields:
 *     schemaVersion      {number}    = FAILURE_CLASSIFIER_SCHEMA_VERSION (1)
 *     classifierVersion  {string}    = CLASSIFIER_TAXONOMY_VERSION ("1.0.0")
 *     taskId             {string|null}
 *     primaryClass       {string}    — one of FAILURE_CLASS values
 *     confidence         {number}    — [0.0, 1.0]
 *     flagged            {boolean}   — true when confidence < LOW_CONFIDENCE_THRESHOLD
 *     evidence           {object}    — see evidence schema above
 *     classifiedAt       {string}    — ISO 8601 timestamp
 *
 * ── Validation reason codes (AC #9 / Athena missing item #8) ─────────────────
 *   CLASSIFIER_REASON_CODE.MISSING_INPUT  — input is null/undefined
 *   CLASSIFIER_REASON_CODE.INVALID_TYPE   — input is not a plain object
 *   CLASSIFIER_REASON_CODE.MISSING_FIELD  — required field workerStatus absent
 *   CLASSIFIER_REASON_CODE.INVALID_FIELD  — workerStatus is empty/invalid type
 *
 * ── Intervention prioritisation integration (AC #5 / Athena missing item #2) ──
 *   applyClassificationToSuccessProbability(successProbability, classification)
 *   is called by runInterventionOptimizer when failureClassifications are provided.
 *   The code path is:
 *     runInterventionOptimizer(interventions, budget, { failureClassifications })
 *     → applyClassificationsToInterventions (internal) → ranking
 *   Observable behavioral change: successProbability values in ranked/selected
 *   arrays are lower when prior failures exist, shifting EV and schedule order.
 *
 * Risk: MEDIUM — integrates into worker_runner.js (hot path) and
 *   intervention_optimizer.js (planning hot path). Classification and persistence
 *   are wrapped in non-fatal try/catch blocks so failures never block orchestration.
 */

// ── Schema version ────────────────────────────────────────────────────────────

/** Integer schema version for ClassificationResult.  Bump on incompatible schema change. */
export const FAILURE_CLASSIFIER_SCHEMA_VERSION = 1;

/** Human-readable taxonomy version string. Bump when class definitions change. */
export const CLASSIFIER_TAXONOMY_VERSION = "1.0.0";

// ── Failure class enum ────────────────────────────────────────────────────────

/**
 * Exhaustive set of semantic failure classes.
 * Every classified failure receives exactly one primaryClass value from this enum.
 *
 *   environment   — OS/filesystem/network/infra failures; retries may help
 *   policy        — Policy gate rejections, access violations; human intervention needed
 *   verification  — Verification gate failures, rework exhausted, test failures
 *   model         — AI model errors, rate limits, quota exceeded
 *   external_api  — GitHub/external API failures, HTTP 4xx/5xx
 *   logic_defect  — Code bugs, unexpected behaviour, unknown failures
 */
export const FAILURE_CLASS = Object.freeze({
  ENVIRONMENT:  "environment",
  POLICY:       "policy",
  VERIFICATION: "verification",
  MODEL:        "model",
  EXTERNAL_API: "external_api",
  LOGIC_DEFECT: "logic_defect",
});

// ── Confidence threshold ──────────────────────────────────────────────────────

/**
 * Numeric confidence threshold below which a classification is flagged for review.
 *
 * AC #3 (Athena missing item #1): confidence < LOW_CONFIDENCE_THRESHOLD → flagged: true
 *
 * This is the single authoritative constant.  Any test asserting low-confidence
 * behaviour must use this value.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

// ── Validation reason codes ───────────────────────────────────────────────────

/**
 * Machine-readable reason codes returned by validateClassifierInput.
 * Distinguishes missing input from invalid input with deterministic handling.
 *
 * AC #9 (Athena missing item #8): All reason codes are named constants here.
 */
export const CLASSIFIER_REASON_CODE = Object.freeze({
  /** Input is null or undefined (missing entirely). */
  MISSING_INPUT:  "MISSING_INPUT",
  /** Input is not a plain object (wrong type). */
  INVALID_TYPE:   "INVALID_TYPE",
  /** Required field `workerStatus` is absent. */
  MISSING_FIELD:  "MISSING_FIELD",
  /** `workerStatus` is present but empty or not a string. */
  INVALID_FIELD:  "INVALID_FIELD",
});

// ── Evidence schema (for documentation and AC #2 compliance) ─────────────────

/**
 * Canonical schema for the `evidence` object in every ClassificationResult.
 *
 * AC #2 / Athena missing item #3: defines required fields and their data sources.
 *
 * Sources:
 *   error_message         ← input.errorMessage (string, or "" if absent)
 *   stack_trace           ← input.stackTrace (string, or "" if absent)
 *   log_lines             ← input.logLines (string[], max 10 entries, or [])
 *   blocking_reason_class ← input.blockingReasonClass (string|null, or null if absent)
 *   worker_status         ← input.workerStatus (required string)
 */
export const EVIDENCE_SCHEMA = Object.freeze({
  required: Object.freeze([
    "error_message",
    "stack_trace",
    "log_lines",
    "blocking_reason_class",
    "worker_status",
  ]),
  optional: Object.freeze([
    "failure_phase",
    "phase_evidence",
  ]),
});

/**
 * Canonical schema for the ClassificationResult object.
 *
 * AC #8 / Athena missing item #7: required fields and enum values defined here.
 *
 * Required fields:
 *   schemaVersion, classifierVersion, taskId, primaryClass,
 *   confidence, flagged, evidence, classifiedAt
 *
 * Enum values:
 *   primaryClass: Object.values(FAILURE_CLASS)
 */
export const CLASSIFICATION_RESULT_SCHEMA = Object.freeze({
  required: Object.freeze([
    "schemaVersion",
    "classifierVersion",
    "taskId",
    "primaryClass",
    "confidence",
    "flagged",
    "evidence",
    "classifiedAt",
  ]),
  primaryClassEnum: Object.freeze(Object.values(FAILURE_CLASS)),
  confidenceRange:  Object.freeze({ min: 0.0, max: 1.0 }),
  schemaVersion:    FAILURE_CLASSIFIER_SCHEMA_VERSION,
});

// ── Valid worker status values ────────────────────────────────────────────────

/** Valid workerStatus values accepted by validateClassifierInput. */
export const VALID_WORKER_STATUSES = Object.freeze(["error", "blocked", "partial", "done"]);

// ── Success-probability adjustment table ──────────────────────────────────────

/**
 * Deterministic success-probability adjustment rules applied per failure class.
 *
 * type "subtract": adjusted = max(0.05, successProbability - value)
 * type "multiply":  adjusted = max(0.05, successProbability * value)
 *
 * Rationale:
 *   environment   subtract 0.15 — infra issues may resolve on retry
 *   policy        multiply  0.20 — human intervention almost always required
 *   verification  subtract 0.20 — rework needed; partial re-attempt may succeed
 *   model         subtract 0.15 — rate limits / quota may clear on next cycle
 *   external_api  subtract 0.15 — external API issues may resolve over time
 *   logic_defect  multiply  0.25 — code defect needs deliberate fix
 *
 * Low-confidence penalty: if classification.flagged === true, an additional
 *   subtract 0.05 is applied after the primary adjustment.
 *
 * Floor: 0.05 — never reduce to zero so some human-assisted resolution chance remains.
 */
export const FAILURE_CLASS_SP_ADJUSTMENT = Object.freeze({
  [FAILURE_CLASS.ENVIRONMENT]:  Object.freeze({ type: "subtract", value: 0.15 }),
  [FAILURE_CLASS.POLICY]:       Object.freeze({ type: "multiply",  value: 0.20 }),
  [FAILURE_CLASS.VERIFICATION]: Object.freeze({ type: "subtract", value: 0.20 }),
  [FAILURE_CLASS.MODEL]:        Object.freeze({ type: "subtract", value: 0.15 }),
  [FAILURE_CLASS.EXTERNAL_API]: Object.freeze({ type: "subtract", value: 0.15 }),
  [FAILURE_CLASS.LOGIC_DEFECT]: Object.freeze({ type: "multiply",  value: 0.25 }),
});

/** Minimum successProbability after classification adjustment. */
export const SP_ADJUSTMENT_FLOOR = 0.05;

/** Additional penalty applied when classification.flagged === true. */
export const LOW_CONFIDENCE_SP_PENALTY = 0.05;

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a classifier input object.
 *
 * Distinguishes missing input from invalid input:
 *   null/undefined input       → ok=false, code=MISSING_INPUT
 *   non-object input           → ok=false, code=INVALID_TYPE
 *   workerStatus field absent  → ok=false, code=MISSING_FIELD, field="workerStatus"
 *   workerStatus empty/invalid → ok=false, code=INVALID_FIELD, field="workerStatus"
 *   fully valid                → ok=true,  code=null
 *
 * @param {any} input
 * @returns {{ ok: boolean, code: string|null, field?: string, message: string }}
 */
export function validateClassifierInput(input) {
  if (input === null || input === undefined) {
    return {
      ok: false,
      code: CLASSIFIER_REASON_CODE.MISSING_INPUT,
      message: "classifier input is required (got null/undefined)",
    };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      code: CLASSIFIER_REASON_CODE.INVALID_TYPE,
      message: "classifier input must be a plain object",
    };
  }

  if (!("workerStatus" in input)) {
    return {
      ok: false,
      code: CLASSIFIER_REASON_CODE.MISSING_FIELD,
      field: "workerStatus",
      message: "required field 'workerStatus' is missing",
    };
  }

  if (typeof input.workerStatus !== "string" || input.workerStatus.trim() === "") {
    return {
      ok: false,
      code: CLASSIFIER_REASON_CODE.INVALID_FIELD,
      field: "workerStatus",
      message: `workerStatus must be a non-empty string; got ${JSON.stringify(input.workerStatus)}`,
    };
  }

  return { ok: true, code: null, message: "valid" };
}

// ── Classification rules ──────────────────────────────────────────────────────

// Pattern regexes — compiled once.
const PAT_TIMEOUT     = /timeout|timed\s+out|ETIMEDOUT|ESOCKETTIMEDOUT/i;
const PAT_RATE_LIMIT  = /rate.?limit|quota\s+exceeded|too\s+many\s+requests/i;
const PAT_NETWORK     = /ENOTFOUND|ECONNREFUSED|ECONNRESET|EPIPE|network|DNS|socket/i;
const PAT_HTTP_ERROR  = /HTTP\s+[45]\d\d|fetch\s+error|API\s+error|api\s+fail/i;
const PAT_POLICY      = /policy|permission\s+denied|access\s+denied|forbidden|unauthorized/i;
const PAT_VERIFY      = /test\s+fail|assertion|verify|verification\s+fail|rework/i;

// ── Windows process termination exit codes ──────────────────────────────────
// 0x40010004 (1073807364) = STATUS_CONTROL_C_EXIT — process killed by Ctrl+C or TerminateProcess
// 0xC000013A (3221225786) = STATUS_CONTROL_C_EXIT (signed variant)
// 0xC0000005 (3221225477) = STATUS_ACCESS_VIOLATION — segfault equivalent
// These are non-transient environment-class failures: the process was forcibly terminated.
const WIN32_KILLED_EXIT_CODES = new Set([1073807364, 3221225786, 3221225477]);

/**
 * Classify a numeric exit code into a failure reason.
 * Returns null when the exit code is not a recognized crash signature.
 */
export function classifyExitCode(exitCode: number | null | undefined): {
  reasonCode: string;
  retryClass: "cooldown" | "no_retry" | null;
  primaryClass: string;
  confidence: number;
} | null {
  if (exitCode == null || !Number.isFinite(exitCode)) return null;
  if (WIN32_KILLED_EXIT_CODES.has(exitCode)) {
    return {
      reasonCode: "WIN32_PROCESS_TERMINATED",
      retryClass: "cooldown",
      primaryClass: FAILURE_CLASS.ENVIRONMENT,
      confidence: 0.90,
    };
  }
  // Signal-killed on Unix (128 + signal): SIGKILL=137, SIGTERM=143, SIGABRT=134
  if (exitCode >= 128 && exitCode <= 192) {
    return {
      reasonCode: `UNIX_SIGNAL_${exitCode - 128}`,
      retryClass: "cooldown",
      primaryClass: FAILURE_CLASS.ENVIRONMENT,
      confidence: 0.85,
    };
  }
  return null;
}

/**
 * Apply classification rules to a validated input and return primaryClass + confidence.
 *
 * Priority order:
 *   1. Known BLOCKING_REASON_CLASS values → deterministic high-confidence mapping
 *   2. Pattern matching on errorMessage + log_lines
 *   3. workerStatus fallback
 *
 * @param {object} input — validated classifier input
 * @returns {{ primaryClass: string, confidence: number }}
 */
function determineClass(input) {
  const rc  = String(input.blockingReasonClass || "");
  const msg = String(input.errorMessage || "");
  const st  = String(input.stackTrace || "");
  const logText = Array.isArray(input.logLines) ? input.logLines.join(" ") : "";
  const combined = `${msg} ${st} ${logText}`;

  // ── Tier 1: Known BLOCKING_REASON_CLASS (highest confidence) ──────────────
  if (rc === "POLICY_VIOLATION") {
    return { primaryClass: FAILURE_CLASS.POLICY, confidence: 0.95 };
  }
  if (rc === "ACCESS_BLOCKED") {
    return { primaryClass: FAILURE_CLASS.POLICY, confidence: 0.90 };
  }
  if (rc === "VERIFICATION_GATE") {
    return { primaryClass: FAILURE_CLASS.VERIFICATION, confidence: 0.90 };
  }
  if (rc === "MAX_REWORK_EXHAUSTED") {
    return { primaryClass: FAILURE_CLASS.VERIFICATION, confidence: 0.85 };
  }
  if (rc === "WORKER_ERROR") {
    // Sub-classify WORKER_ERROR by exit code first (deterministic, highest signal)
    const exitCodeMatch = /exit[=:]?\s*(\d+)/i.exec(combined);
    if (exitCodeMatch) {
      const exitClassification = classifyExitCode(Number(exitCodeMatch[1]));
      if (exitClassification) {
        return { primaryClass: exitClassification.primaryClass, confidence: exitClassification.confidence };
      }
    }
    // Sub-classify WORKER_ERROR by error text patterns
    if (PAT_TIMEOUT.test(combined)) {
      return { primaryClass: FAILURE_CLASS.ENVIRONMENT, confidence: 0.80 };
    }
    if (PAT_RATE_LIMIT.test(combined)) {
      return { primaryClass: FAILURE_CLASS.MODEL, confidence: 0.85 };
    }
    if (PAT_HTTP_ERROR.test(combined)) {
      return { primaryClass: FAILURE_CLASS.EXTERNAL_API, confidence: 0.75 };
    }
    if (PAT_NETWORK.test(combined)) {
      return { primaryClass: FAILURE_CLASS.ENVIRONMENT, confidence: 0.80 };
    }
    // Generic worker error — insufficient signal
    return { primaryClass: FAILURE_CLASS.LOGIC_DEFECT, confidence: 0.55 };
  }

  // ── Tier 2: No blockingReasonClass — pattern matching ─────────────────────
  if (rc === "" || rc === "null" || rc === "undefined") {
    if (PAT_RATE_LIMIT.test(combined)) {
      return { primaryClass: FAILURE_CLASS.MODEL, confidence: 0.80 };
    }
    if (PAT_TIMEOUT.test(combined)) {
      return { primaryClass: FAILURE_CLASS.ENVIRONMENT, confidence: 0.75 };
    }
    if (PAT_POLICY.test(combined)) {
      return { primaryClass: FAILURE_CLASS.POLICY, confidence: 0.70 };
    }
    if (PAT_HTTP_ERROR.test(combined)) {
      return { primaryClass: FAILURE_CLASS.EXTERNAL_API, confidence: 0.65 };
    }
    if (PAT_NETWORK.test(combined)) {
      return { primaryClass: FAILURE_CLASS.ENVIRONMENT, confidence: 0.70 };
    }
    if (PAT_VERIFY.test(combined)) {
      return { primaryClass: FAILURE_CLASS.VERIFICATION, confidence: 0.70 };
    }
  }

  // ── Tier 3: workerStatus fallback (lowest confidence) ─────────────────────
  const status = String(input.workerStatus || "").toLowerCase();
  if (status === "blocked") {
    return { primaryClass: FAILURE_CLASS.LOGIC_DEFECT, confidence: 0.50 };
  }
  if (status === "error") {
    return { primaryClass: FAILURE_CLASS.LOGIC_DEFECT, confidence: 0.45 };
  }

  // Catch-all — minimal confidence
  return { primaryClass: FAILURE_CLASS.LOGIC_DEFECT, confidence: 0.40 };
}

// ── Main classifier ───────────────────────────────────────────────────────────

/**
 * Classify a task failure into a semantic category with confidence score.
 *
 * AC #1: Every failed/blocked task receives exactly one primaryClass.
 * AC #3: confidence < LOW_CONFIDENCE_THRESHOLD (0.6) → flagged: true.
 * AC #2: evidence object contains all fields defined in EVIDENCE_SCHEMA.
 * AC #10: No silent fallback — invalid input returns ok=false with explicit code.
 *
 * @param {object} input
 *   @param {string}   input.workerStatus           — required: "error"|"blocked"|"partial"|"done"
 *   @param {string}  [input.blockingReasonClass]   — optional: from BLOCKING_REASON_CLASS enum
 *   @param {string}  [input.errorMessage]          — optional: error message text
 *   @param {string}  [input.stackTrace]            — optional: stack trace
 *   @param {string[]}[input.logLines]              — optional: relevant log lines (max 10)
 *   @param {string}  [input.failurePhase]          — optional: plan|edit|test|push failure location
 *   @param {object[]} [input.phaseEvidence]        — optional: compact evidence supporting failurePhase
 *   @param {string}  [input.taskId]                — optional: task identifier
 *   @param {object}  [input.attemptMeta]           — optional: attempt-scoped metadata
 *     @param {string}  [input.attemptMeta.runId]          — short hex run identifier
 *     @param {number}  [input.attemptMeta.attempt]         — zero-based attempt index
 *     @param {string}  [input.attemptMeta.firstAttemptAt]  — ISO timestamp of first attempt
 *
 * @returns {{ ok: true, classification: ClassificationResult } |
 *           { ok: false, code: string, field?: string, message: string }}
 */
export function classifyFailure(input) {
  const validation = validateClassifierInput(input);
  if (!validation.ok) {
    return { ok: false, code: validation.code, field: validation.field, message: validation.message };
  }

  const { primaryClass, confidence } = determineClass(input);

  const attemptMeta: AttemptMeta | null = input.attemptMeta && typeof input.attemptMeta === "object"
    ? {
        runId:          input.attemptMeta.runId != null ? String(input.attemptMeta.runId) : undefined,
        attempt:        Number.isFinite(Number(input.attemptMeta.attempt)) ? Number(input.attemptMeta.attempt) : undefined,
        firstAttemptAt: input.attemptMeta.firstAttemptAt != null ? String(input.attemptMeta.firstAttemptAt) : undefined,
      }
    : null;

  const classification = {
    schemaVersion:     FAILURE_CLASSIFIER_SCHEMA_VERSION,
    classifierVersion: CLASSIFIER_TAXONOMY_VERSION,
    taskId:            input.taskId != null ? String(input.taskId) : null,
    primaryClass,
    confidence,
    flagged:           confidence < LOW_CONFIDENCE_THRESHOLD,
    attemptMeta,
      evidence: {
        error_message:         String(input.errorMessage || ""),
        stack_trace:           String(input.stackTrace || ""),
        log_lines:             Array.isArray(input.logLines) ? input.logLines.slice(0, 10).map(String) : [],
        blocking_reason_class: input.blockingReasonClass != null ? String(input.blockingReasonClass) : null,
        worker_status:         String(input.workerStatus),
        failure_phase:         input.failurePhase != null ? String(input.failurePhase) : null,
        phase_evidence:        Array.isArray(input.phaseEvidence)
          ? input.phaseEvidence
            .filter((entry) => entry && typeof entry === "object")
            .slice(0, 8)
            .map((entry) => ({
              code: String((entry as any).code || "unspecified"),
              detail: String((entry as any).detail || "").slice(0, 240),
              source: String((entry as any).source || "worker_output"),
            }))
          : [],
      },
      classifiedAt: new Date().toISOString(),
    };

  return { ok: true, classification };
}

// ── Intervention priority integration ────────────────────────────────────────

/**
 * Adjust a successProbability value based on a failure classification.
 *
 * AC #5 / Athena missing item #2:
 *   This function is the observable behavioral change that "feeds intervention
 *   prioritization". It is called inside runInterventionOptimizer when
 *   failureClassifications are provided, before ranking by EV.
 *
 * Adjustment formula (from FAILURE_CLASS_SP_ADJUSTMENT table):
 *   type="subtract": adjusted = max(SP_ADJUSTMENT_FLOOR, sp - value)
 *   type="multiply":  adjusted = max(SP_ADJUSTMENT_FLOOR, sp * value)
 *   Low-confidence penalty: if classification.flagged, subtract LOW_CONFIDENCE_SP_PENALTY after.
 *   Floor: SP_ADJUSTMENT_FLOOR (0.05) — never reduce to zero.
 *
 * @param {number} successProbability  — current SP in [0.0, 1.0]
 * @param {object} classification      — ClassificationResult from classifyFailure
 * @returns {number}                   — adjusted SP in [SP_ADJUSTMENT_FLOOR, 1.0]
 */
export function applyClassificationToSuccessProbability(successProbability, classification) {
  const sp = Number(successProbability);
  if (!Number.isFinite(sp)) return SP_ADJUSTMENT_FLOOR;

  const rule = FAILURE_CLASS_SP_ADJUSTMENT[classification?.primaryClass];
  if (!rule) return Math.max(SP_ADJUSTMENT_FLOOR, sp);

  let adjusted;
  if (rule.type === "subtract") {
    adjusted = sp - rule.value;
  } else {
    // multiply
    adjusted = sp * rule.value;
  }

  // Additional low-confidence penalty
  if (classification.flagged === true) {
    adjusted -= LOW_CONFIDENCE_SP_PENALTY;
  }

  return Math.max(SP_ADJUSTMENT_FLOOR, adjusted);
}

// ── Orchestration state persistence ──────────────────────────────────────────

/**
 * Normalize a worker role name to a canonical key used for failure-classification
 * lookups and persistence.
 *
 * Transforms any casing/spacing variant to lowercase-hyphenated form so that
 * "Evolution Worker", "evolution worker", and "evolution-worker" all resolve to
 * the same key. This prevents silent misses in the intervention optimizer when
 * Prometheus emits role names that differ only in formatting.
 *
 * @param role — raw role string (e.g. "Evolution Worker")
 * @returns    — normalized key  (e.g. "evolution-worker")
 */
export function normalizeRoleKey(role: string): string {
  return String(role || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Load recent failure classifications from orchestration state.
 *
 * Reads `state/worker_failure_classifications.jsonl`, returns the last `limit`
 * entries as a `{ [role]: ClassificationResult }` map keyed by role name.
 * When multiple classifications exist for the same role, the most recent one wins.
 *
 * Keys are normalized via {@link normalizeRoleKey} so lookups are
 * case- and whitespace-insensitive.
 *
 * Returns an empty object when the file does not exist or cannot be parsed.
 * Never throws — failures are silent (non-fatal analytics path).
 *
 * @param stateDir — path to the BOX state directory
 * @param limit    — maximum number of JSONL records to read (default: 30)
 * @returns map of role → ClassificationResult for injection into the optimizer
 */
export async function loadRecentFailureClassifications(
  stateDir: string,
  limit = 30,
): Promise<Record<string, unknown>> {
  try {
    const { readFile } = await import("node:fs/promises");
    const filePath = (await import("node:path")).join(stateDir, "worker_failure_classifications.jsonl");
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    const safeLimit = Math.max(1, Math.floor(Number(limit) || 30));
    const records = lines.slice(-safeLimit).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    // Build role → classification map; later entries override earlier ones for same role.
    // Keys are normalized so "Evolution Worker" and "evolution-worker" resolve to the same entry.
    const byRole: Record<string, unknown> = {};
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const role = normalizeRoleKey(String(record.role || ""));
      const classification = record.classification;
      if (!role || !classification || typeof classification !== "object") continue;
      byRole[role] = classification;
    }
    return byRole;
  } catch {
    return {};
  }
}

/**
 * Persist a failure classification for a worker role to orchestration state.
 *
 * Appends a JSONL record to `state/worker_failure_classifications.jsonl` so that
 * subsequent cycles can feed it into the intervention optimizer.
 *
 * Never throws — persistence failures are logged but do not block orchestration.
 *
 * @param stateDir       — path to the BOX state directory
 * @param role           — worker role name
 * @param classification — ClassificationResult from classifyFailure
 */
export async function persistFailureClassification(
  stateDir: string,
  role: string,
  classification: unknown,
): Promise<void> {
  try {
    const pathModule = await import("node:path");
    const { appendFile } = await import("node:fs/promises");
    const filePath = pathModule.join(stateDir, "worker_failure_classifications.jsonl");
    const record = {
      role: String(role || ""),
      classification,
      recordedAt: new Date().toISOString(),
    };
    await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* best-effort — never block orchestration */
  }
}

// ── Failure Envelope ──────────────────────────────────────────────────────────

/** Schema version for the unified failure envelope. */
export const FAILURE_ENVELOPE_SCHEMA_VERSION = 1;

/**
 * Typed enumeration of top-level termination causes that produced a failure.
 * Consumed by worker_runner, verification_gate, and postmortem analysis.
 *
 * - error:                Worker process exited with a non-zero code or threw.
 * - blocked:              Worker was blocked by a policy gate or escalation limit.
 * - cancelled:            Execution was cancelled via CancellationToken.
 * - timeout:              Worker process exceeded the configured time limit.
 * - verification_failed:  Post-merge verification gate produced unresolved gaps.
 */
export const TERMINATION_CAUSE = Object.freeze({
  ERROR:                "error",
  BLOCKED:              "blocked",
  CANCELLED:            "cancelled",
  TIMEOUT:              "timeout",
  VERIFICATION_FAILED:  "verification_failed",
} as const);

export type TerminationCause = typeof TERMINATION_CAUSE[keyof typeof TERMINATION_CAUSE];

/** Unified failure envelope consumed by worker_runner, verification_gate, and postmortem analysis. */
export interface FailureEnvelope {
  /** Monotonically incrementing schema version for forward-compat. */
  schemaVersion: typeof FAILURE_ENVELOPE_SCHEMA_VERSION;
  /** Unique envelope identifier (crypto random hex prefix). */
  envelopeId: string;
  /** Task identifier — null when not available at classification time. */
  taskId: string | null;
  /** The top-level cause that terminated execution. */
  terminationCause: TerminationCause;
  /** Structured failure classification — null when classification failed or was not attempted. */
  classification: Record<string, unknown> | null;
  /** Adaptive retry decision — null when retry resolution was not attempted. */
  retryDecision: Record<string, unknown> | null;
  /** Attempt-scoped execution metadata for replay tracing. */
  attemptMeta: AttemptMeta | null;
  /** Structured retry-phase state used to mutate the next attempt. */
  phaseRetryState?: Record<string, unknown> | null;
  /** ISO timestamp when this envelope was assembled. */
  resolvedAt: string;
}

/** Attempt-scoped metadata attached to failure envelopes for deterministic replay tracing. */
export interface AttemptMeta {
  /** Short hex run identifier derived from taskId + attempt + timestamp. */
  runId?: string;
  /** Zero-based attempt index (0 = first attempt). */
  attempt?: number;
  /** ISO timestamp of the first attempt in this lineage. */
  firstAttemptAt?: string;
}

/** Lightweight schema descriptor for validation consumers. */
export const FAILURE_ENVELOPE_SCHEMA = Object.freeze({
  schemaVersion: FAILURE_ENVELOPE_SCHEMA_VERSION,
  required: ["schemaVersion", "envelopeId", "taskId", "terminationCause", "classification", "retryDecision", "attemptMeta", "resolvedAt"] as const,
  terminationCauses: Object.values(TERMINATION_CAUSE),
});

/**
 * Build a unified FailureEnvelope from existing classification and retry decision objects.
 *
 * Never throws — all errors are caught and logged to a `buildError` field.
 * Returns the envelope on both success and partial-failure paths so callers
 * can always persist a structured record.
 *
 * @param classification  - output of classifyFailure().classification (or null)
 * @param retryDecision   - output of resolveRetryAction().decision (or null)
 * @param terminationCause - one of TERMINATION_CAUSE values
 * @param taskId          - task identifier, or null when not available
 * @param attemptMeta     - optional attempt-scoped metadata for replay tracing
 * @param phaseRetryState - optional structured phase-aware retry state
 */
export function buildFailureEnvelope(
  classification: Record<string, unknown> | null,
  retryDecision: Record<string, unknown> | null,
  terminationCause: TerminationCause,
  taskId?: string | null,
  attemptMeta?: AttemptMeta | null,
  phaseRetryState?: Record<string, unknown> | null,
): FailureEnvelope {
  try {
    const cause: TerminationCause = Object.values(TERMINATION_CAUSE).includes(terminationCause as any)
      ? terminationCause
      : TERMINATION_CAUSE.ERROR;

    // Generate a short stable ID from timestamp + random suffix.
    const envelopeId = `fe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    return {
      schemaVersion: FAILURE_ENVELOPE_SCHEMA_VERSION,
      envelopeId,
      taskId: taskId != null ? String(taskId) : null,
      terminationCause: cause,
      classification: classification ?? null,
        retryDecision: retryDecision ?? null,
        attemptMeta: attemptMeta ?? null,
        phaseRetryState: phaseRetryState ?? null,
        resolvedAt: new Date().toISOString(),
      };
  } catch (err) {
    // Fallback envelope that never blocks orchestration — includes the build error for observability.
    return {
      schemaVersion: FAILURE_ENVELOPE_SCHEMA_VERSION,
      envelopeId: `fe-err-${Date.now().toString(36)}`,
      taskId: taskId != null ? String(taskId) : null,
      terminationCause: terminationCause ?? TERMINATION_CAUSE.ERROR,
      classification: null,
        retryDecision: null,
        attemptMeta: attemptMeta ?? null,
        phaseRetryState: phaseRetryState ?? null,
        resolvedAt: new Date().toISOString(),
        ...(({ buildError: String((err as any)?.message || err) }) as any),
      };
  }
}
