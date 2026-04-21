/**
 * trust_boundary.test.ts — Tests for T-036 trust-boundary linter.
 *
 * Verifies:
 *  - Schema artifact exists and loads correctly (AC1)
 *  - All contract types validate required fields (AC3)
 *  - Malformed and adversarial outputs produce TRUST_BOUNDARY_ERROR + explicit reason (AC2, AC5)
 *  - Invalid critical contract fields BLOCK downstream execution (AC3, negative path)
 *  - Error entries include payloadPath and sourceFile anchors (AC4)
 *  - Missing input is distinguished from invalid input (AC9)
 *  - No silent fallback — ok=false always sets status=blocked (AC10)
 *  - Retry strategy constants are deterministic (AC2)
 *  - Warn mode downgrades hard failures (rollback path)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  validateLeadershipContract,
  LEADERSHIP_CONTRACT_TYPE,
  TRUST_BOUNDARY_ERROR,
  TRUST_BOUNDARY_RETRY,
  TRUST_BOUNDARY_REASON,
  LEADERSHIP_SCHEMA_PATH,
  trustBoundaryRetryDelayMs,
  tagProviderDecision,
  MEMORY_TRUST_LEVEL,
  MEMORY_TRUST_SOURCE,
  classifyMemoryTrust,
  normalizeMemoryTrustMetadata,
  filterMemoryEntriesByTrust,
  isPrivilegedMemoryRequester,
  buildMemoryHitRecord,
} from "../../src/core/trust_boundary.js";

// ── Schema artifact ───────────────────────────────────────────────────────────

describe("AC1 — schema artifact", () => {
  it("schema file exists at src/schemas/leadership.schema.json", async () => {
    const exists = await fs.access(LEADERSHIP_SCHEMA_PATH).then(() => true).catch(() => false);
    assert.ok(exists, `Schema file must exist at: ${LEADERSHIP_SCHEMA_PATH}`);
  });

  it("schema file is valid JSON with contracts for planner, reviewer, supervisor", async () => {
    const raw = await fs.readFile(LEADERSHIP_SCHEMA_PATH, "utf8");
    const schema = JSON.parse(raw);
    assert.ok(schema.contracts, "schema must have a contracts object");
    assert.ok(schema.contracts.planner,   "schema must define planner contract");
    assert.ok(schema.contracts.reviewer,  "schema must define reviewer contract");
    assert.ok(schema.contracts.supervisor,"schema must define supervisor contract");
  });

  it("schema has schemaVersion field for future migration tracking", async () => {
    const raw = await fs.readFile(LEADERSHIP_SCHEMA_PATH, "utf8");
    const schema = JSON.parse(raw);
    assert.ok(typeof schema.schemaVersion === "number", "schemaVersion must be a number");
  });
});

// ── Failure class ─────────────────────────────────────────────────────────────

describe("AC2 — failure class and retry strategy", () => {
  it("TRUST_BOUNDARY_ERROR is a non-empty string", () => {
    assert.ok(typeof TRUST_BOUNDARY_ERROR === "string" && TRUST_BOUNDARY_ERROR.length > 0,
      "TRUST_BOUNDARY_ERROR must be a non-empty string");
  });

  it("TRUST_BOUNDARY_ERROR equals 'trust_boundary_violation'", () => {
    assert.equal(TRUST_BOUNDARY_ERROR, "trust_boundary_violation");
  });

  it("TRUST_BOUNDARY_RETRY has maxRetries=3", () => {
    assert.equal(TRUST_BOUNDARY_RETRY.maxRetries, 3);
  });

  it("TRUST_BOUNDARY_RETRY has delayMs=5000", () => {
    assert.equal(TRUST_BOUNDARY_RETRY.delayMs, 5000);
  });

  it("TRUST_BOUNDARY_RETRY backoff is 'exponential'", () => {
    assert.equal(TRUST_BOUNDARY_RETRY.backoff, "exponential");
  });

  it("TRUST_BOUNDARY_RETRY multiplier is 2", () => {
    assert.equal(TRUST_BOUNDARY_RETRY.multiplier, 2);
  });

  it("TRUST_BOUNDARY_RETRY escalationTarget is defined", () => {
    assert.ok(TRUST_BOUNDARY_RETRY.escalationTarget, "escalationTarget must be defined");
  });

  it("trustBoundaryRetryDelayMs(1) returns initial delayMs", () => {
    assert.equal(trustBoundaryRetryDelayMs(1), 5000);
  });

  it("trustBoundaryRetryDelayMs(2) returns delayMs × multiplier", () => {
    assert.equal(trustBoundaryRetryDelayMs(2), 10000);
  });

  it("trustBoundaryRetryDelayMs(3) returns delayMs × multiplier²", () => {
    assert.equal(trustBoundaryRetryDelayMs(3), 20000);
  });
});

// ── Reason codes ──────────────────────────────────────────────────────────────

describe("TRUST_BOUNDARY_REASON codes", () => {
  it("exports all expected reason codes", () => {
    const expected = ["OK", "MISSING_INPUT", "INVALID_TYPE", "MISSING_FIELD", "INVALID_FIELD", "UNKNOWN_CONTRACT_TYPE", "SCHEMA_LOAD_ERROR"];
    for (const code of expected) {
      assert.ok(TRUST_BOUNDARY_REASON[code], `TRUST_BOUNDARY_REASON.${code} must be defined`);
    }
  });
});

// ── AC9: Missing input vs invalid input ───────────────────────────────────────

describe("AC9 — missing vs invalid input distinction", () => {
  it("null payload → reasonCode=MISSING_INPUT (not INVALID_TYPE)", () => {
    const result = validateLeadershipContract("planner", null);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, TRUST_BOUNDARY_REASON.MISSING_INPUT,
      "null payload must be MISSING_INPUT, not INVALID_TYPE");
  });

  it("undefined payload → reasonCode=MISSING_INPUT", () => {
    const result = validateLeadershipContract("planner", undefined);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, TRUST_BOUNDARY_REASON.MISSING_INPUT);
  });

  it("array payload → reasonCode=INVALID_TYPE (not MISSING_INPUT)", () => {
    const result = validateLeadershipContract("planner", []);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, TRUST_BOUNDARY_REASON.INVALID_TYPE,
      "array payload must be INVALID_TYPE, not MISSING_INPUT");
  });

  it("string payload → reasonCode=INVALID_TYPE", () => {
    const result = validateLeadershipContract("planner", "malicious string");
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, TRUST_BOUNDARY_REASON.INVALID_TYPE);
  });

  it("object missing required field → reasonCode=MISSING_FIELD (not INVALID_TYPE)", () => {
    const result = validateLeadershipContract("reviewer", { approved: true });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, TRUST_BOUNDARY_REASON.MISSING_FIELD,
      "object with missing field must be MISSING_FIELD, not INVALID_TYPE");
  });

  it("object with wrong field type → reasonCode=INVALID_FIELD", () => {
    const result = validateLeadershipContract("reviewer", {
      approved: "yes",  // should be boolean
      corrections: [],
      planReviews: []
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, TRUST_BOUNDARY_REASON.INVALID_FIELD,
      "wrong type on required field must be INVALID_FIELD");
  });
});

// ── AC10: No silent fallback ──────────────────────────────────────────────────

describe("AC10 — no silent fallback for critical state", () => {
  it("ok=false always sets status=blocked in enforce mode", () => {
    const cases = [
      validateLeadershipContract("planner", null),
      validateLeadershipContract("planner", "bad"),
      validateLeadershipContract("planner", {}),
      validateLeadershipContract("reviewer", { approved: "bad", corrections: [], planReviews: [] }),
    ];
    for (const result of cases) {
      assert.equal(result.ok, false);
      assert.equal(result.status, "blocked",
        `status must be 'blocked' when ok=false (got '${result.status}')`);
    }
  });

  it("ok=false never has empty errors array", () => {
    const result = validateLeadershipContract("planner", null);
    assert.ok(Array.isArray(result.errors), "errors must be an array");
    assert.ok(result.errors.length > 0, "errors must be non-empty when ok=false");
  });

  it("ok=true always sets status=ok", () => {
    const validReviewer = { approved: true, corrections: [], planReviews: [] };
    const result = validateLeadershipContract("reviewer", validReviewer);
    assert.equal(result.ok, true);
    assert.equal(result.status, "ok");
  });
});

// ── AC3 & AC4: Critical contract fields + payload path anchors ────────────────

describe("AC3 — planner contract (Prometheus) critical fields", () => {
  const VALID_PLANNER = {
    plans: [{ role: "King David", task: "Fix bug", priority: 1, wave: "wave-1", verification: "npm test" }],
    analysis: "Comprehensive analysis",
    projectHealth: "good",
    executionStrategy: {},
    requestBudget: {}
  };

  it("valid planner payload passes", () => {
    const result = validateLeadershipContract("planner", VALID_PLANNER);
    assert.equal(result.ok, true, `Expected ok=true, got errors: ${JSON.stringify(result.errors)}`);
  });

  it("missing plans field blocks execution", () => {
    const { plans, ...payload } = VALID_PLANNER;
    const result = validateLeadershipContract("planner", payload);
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    const fieldError = result.errors.find(e => e.field === "plans");
    assert.ok(fieldError, "error must reference the 'plans' field");
  });

  it("missing analysis field blocks execution", () => {
    const { analysis, ...payload } = VALID_PLANNER;
    const result = validateLeadershipContract("planner", payload);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.field === "analysis"), "error must reference 'analysis'");
  });

  it("invalid projectHealth enum blocks execution", () => {
    const result = validateLeadershipContract("planner", { ...VALID_PLANNER, projectHealth: "unknown-value" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.field === "projectHealth"), "error must reference 'projectHealth'");
  });

  it("empty plans array blocks execution (minItems=1)", () => {
    const result = validateLeadershipContract("planner", { ...VALID_PLANNER, plans: [] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.field === "plans"), "error must reference 'plans'");
  });

  it("plan item missing required field (role) is reported", () => {
    const plans = [{ task: "Fix bug", priority: 1, wave: "wave-1", verification: "npm test" }]; // missing role
    const result = validateLeadershipContract("planner", { ...VALID_PLANNER, plans });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.payloadPath.includes("role")), "error must include payloadPath referencing role");
  });

  it("wave field accepts string value (oneOf)", () => {
    const plans = [{ role: "test-worker", task: "Fix bug", priority: 1, wave: "wave-1", verification: "npm test" }];
    const result = validateLeadershipContract("planner", { ...VALID_PLANNER, plans });
    assert.equal(result.ok, true, "wave as string must pass");
  });

  it("wave field accepts integer value (oneOf)", () => {
    const plans = [{ role: "test-worker", task: "Fix bug", priority: 1, wave: 2, verification: "npm test" }];
    const result = validateLeadershipContract("planner", { ...VALID_PLANNER, plans });
    assert.equal(result.ok, true, "wave as integer must pass");
  });

  it("wave field rejects boolean (oneOf)", () => {
    const plans = [{ role: "test-worker", task: "Fix bug", priority: 1, wave: true, verification: "npm test" }];
    const result = validateLeadershipContract("planner", { ...VALID_PLANNER, plans });
    assert.equal(result.ok, false, "wave as boolean must fail");
  });

  it("error entries have payloadPath and sourceFile (AC4)", () => {
    const { plans, ...payload } = VALID_PLANNER;
    const result = validateLeadershipContract("planner", payload);
    for (const err of result.errors) {
      assert.ok(typeof err.payloadPath === "string" && err.payloadPath.length > 0,
        "each error must have a payloadPath string");
      assert.ok(typeof err.sourceFile === "string" && err.sourceFile.length > 0,
        "each error must have a sourceFile string (schema anchor)");
    }
  });
});

describe("AC3 — reviewer contract (Athena) critical fields", () => {
  const VALID_REVIEWER = { approved: true, corrections: [], planReviews: [] };

  it("valid reviewer payload passes", () => {
    const result = validateLeadershipContract("reviewer", VALID_REVIEWER);
    assert.equal(result.ok, true);
  });

  it("missing approved field blocks execution", () => {
    const { approved, ...payload } = VALID_REVIEWER;
    const result = validateLeadershipContract("reviewer", payload);
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
  });

  it("approved field must be boolean not string", () => {
    const result = validateLeadershipContract("reviewer", { ...VALID_REVIEWER, approved: "true" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.field === "approved"), "must flag 'approved' field");
  });

  it("missing corrections field blocks execution", () => {
    const { corrections, ...payload } = VALID_REVIEWER;
    const result = validateLeadershipContract("reviewer", payload);
    assert.equal(result.ok, false);
  });

  it("corrections must be array not string", () => {
    const result = validateLeadershipContract("reviewer", { ...VALID_REVIEWER, corrections: "fix things" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.field === "corrections"), "must flag 'corrections'");
  });
});

describe("AC3 — supervisor contract (Janus) critical fields", () => {
  const VALID_SUPERVISOR = {
    decision: "tactical",
    wakeAthena: true,
    callPrometheus: false,
    briefForPrometheus: "Proceed with planned work",
    systemHealth: "good"
  };

  it("valid supervisor payload passes", () => {
    const result = validateLeadershipContract("supervisor", VALID_SUPERVISOR);
    assert.equal(result.ok, true);
  });

  it("missing decision field blocks execution", () => {
    const { decision, ...payload } = VALID_SUPERVISOR;
    const result = validateLeadershipContract("supervisor", payload);
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
  });

  it("decision must be valid enum value", () => {
    const result = validateLeadershipContract("supervisor", { ...VALID_SUPERVISOR, decision: "DOMINATE" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.field === "decision"), "must flag 'decision' enum violation");
  });

  it("wakeAthena must be boolean", () => {
    const result = validateLeadershipContract("supervisor", { ...VALID_SUPERVISOR, wakeAthena: 1 });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.field === "wakeAthena"), "must flag 'wakeAthena'");
  });

  it("callPrometheus must be boolean", () => {
    const result = validateLeadershipContract("supervisor", { ...VALID_SUPERVISOR, callPrometheus: "yes" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.field === "callPrometheus"), "must flag 'callPrometheus'");
  });

  it("missing briefForPrometheus blocks execution", () => {
    const { briefForPrometheus, ...payload } = VALID_SUPERVISOR;
    const result = validateLeadershipContract("supervisor", payload);
    assert.equal(result.ok, false);
  });
});

// ── AC5: Malformed and adversarial outputs ────────────────────────────────────

describe("AC5 — malformed and adversarial outputs", () => {
  it("prototype pollution attempt is blocked (invalid type)", () => {
    // JSON.parse cannot produce prototype pollution but adversarial object would be blocked
    const payload = Object.create(null);
    payload.approved = true;
    // Object.create(null) has no prototype — still a valid object for our purposes,
    // but missing required fields is what we're testing
    const result = validateLeadershipContract("reviewer", payload);
    assert.equal(result.ok, false, "Object with missing fields must not pass");
  });

  it("numeric payload is blocked as INVALID_TYPE", () => {
    const result = validateLeadershipContract("supervisor", 42);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, TRUST_BOUNDARY_REASON.INVALID_TYPE);
  });

  it("boolean payload is blocked as INVALID_TYPE", () => {
    const result = validateLeadershipContract("planner", true);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, TRUST_BOUNDARY_REASON.INVALID_TYPE);
  });

  it("nested adversarial value in plans array is flagged", () => {
    const result = validateLeadershipContract("planner", {
      plans: [null],  // null item instead of object
      analysis: "test",
      projectHealth: "good",
      executionStrategy: {},
      requestBudget: {}
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.payloadPath.includes("plans[0]")), "must report error at plans[0]");
  });

  it("extremely long string for analysis still passes type check", () => {
    const result = validateLeadershipContract("planner", {
      plans: [{ role: "r", task: "t", priority: 1, wave: "w", verification: "v" }],
      analysis: "A".repeat(100000),
      projectHealth: "good",
      executionStrategy: {},
      requestBudget: {}
    });
    assert.equal(result.ok, true, "Long but valid strings must not be blocked");
  });

  it("unknown contract type is blocked with UNKNOWN_CONTRACT_TYPE reason", () => {
    const result = validateLeadershipContract("adversary", { anything: true });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, TRUST_BOUNDARY_REASON.UNKNOWN_CONTRACT_TYPE);
    assert.equal(result.status, "blocked");
  });
});

// ── Rollback path: warn mode ──────────────────────────────────────────────────

describe("rollback path — warn mode", () => {
  it("warn mode sets status=warn instead of blocked on failure", () => {
    const result = validateLeadershipContract("planner", null, { mode: "warn" });
    assert.equal(result.ok, false);
    assert.equal(result.status, "warn",
      "warn mode must set status=warn, not blocked");
  });

  it("warn mode still returns ok=false and non-empty errors", () => {
    const result = validateLeadershipContract("reviewer", {}, { mode: "warn" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0, "errors must still be populated in warn mode");
  });

  it("enforce mode (default) sets status=blocked", () => {
    const result = validateLeadershipContract("planner", null);
    assert.equal(result.status, "blocked");
  });
});

// ── LEADERSHIP_CONTRACT_TYPE enum ─────────────────────────────────────────────

describe("LEADERSHIP_CONTRACT_TYPE enum", () => {
  it("exports PLANNER, REVIEWER, SUPERVISOR constants", () => {
    assert.equal(LEADERSHIP_CONTRACT_TYPE.PLANNER,    "planner");
    assert.equal(LEADERSHIP_CONTRACT_TYPE.REVIEWER,   "reviewer");
    assert.equal(LEADERSHIP_CONTRACT_TYPE.SUPERVISOR, "supervisor");
  });
});

// ── Negative path: execution must be BLOCKED on invalid critical fields ───────

describe("AC14 negative path — execution blocked on invalid input (not just warned)", () => {
  it("supervisor payload with missing decision returns ok=false and status=blocked", () => {
    // This is the critical negative path: invalid supervisor output must BLOCK execution
    const badPayload = {
      // decision is missing
      wakeAthena: true,
      callPrometheus: false,
      briefForPrometheus: "Do something",
      systemHealth: "good"
    };
    const result = validateLeadershipContract(LEADERSHIP_CONTRACT_TYPE.SUPERVISOR, badPayload);
    assert.equal(result.ok, false, "must not pass with missing 'decision'");
    assert.equal(result.status, "blocked", "status must be 'blocked', not a warning");
    assert.ok(result.errors.some(e => e.field === "decision" && e.reasonCode === TRUST_BOUNDARY_REASON.MISSING_FIELD),
      "errors must include a MISSING_FIELD entry for 'decision'");
  });

  it("planner payload with null plans returns ok=false and status=blocked", () => {
    const badPayload = {
      plans: null,  // invalid — must be an array
      analysis: "valid analysis",
      projectHealth: "good",
      executionStrategy: {},
      requestBudget: {}
    };
    const result = validateLeadershipContract(LEADERSHIP_CONTRACT_TYPE.PLANNER, badPayload);
    assert.equal(result.ok, false, "null plans must block execution");
    assert.equal(result.status, "blocked");
  });

  it("reviewer payload with approved=null returns ok=false and blocks", () => {
    const badPayload = { approved: null, corrections: [], planReviews: [] };
    const result = validateLeadershipContract(LEADERSHIP_CONTRACT_TYPE.REVIEWER, badPayload);
    assert.equal(result.ok, false, "null approved must block");
    assert.equal(result.status, "blocked");
  });
});

// -- tagProviderDecision ---------------------------------------------------------

describe("tagProviderDecision -- explicit fallback tagging at trust boundary", () => {
  it("tags a provider decision with _source='provider'", () => {
    const decision = { approved: true, reason: "all gates passed" };
    const tagged = tagProviderDecision(decision, "provider");
    assert.equal(tagged._source, "provider");
    assert.equal(tagged.approved, true);
    assert.equal(tagged.reason, "all gates passed");
  });

  it("tags a fallback decision with _source='fallback'", () => {
    const fallback = { approved: false, reason: "deterministic fallback" };
    const tagged = tagProviderDecision(fallback, "fallback");
    assert.equal(tagged._source, "fallback");
    assert.equal(tagged.approved, false);
    assert.equal(tagged.reason, "deterministic fallback");
  });

  it("preserves all original fields from the decision", () => {
    const decision = { approved: true, reason: "ok", model: "claude-sonnet-4-6", taskId: 42 };
    const tagged = tagProviderDecision(decision, "provider");
    assert.equal(tagged.model, "claude-sonnet-4-6");
    assert.equal(tagged.taskId, 42);
    assert.equal(tagged._source, "provider");
  });

  it("does not mutate the original decision object", () => {
    const decision = { approved: true, reason: "ok" };
    tagProviderDecision(decision, "provider");
    assert.equal((decision as any)._source, undefined, "original must not be mutated");
  });

  it("tags allowOpus decisions correctly", () => {
    const decision = { allowOpus: false, reason: "fallback no escalation" };
    const tagged = tagProviderDecision(decision, "fallback");
    assert.equal(tagged._source, "fallback");
    assert.equal(tagged.allowOpus, false);
  });

  it("source='fallback' is distinguishable from source='provider'", () => {
    const d = { approved: false, reason: "gates failed" };
    const fromFallback = tagProviderDecision(d, "fallback");
    const fromProvider = tagProviderDecision(d, "provider");
    assert.notEqual(fromFallback._source, fromProvider._source);
  });

  it("attaches _fallbackReason when source='fallback' and reason is provided (T3)", () => {
    const fallback = { approved: false, reason: "deterministic fallback" };
    const tagged = tagProviderDecision(fallback, "fallback", "API 429 rate limit");
    assert.equal(tagged._source, "fallback");
    assert.equal(tagged._fallbackReason, "API 429 rate limit");
  });

  it("omits _fallbackReason when source='provider' (T3)", () => {
    const decision = { approved: true, reason: "ok" };
    const tagged = tagProviderDecision(decision, "provider");
    assert.equal(tagged._source, "provider");
    assert.equal((tagged as any)._fallbackReason, undefined, "_fallbackReason must not appear on provider-source tags");
  });

  it("omits _fallbackReason when fallbackReason is not passed (T3)", () => {
    const fallback = { approved: false, reason: "deterministic" };
    const tagged = tagProviderDecision(fallback, "fallback");
    assert.equal(tagged._source, "fallback");
    assert.equal((tagged as any)._fallbackReason, undefined, "_fallbackReason must be absent when not supplied");
  });

  it("negative: fallback without reason still has _source='fallback' (T3)", () => {
    const fallback = { approved: false, reason: "no api key" };
    const tagged = tagProviderDecision(fallback, "fallback");
    assert.equal(tagged._source, "fallback");
    // Should pass gates check: source is machine-readable
    assert.ok(["provider", "fallback"].includes(tagged._source));
  });
});

// ── Memory trust classification ───────────────────────────────────────────────

describe("MEMORY_TRUST_LEVEL and MEMORY_TRUST_SOURCE constants", () => {
  it("MEMORY_TRUST_LEVEL exports HIGH, MEDIUM, LOW", () => {
    assert.equal(MEMORY_TRUST_LEVEL.HIGH, "high");
    assert.equal(MEMORY_TRUST_LEVEL.MEDIUM, "medium");
    assert.equal(MEMORY_TRUST_LEVEL.LOW, "low");
  });

  it("MEMORY_TRUST_SOURCE exports SYSTEM, MODEL, USER_MEDIATED", () => {
    assert.equal(MEMORY_TRUST_SOURCE.SYSTEM, "system");
    assert.equal(MEMORY_TRUST_SOURCE.MODEL, "model");
    assert.equal(MEMORY_TRUST_SOURCE.USER_MEDIATED, "user-mediated");
  });
});

describe("classifyMemoryTrust", () => {
  it("classifies system source as HIGH trust", () => {
    const result = classifyMemoryTrust({ source: "system", sourceType: "system" });
    assert.equal(result.level, MEMORY_TRUST_LEVEL.HIGH);
    assert.equal(result.source, MEMORY_TRUST_SOURCE.SYSTEM);
  });

  it("classifies deterministic source as HIGH trust", () => {
    const result = classifyMemoryTrust({ source: "deterministic-signal" });
    assert.equal(result.level, MEMORY_TRUST_LEVEL.HIGH);
  });

  it("classifies user-mediated source as LOW trust", () => {
    const result = classifyMemoryTrust({ sourceType: "user-mediated" });
    assert.equal(result.level, MEMORY_TRUST_LEVEL.LOW);
    assert.equal(result.source, MEMORY_TRUST_SOURCE.USER_MEDIATED);
  });

  it("classifies explicit isUserMediated=true as LOW trust", () => {
    const result = classifyMemoryTrust({ isUserMediated: true });
    assert.equal(result.level, MEMORY_TRUST_LEVEL.LOW);
  });

  it("classifies free-text 'comment' source as LOW trust (user-mediated hint)", () => {
    const result = classifyMemoryTrust({ source: "github_comment" });
    assert.equal(result.level, MEMORY_TRUST_LEVEL.LOW);
  });

  it("classifies model source as MEDIUM trust", () => {
    const result = classifyMemoryTrust({ source: "prometheus-output" });
    assert.equal(result.level, MEMORY_TRUST_LEVEL.MEDIUM);
    assert.equal(result.source, MEMORY_TRUST_SOURCE.MODEL);
  });

  it("always returns taggedAt as ISO string", () => {
    const result = classifyMemoryTrust({ source: "model" });
    assert.ok(typeof result.taggedAt === "string" && result.taggedAt.length > 0);
  });
});

describe("normalizeMemoryTrustMetadata", () => {
  it("returns existing trust metadata when valid", () => {
    const entry = {
      trust: { level: "high", source: "system", reason: "verified", taggedAt: "2024-01-01T00:00:00Z" },
    };
    const result = normalizeMemoryTrustMetadata(entry);
    assert.equal(result.level, "high");
    assert.equal(result.source, "system");
  });

  it("classifies when trust field is absent", () => {
    const entry = { hint: "use path.join", source: "system" };
    const result = normalizeMemoryTrustMetadata(entry);
    assert.ok(["high", "medium", "low"].includes(result.level));
  });

  it("classifies when trust level is invalid string", () => {
    const entry = { trust: { level: "ultra-high", source: "system" } };
    const result = normalizeMemoryTrustMetadata(entry);
    // Falls back to classifyMemoryTrust → system source → HIGH
    assert.equal(result.level, "high");
  });

  it("returns a valid trust object even for empty input", () => {
    const result = normalizeMemoryTrustMetadata({});
    assert.ok(result.level);
    assert.ok(result.source);
  });
});

describe("filterMemoryEntriesByTrust", () => {
  const highEntry = { hint: "high", trust: { level: "high", source: "system", reason: "deterministic", taggedAt: "2024-01-01T00:00:00Z" } };
  const mediumEntry = { hint: "medium", trust: { level: "medium", source: "model", reason: "model-produced", taggedAt: "2024-01-01T00:00:00Z" } };
  const lowEntry = { hint: "low", trust: { level: "low", source: "user-mediated", reason: "free text", taggedAt: "2024-01-01T00:00:00Z" } };

  it("returns HIGH and MEDIUM entries by default, drops LOW", () => {
    const { selected, droppedLowTrustCount } = filterMemoryEntriesByTrust([highEntry, mediumEntry, lowEntry]);
    assert.equal(selected.length, 2);
    assert.equal(droppedLowTrustCount, 1);
    assert.ok(!selected.some(e => e.trust.level === "low"));
  });

  it("sorts results HIGH first, then MEDIUM", () => {
    const { selected } = filterMemoryEntriesByTrust([mediumEntry, highEntry]);
    assert.equal(selected[0].trust.level, "high");
    assert.equal(selected[1].trust.level, "medium");
  });

  it("includes LOW trust when privilegedCaller=true and includeLowTrust=true", () => {
    const { selected, droppedLowTrustCount } = filterMemoryEntriesByTrust(
      [highEntry, mediumEntry, lowEntry],
      { includeLowTrust: true, privilegedCaller: true },
    );
    assert.equal(selected.length, 3);
    assert.equal(droppedLowTrustCount, 0);
  });

  it("does NOT include LOW trust when privilegedCaller=false (even if includeLowTrust=true)", () => {
    // includeLowTrust requires both flags to be true
    const { selected, droppedLowTrustCount } = filterMemoryEntriesByTrust(
      [lowEntry],
      { includeLowTrust: true, privilegedCaller: false },
    );
    assert.equal(selected.length, 0);
    assert.equal(droppedLowTrustCount, 1);
  });

  it("handles empty array input safely", () => {
    const { selected, droppedLowTrustCount } = filterMemoryEntriesByTrust([]);
    assert.equal(selected.length, 0);
    assert.equal(droppedLowTrustCount, 0);
  });

  it("annotates entries without trust field via normalizeMemoryTrustMetadata", () => {
    const rawEntry = { hint: "do not hardcode paths", source: "system" };
    const { selected } = filterMemoryEntriesByTrust([rawEntry]);
    assert.equal(selected.length, 1);
    assert.ok(selected[0].trust, "entry must have trust metadata after filtering");
  });

  it("negative: non-array input returns empty selection without throwing", () => {
    const { selected, droppedLowTrustCount } = filterMemoryEntriesByTrust(null as any);
    assert.equal(selected.length, 0);
    assert.equal(droppedLowTrustCount, 0);
  });
});

describe("isPrivilegedMemoryRequester", () => {
  it("returns true for 'janus'", () => {
    assert.equal(isPrivilegedMemoryRequester("janus"), true);
  });

  it("returns true for 'governance' (lane key)", () => {
    assert.equal(isPrivilegedMemoryRequester("governance"), true);
  });

  it("returns true for 'system'", () => {
    assert.equal(isPrivilegedMemoryRequester("system"), true);
  });

  it("returns true for 'orchestratornoveltygate'", () => {
    assert.equal(isPrivilegedMemoryRequester("orchestratornoveltygate"), true);
  });

  it("returns false for 'evolution' (non-privileged worker kind)", () => {
    assert.equal(isPrivilegedMemoryRequester("evolution"), false);
  });

  it("returns false for 'quality' (non-privileged worker kind)", () => {
    assert.equal(isPrivilegedMemoryRequester("quality"), false);
  });

  it("returns false for null/undefined", () => {
    assert.equal(isPrivilegedMemoryRequester(null), false);
    assert.equal(isPrivilegedMemoryRequester(undefined), false);
  });

  it("is case-insensitive (uppercase 'JANUS')", () => {
    assert.equal(isPrivilegedMemoryRequester("JANUS"), true);
  });
});

// ── buildMemoryHitRecord ──────────────────────────────────────────────────────

describe("buildMemoryHitRecord", () => {
  it("returns an object with the required shape", () => {
    const record = buildMemoryHitRecord({ taskId: "t1", hintsInjected: 2, lessonsInjected: 1, droppedLowTrust: 0, isPrivileged: false });
    assert.equal(record.taskId, "t1");
    assert.equal(record.hintsInjected, 2);
    assert.equal(record.lessonsInjected, 1);
    assert.equal(record.droppedLowTrust, 0);
    assert.equal(record.isPrivileged, false);
    assert.equal(record.outcome, null, "outcome must be null before dispatch");
    assert.ok(typeof record.recordedAt === "string" && record.recordedAt.length > 0, "recordedAt must be a non-empty string");
  });

  it("outcome is null before dispatch", () => {
    const record = buildMemoryHitRecord({ taskId: "t2", hintsInjected: 0, lessonsInjected: 0, droppedLowTrust: 0, isPrivileged: false });
    assert.equal(record.outcome, null);
  });

  it("hintsInjected is clamped to >= 0", () => {
    const record = buildMemoryHitRecord({ taskId: "t3", hintsInjected: -5, lessonsInjected: 0, droppedLowTrust: 0, isPrivileged: false });
    assert.ok(record.hintsInjected >= 0, "hintsInjected must not be negative");
  });

  it("lessonsInjected is clamped to >= 0", () => {
    const record = buildMemoryHitRecord({ taskId: "t4", hintsInjected: 0, lessonsInjected: -3, droppedLowTrust: 0, isPrivileged: false });
    assert.ok(record.lessonsInjected >= 0, "lessonsInjected must not be negative");
  });

  it("isPrivileged reflects the input value", () => {
    const privileged = buildMemoryHitRecord({ taskId: "t5", hintsInjected: 1, lessonsInjected: 0, droppedLowTrust: 0, isPrivileged: true });
    assert.equal(privileged.isPrivileged, true);
    const nonPrivileged = buildMemoryHitRecord({ taskId: "t6", hintsInjected: 1, lessonsInjected: 0, droppedLowTrust: 0, isPrivileged: false });
    assert.equal(nonPrivileged.isPrivileged, false);
  });

  it("recordedAt is an ISO 8601 string", () => {
    const record = buildMemoryHitRecord({ taskId: "t7", hintsInjected: 1, lessonsInjected: 0, droppedLowTrust: 0, isPrivileged: false });
    assert.doesNotThrow(() => new Date(record.recordedAt), "recordedAt must be parseable as a Date");
    assert.ok(record.recordedAt.includes("T"), "recordedAt must be in ISO 8601 format");
  });

  it("negative path: missing taskId falls back to null", () => {
    const record = buildMemoryHitRecord({ hintsInjected: 1, lessonsInjected: 0, droppedLowTrust: 0, isPrivileged: false } as any);
    assert.equal(record.taskId, null, "taskId must be null when not provided");
  });
});

