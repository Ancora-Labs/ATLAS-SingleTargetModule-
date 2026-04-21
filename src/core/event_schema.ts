/**
 * event_schema.js — Canonical event taxonomy for BOX orchestration.
 *
 * Naming convention:  box.v<N>.<domain>.<action>
 *   N      — schema version integer; bump when event shape changes incompatibly
 *   domain — one of EVENT_DOMAIN values
 *   action — camelCase verb-noun (e.g. cycleStarted, taskQueued)
 *
 * Every emitted event MUST conform to EVENT_SHAPE_SCHEMA (required fields,
 * typed domain, typed action, correlationId, ISO timestamp, integer version).
 *
 * Sensitive-field denylist: any payload key matching SENSITIVE_FIELD_DENYLIST
 * is redacted before emission. Callers must never embed raw secrets in events.
 *
 * Cross-agent span contract (SPAN_CONTRACT): optional span fields that any
 * agent MAY attach to event payloads for deterministic distributed tracing.
 * spanId/parentSpanId follow the OpenTelemetry naming convention.
 * Use buildSpanEvent() to stamp span context onto an event envelope.
 *
 * Risk level: HIGH — changes here affect the entire emission path across all
 * workers, orchestrator, and dashboard.
 */

import { randomUUID } from "node:crypto";

// ── Schema version ────────────────────────────────────────────────────────────

/** Current event schema version.  Bump when event shape changes incompatibly. */
export const EVENT_SCHEMA_VERSION = 1;

/** Regex that every well-formed event name must match. */
export const EVENT_NAME_PATTERN = /^box\.v\d+\.[a-z]+\.[a-zA-Z][a-zA-Z0-9_]*$/;

// ── Domains ───────────────────────────────────────────────────────────────────

/**
 * Canonical event domain identifiers.
 * Add a new key here and a corresponding EVENTS entry when introducing a domain.
 */
export const EVENT_DOMAIN = Object.freeze({
  ORCHESTRATION: "orchestration",
  PLANNING:      "planning",
  VERIFICATION:  "verification",
  POLICY:        "policy",
  BILLING:       "billing",
  GOVERNANCE:    "governance",
});

// ── Canonical event names per domain ─────────────────────────────────────────

/**
 * Canonical event names.  These are the ONLY valid event name strings.
 * Format: box.v<version>.<domain>.<action>
 *
 * Any event emitted with a name not listed here will fail schema validation.
 */
export const EVENTS = Object.freeze({
  // Orchestration domain — major loop lifecycle
  ORCHESTRATION_CYCLE_STARTED:       "box.v1.orchestration.cycleStarted",
  ORCHESTRATION_CYCLE_COMPLETED:     "box.v1.orchestration.cycleCompleted",
  ORCHESTRATION_CYCLE_FAILED:        "box.v1.orchestration.cycleFailed",
  ORCHESTRATION_STAGE_ENTERED:       "box.v1.orchestration.stageEntered",
  ORCHESTRATION_HEALTH_DEGRADED:     "box.v1.orchestration.healthDegraded",
  ORCHESTRATION_HEALTH_RECOVERED:    "box.v1.orchestration.healthRecovered",
  ORCHESTRATION_ALERT_EMITTED:       "box.v1.orchestration.alertEmitted",
  ORCHESTRATION_CATASTROPHE_DETECTED: "box.v1.orchestration.catastropheDetected",

  // Planning domain — Prometheus/Athena plan lifecycle
  PLANNING_ANALYSIS_STARTED:         "box.v1.planning.analysisStarted",
  PLANNING_ANALYSIS_COMPLETED:       "box.v1.planning.analysisCompleted",
  PLANNING_PLAN_APPROVED:            "box.v1.planning.planApproved",
  PLANNING_PLAN_REJECTED:            "box.v1.planning.planRejected",
  PLANNING_TASK_QUEUED:              "box.v1.planning.taskQueued",
  PLANNING_TASK_DISPATCHED:          "box.v1.planning.taskDispatched",
  PLANNING_REPLAN_TRIGGERED:         "box.v1.planning.replanTriggered",
  PLANNING_INTERVENTION_OPTIMIZED:  "box.v1.planning.interventionOptimized",

  // Verification domain — Athena postmortem / gate decisions
  VERIFICATION_GATE_PASSED:          "box.v1.verification.gatePassed",
  VERIFICATION_GATE_FAILED:          "box.v1.verification.gateFailed",
  VERIFICATION_POSTMORTEM_RECORDED:  "box.v1.verification.postmortemRecorded",
  VERIFICATION_WORKER_DONE:          "box.v1.verification.workerDone",
  VERIFICATION_WORKER_BLOCKED:       "box.v1.verification.workerBlocked",

  // Policy domain — budget, model, quota policy decisions
  POLICY_BUDGET_CHECKED:             "box.v1.policy.budgetChecked",
  POLICY_BUDGET_EXCEEDED:            "box.v1.policy.budgetExceeded",
  POLICY_MODEL_SELECTED:             "box.v1.policy.modelSelected",
  POLICY_RATE_LIMIT_BACKOFF:         "box.v1.policy.rateLimitBackoff",
  POLICY_SELF_DEV_BLOCKED:           "box.v1.policy.selfDevBlocked",

  // Billing domain — token / cost tracking
  BILLING_USAGE_RECORDED:            "box.v1.billing.usageRecorded",
  BILLING_COST_THRESHOLD_REACHED:    "box.v1.billing.costThresholdReached",
  BILLING_QUOTA_SNAPSHOT:            "box.v1.billing.quotaSnapshot",

  // Governance domain — evolution, self-improvement, schema migration
  GOVERNANCE_SCHEMA_MIGRATED:        "box.v1.governance.schemaMigrated",
  GOVERNANCE_SELF_IMPROVEMENT_RUN:   "box.v1.governance.selfImprovementRun",
  GOVERNANCE_EVOLUTION_TASK_STARTED: "box.v1.governance.evolutionTaskStarted",
  GOVERNANCE_EVOLUTION_TASK_DONE:    "box.v1.governance.evolutionTaskDone",

  // Governance domain — capability execution trace (runtime path observation).
  // Payload fields: capability (string), context (string), observedAt (ISO string)
  // Emitted by any module that confirms a capability was actually exercised at
  // runtime (not just present in source). Janus uses these traces as the second
  // gate in capability-gap downgrade logic.
  GOVERNANCE_CAPABILITY_EXECUTED:    "box.v1.governance.capabilityExecuted",

  // Governance domain — pre-dispatch gate decision (Task 8)
  // Payload fields: blocked (boolean), reason (string|null), inputSnapshot (object)
  GOVERNANCE_GATE_EVALUATED:         "box.v1.governance.gateEvaluated",

  // Policy domain — provider fallback decision (Task 8)
  // Payload fields: source ("provider"|"fallback"), fallbackReason (string|null), inputSnapshot (object)
  POLICY_PROVIDER_FALLBACK_DECISION: "box.v1.policy.providerFallbackDecision",

  // Policy domain — Janus latency fallback activation contract.
  // Payload fields: source (string), baseModel (string), fallbackModel (string),
  //                 fromTier (string), toTier (string), softTimeoutMs (number),
  //                 elapsedMsAtActivation (number), softTimeoutReached (boolean),
  //                 hardTimeoutMs (number), routingReason (string)
  POLICY_JANUS_FALLBACK_ACTIVATED:   "box.v1.policy.janusFallbackActivated",

  // Planning domain — per-packet stage transition (span contract)
  // Payload fields: taskId, stageFrom, stageTo, durationMs (SPAN_CONTRACT.stageTransition)
  //                 spanId, parentSpanId, traceId, agentId   (SPAN_CONTRACT.fields)
  PLANNING_STAGE_TRANSITION:         "box.v1.planning.stageTransition",

  // Planning domain — task dropped before completion (span contract)
  // Payload fields: taskId, stageWhenDropped, reason, dropCode (SPAN_CONTRACT.dropReason)
  //                 spanId, parentSpanId, traceId, agentId      (SPAN_CONTRACT.fields)
  PLANNING_TASK_DROPPED:             "box.v1.planning.taskDropped",

  // Policy domain — model routing decision finalized for a worker dispatch.
  // Payload fields: roleName (string), resolvedModel (string), tier ("T1"|"T2"|"T3"),
  //                 wasDowngraded (boolean), routingReasonCode (string), taskKind (string|null),
  //                 lineageId (string|null) — shared lineage key linking this routing decision
  //                 to the premium_usage_log and lineage_graph entries for the same task.
  //                 meetsQualityFloor (boolean) — whether the resolved model met the quality floor.
  POLICY_MODEL_ROUTED:               "box.v1.policy.modelRouted",

  // Policy domain — transient-error retry suppressed due to low expected ROI.
  // Payload fields: role (string), expectedGain (number), threshold (number),
  //                 reason (string), attempt (number)
  POLICY_RETRY_SUPPRESSED:           "box.v1.policy.retrySuppressed",

  // Policy domain — EV penalty applied to an intervention role because of
  // specialist reroute history in the current cycle.
  // Payload fields: role (string), lane (string), reasonCode (string),
  //                 fillRatio (number), penaltyFraction (number)
  POLICY_REROUTE_PENALTY_APPLIED:    "box.v1.policy.reroutePenaltyApplied",

  // Policy domain — Janus soft-timeout gated tier was evaluated but the
  // soft-timeout threshold had NOT been reached, so the tier was skipped and
  // no agent call was made (cutoff semantics).  This makes the cutoff decision
  // deterministically observable for analytics and postmortem review.
  // Payload fields: source (string), tier (string), softTimeoutMs (number),
  //                 elapsedMsAtCutoff (number), softTimeoutReached (boolean),
  //                 baseModel (string), fallbackModel (string),
  //                 hardTimeoutMs (number)
  POLICY_JANUS_SOFT_TIMEOUT_CUTOFF:  "box.v1.policy.janusSoftTimeoutCutoff",
});

/**
 * Deterministic soft-timeout semantics for Janus fallback routing analytics.
 *
 * - fallbackActivated: emitted only when fallback invocation actually proceeds.
 * - softTimeoutCutoff: emitted when fallback tier is skipped before invocation.
 */
export const JANUS_SOFT_TIMEOUT_POLICY_CONTRACT = Object.freeze({
  fallbackActivated: Object.freeze({
    event: EVENTS.POLICY_JANUS_FALLBACK_ACTIVATED,
    softTimeoutReached: true,
  }),
  softTimeoutCutoff: Object.freeze({
    event: EVENTS.POLICY_JANUS_SOFT_TIMEOUT_CUTOFF,
    softTimeoutReached: false,
  }),
});

/** Flat set of all valid event name strings — for O(1) lookup. */
export const VALID_EVENT_NAMES = Object.freeze(new Set(Object.values(EVENTS)));

// ── Major loop steps (mirrors PIPELINE_STAGE_ENUM) ───────────────────────────

/**
 * Enumeration of every major orchestration loop step.
 * This list MUST stay in sync with PIPELINE_STAGE_ENUM in pipeline_progress.js.
 * Used by ORCHESTRATION_STAGE_ENTERED events to assert completeness.
 */
export const ORCHESTRATION_LOOP_STEPS = Object.freeze([
  "idle",
  "janus_awakening",
  "janus_reading",
  "janus_thinking",
  "janus_decided",
  "prometheus_starting",
  "prometheus_reading_repo",
  "prometheus_analyzing",
  "prometheus_audit",
  "prometheus_done",
  "athena_reviewing",
  "athena_approved",
  "workers_dispatching",
  "workers_running",
  "workers_finishing",
  "cycle_complete",
]);

// ── Sensitive-field denylist ──────────────────────────────────────────────────

/**
 * Payload field names that are ALWAYS redacted before event emission.
 * Field matching is case-insensitive; denylist checks normalise to lower-case.
 *
 * If you add a new secret-bearing field to any worker/provider, add it here.
 */
export const SENSITIVE_FIELD_DENYLIST = Object.freeze([
  "token",
  "apikey",
  "api_key",
  "secret",
  "password",
  "passwd",
  "authorization",
  "credential",
  "credentials",
  "auth",
  "bearer",
  "cookie",
  "sessionid",
  "session_id",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "privatekey",
  "private_key",
  "clientsecret",
  "client_secret",
  "githubtoken",
  "github_token",

  "openai_api_key",
  "openaiapikey",
]);

/** Sentinel value that replaces a redacted sensitive field. */
export const REDACTED = "[REDACTED]";

// ── Cross-agent span contract ─────────────────────────────────────────────────

/**
 * Cross-agent span contract for deterministic distributed tracing.
 *
 * Any agent MAY attach these fields to an event payload to form a traceable span.
 * Use buildSpanEvent() to stamp span context automatically onto event envelopes.
 *
 * fields           — canonical payload key names for span identity fields
 * stageTransition  — payload key names for PLANNING_STAGE_TRANSITION events
 * dropReason       — payload key names for PLANNING_TASK_DROPPED events
 * dropCodes        — canonical drop-reason machine codes
 */
export const SPAN_CONTRACT = Object.freeze({
  /** Span identity fields — present on every span-bearing event payload. */
  fields: Object.freeze({
    /** Unique identifier for this span (generated per event). */
    spanId:       "spanId",
    /** Parent span ID; null for root spans (first agent in a chain). */
    parentSpanId: "parentSpanId",
    /** Full-trace identifier — equals the event's correlationId. */
    traceId:      "traceId",
    /** Agent role that emitted this event (worker role, orchestrator, etc.). */
    agentId:      "agentId",
  }),

  /** Payload fields for PLANNING_STAGE_TRANSITION events. */
  stageTransition: Object.freeze({
    taskId:     "taskId",
    stageFrom:  "stageFrom",
    stageTo:    "stageTo",
    /** Wall-clock ms spent in stageFrom before transitioning; null if unknown. */
    durationMs: "durationMs",
  }),

  /** Payload fields for PLANNING_TASK_DROPPED events. */
  dropReason: Object.freeze({
    taskId:           "taskId",
    stageWhenDropped: "stageWhenDropped",
    /** Human-readable drop reason. */
    reason:           "reason",
    /** Machine-readable drop code from SPAN_CONTRACT.dropCodes. */
    dropCode:         "dropCode",
  }),

  /** Canonical drop-reason codes for PLANNING_TASK_DROPPED.dropCode. */
  dropCodes: Object.freeze({
    /** Plan was rejected by Athena reviewer before dispatch. */
    ATHENA_REJECTED:     "ATHENA_REJECTED",
    /** Governance freeze is active; plan not allowed to proceed. */
    GOVERNANCE_FREEZE:   "GOVERNANCE_FREEZE",
    /** Budget was exceeded; plan dropped to stay within cost limit. */
    BUDGET_EXCEEDED:     "BUDGET_EXCEEDED",
    /** Worker capacity was not available within the timeout. */
    CAPACITY_EXHAUSTED:  "CAPACITY_EXHAUSTED",
    /** Self-dev guard blocked the task (self-modification risk). */
    SELF_DEV_BLOCKED:    "SELF_DEV_BLOCKED",
    /** Generic/unclassified drop; provide human reason field for context. */
    UNCLASSIFIED:        "UNCLASSIFIED",
  }),
});

// ── Schema definition ─────────────────────────────────────────────────────────

/**
 * Canonical schema for every emitted event envelope.
 *
 * Required fields:
 *   event         — string matching EVENT_NAME_PATTERN, listed in VALID_EVENT_NAMES
 *   version       — integer, must equal EVENT_SCHEMA_VERSION
 *   correlationId — non-empty string (UUID or any opaque ID)
 *   timestamp     — ISO 8601 string
 *   domain        — one of EVENT_DOMAIN values
 *   payload       — plain object (may be empty)
 */
export const EVENT_SHAPE_SCHEMA = Object.freeze({
  required: Object.freeze(["event", "version", "correlationId", "timestamp", "domain", "payload"]),
  versionValue: EVENT_SCHEMA_VERSION,
  eventNamePattern: EVENT_NAME_PATTERN,
  domainEnum: Object.freeze(Object.values(EVENT_DOMAIN)),
  validEventNames: VALID_EVENT_NAMES,
});

// ── Error codes ───────────────────────────────────────────────────────────────

/**
 * Reason codes returned by validateEvent and emitEvent.
 * Callers MUST check the reason field; silent fallback is not allowed.
 */
export const EVENT_ERROR_CODE = Object.freeze({
  /** Input was null/undefined (missing entirely). */
  MISSING_INPUT:          "MISSING_INPUT",
  /** Required field absent from event envelope. */
  MISSING_FIELD:          "MISSING_FIELD",
  /** correlationId is present but empty. */
  EMPTY_CORRELATION_ID:   "EMPTY_CORRELATION_ID",
  /** event name does not match EVENT_NAME_PATTERN. */
  INVALID_EVENT_NAME:     "INVALID_EVENT_NAME",
  /** event name is not in VALID_EVENT_NAMES. */
  UNKNOWN_EVENT_NAME:     "UNKNOWN_EVENT_NAME",
  /** version field is not the expected integer. */
  WRONG_VERSION:          "WRONG_VERSION",
  /** domain field is not one of EVENT_DOMAIN values. */
  INVALID_DOMAIN:         "INVALID_DOMAIN",
  /** payload is not a plain object. */
  INVALID_PAYLOAD:        "INVALID_PAYLOAD",
  /** timestamp is not a parseable ISO 8601 string. */
  INVALID_TIMESTAMP:      "INVALID_TIMESTAMP",
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Redact all sensitive fields from a payload object (shallow, in-place on a copy).
 * Keys are compared case-insensitively against SENSITIVE_FIELD_DENYLIST.
 *
 * @param {object} payload
 * @returns {object} — new object with sensitive values replaced by REDACTED
 */
export function redactSensitiveFields(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    result[k] = SENSITIVE_FIELD_DENYLIST.includes(k.toLowerCase()) ? REDACTED : v;
  }
  return result;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate an event envelope against EVENT_SHAPE_SCHEMA.
 *
 * Distinguishes missing input from invalid input:
 *   - null/undefined input     → ok=false, code=MISSING_INPUT
 *   - missing required field   → ok=false, code=MISSING_FIELD,  field=<name>
 *   - empty correlationId      → ok=false, code=EMPTY_CORRELATION_ID
 *   - bad event name pattern   → ok=false, code=INVALID_EVENT_NAME
 *   - unknown event name       → ok=false, code=UNKNOWN_EVENT_NAME
 *   - wrong version            → ok=false, code=WRONG_VERSION
 *   - invalid domain           → ok=false, code=INVALID_DOMAIN
 *   - invalid payload type     → ok=false, code=INVALID_PAYLOAD
 *   - invalid timestamp        → ok=false, code=INVALID_TIMESTAMP
 *   - fully valid              → ok=true,  code=null
 *
 * @param {any} event
 * @returns {{ ok: boolean, code: string|null, field?: string, message: string }}
 */
export function validateEvent(event) {
  if (event === null || event === undefined) {
    return { ok: false, code: EVENT_ERROR_CODE.MISSING_INPUT, message: "event is required (got null/undefined)" };
  }
  if (typeof event !== "object" || Array.isArray(event)) {
    return { ok: false, code: EVENT_ERROR_CODE.MISSING_INPUT, message: "event must be a plain object" };
  }

  for (const field of EVENT_SHAPE_SCHEMA.required) {
    if (!(field in event)) {
      return { ok: false, code: EVENT_ERROR_CODE.MISSING_FIELD, field, message: `required field '${field}' is missing` };
    }
  }

  // correlationId must be a non-empty string
  if (typeof event.correlationId !== "string" || event.correlationId.trim() === "") {
    return { ok: false, code: EVENT_ERROR_CODE.EMPTY_CORRELATION_ID, message: "correlationId must be a non-empty string" };
  }

  // event name: pattern check first, then membership
  if (typeof event.event !== "string" || !EVENT_NAME_PATTERN.test(event.event)) {
    return {
      ok: false,
      code: EVENT_ERROR_CODE.INVALID_EVENT_NAME,
      message: `event name '${event.event}' does not match pattern ${EVENT_NAME_PATTERN}`
    };
  }
  if (!VALID_EVENT_NAMES.has(event.event)) {
    return {
      ok: false,
      code: EVENT_ERROR_CODE.UNKNOWN_EVENT_NAME,
      message: `event name '${event.event}' is not in the canonical EVENTS registry`
    };
  }

  // version must be EVENT_SCHEMA_VERSION integer
  if (event.version !== EVENT_SCHEMA_VERSION) {
    return {
      ok: false,
      code: EVENT_ERROR_CODE.WRONG_VERSION,
      message: `version must be ${EVENT_SCHEMA_VERSION}, got ${event.version}`
    };
  }

  // domain must be in EVENT_DOMAIN
  if (!EVENT_SHAPE_SCHEMA.domainEnum.includes(event.domain)) {
    return {
      ok: false,
      code: EVENT_ERROR_CODE.INVALID_DOMAIN,
      message: `domain '${event.domain}' is not one of: ${EVENT_SHAPE_SCHEMA.domainEnum.join(", ")}`
    };
  }

  // payload must be a plain object
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return { ok: false, code: EVENT_ERROR_CODE.INVALID_PAYLOAD, message: "payload must be a plain object" };
  }

  // timestamp must be parseable
  if (typeof event.timestamp !== "string" || isNaN(Date.parse(event.timestamp))) {
    return { ok: false, code: EVENT_ERROR_CODE.INVALID_TIMESTAMP, message: `timestamp '${event.timestamp}' is not a valid ISO 8601 string` };
  }

  return { ok: true, code: null, message: "valid" };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build a validated, redacted event envelope ready for emission.
 *
 * Throws if the resulting event fails schema validation.
 * Always redacts sensitive fields before returning.
 *
 * @param {string} eventName   — one of EVENTS values
 * @param {string} domain      — one of EVENT_DOMAIN values
 * @param {string} correlationId — non-empty opaque ID for this pipeline cycle
 * @param {object} [payload]   — event-specific data (will be redacted)
 * @returns {object}           — validated, redacted event envelope
 */
export function buildEvent(eventName: string, domain: string, correlationId: string, payload: Record<string, unknown> = {}) {
  const envelope = {
    event: eventName,
    version: EVENT_SCHEMA_VERSION,
    correlationId,
    timestamp: new Date().toISOString(),
    domain,
    payload: redactSensitiveFields(payload),
  };

  const result = validateEvent(envelope);
  if (!result.ok) {
    const err = new Error(`buildEvent: invalid event — ${result.message}`);
    (err as NodeJS.ErrnoException & { code?: string; field?: string }).code = result.code ?? undefined;
    (err as NodeJS.ErrnoException & { code?: string; field?: string }).field = result.field || null;
    throw err;
  }

  return envelope;
}

/**
 * Parse a raw value and determine if it is a well-formed typed event.
 * Safe to call on arbitrary input (never throws).
 *
 * Returns:
 *   { ok: true,  event: <envelope> }  — if valid
 *   { ok: false, code, message }       — if invalid (same shape as validateEvent)
 *
 * @param {any} raw
 * @returns {{ ok: boolean, event?: object, code?: string, message: string }}
 */
export function parseTypedEvent(raw) {
  if (raw === null || raw === undefined) {
    return { ok: false, code: EVENT_ERROR_CODE.MISSING_INPUT, message: "input is null/undefined" };
  }

  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, code: EVENT_ERROR_CODE.MISSING_INPUT, message: "input is not valid JSON" };
    }
  }

  const result = validateEvent(parsed);
  if (!result.ok) return result;
  return { ok: true, event: parsed, code: null, message: "valid" };
}

// ── Span helpers ──────────────────────────────────────────────────────────────

/**
 * Generate a new unique span ID using the Node.js crypto module.
 * Safe to call in any agent context — never throws.
 *
 * @returns {string} A UUID v4 string usable as a spanId.
 */
export function generateSpanId(): string {
  return randomUUID();
}

/**
 * Build a validated, redacted event envelope with cross-agent span fields stamped
 * onto the payload, conforming to SPAN_CONTRACT.fields.
 *
 * The traceId field is always set to correlationId.
 * spanId is auto-generated if not provided in spanContext.
 * parentSpanId and agentId default to null when absent.
 *
 * Throws (same as buildEvent) if the resulting envelope fails schema validation.
 *
 * @param {string} eventName    — one of EVENTS values
 * @param {string} domain       — one of EVENT_DOMAIN values
 * @param {string} correlationId — non-empty opaque trace ID for this pipeline cycle
 * @param {object} [spanContext] — span identity fields
 * @param {string} [spanContext.spanId]       — use existing spanId; auto-generated if absent
 * @param {string} [spanContext.parentSpanId] — parent span; null for root spans
 * @param {string} [spanContext.agentId]      — role/agent identifier
 * @param {object} [payload]    — event-specific data (will be redacted; merged with span fields)
 * @returns {object}            — validated, redacted event envelope with span fields in payload
 */
export function buildSpanEvent(
  eventName: string,
  domain: string,
  correlationId: string,
  spanContext: { spanId?: string; parentSpanId?: string | null; agentId?: string | null } = {},
  payload: Record<string, unknown> = {},
) {
  const spanId = (typeof spanContext.spanId === "string" && spanContext.spanId.length > 0)
    ? spanContext.spanId
    : generateSpanId();

  return buildEvent(eventName, domain, correlationId, {
    ...payload,
    [SPAN_CONTRACT.fields.spanId]:       spanId,
    [SPAN_CONTRACT.fields.parentSpanId]: spanContext.parentSpanId ?? null,
    [SPAN_CONTRACT.fields.traceId]:      correlationId,
    [SPAN_CONTRACT.fields.agentId]:      spanContext.agentId ?? null,
  });
}

