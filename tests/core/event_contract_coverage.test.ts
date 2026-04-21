/**
 * tests/core/event_contract_coverage.test.ts
 *
 * Contract tests for the three new typed events added to event_schema.ts:
 *   - POLICY_MODEL_ROUTED
 *   - POLICY_RETRY_SUPPRESSED
 *   - POLICY_REROUTE_PENALTY_APPLIED
 *
 * Coverage:
 *   - Each new event is registered in EVENTS catalog and VALID_EVENT_NAMES
 *   - Each new event matches EVENT_NAME_PATTERN (box.v1.<domain>.<action>)
 *   - Each new event belongs to EVENT_DOMAIN.POLICY
 *   - buildEvent works for all three new events
 *   - validateEvent accepts correctly-constructed events
 *   - Missing-event detection: unknown event names are rejected by consumeTypedEvent
 *   - Governance block event already in catalog (regression guard)
 *   - Negative paths: missing correlationId, wrong domain rejected
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EVENTS,
  EVENT_DOMAIN,
  VALID_EVENT_NAMES,
  EVENT_NAME_PATTERN,
  buildEvent,
  validateEvent,
  EVENT_ERROR_CODE,
} from "../../src/core/event_schema.js";

import {
  consumeTypedEvent,
} from "../../src/dashboard/live_dashboard.ts";

// ── POLICY_MODEL_ROUTED ───────────────────────────────────────────────────────

describe("EVENTS.POLICY_MODEL_ROUTED", () => {
  it("is present in EVENTS catalog", () => {
    assert.ok("POLICY_MODEL_ROUTED" in EVENTS, "POLICY_MODEL_ROUTED key missing from EVENTS");
  });

  it("value is present in VALID_EVENT_NAMES", () => {
    assert.ok(
      VALID_EVENT_NAMES.has(EVENTS.POLICY_MODEL_ROUTED),
      `VALID_EVENT_NAMES does not contain '${EVENTS.POLICY_MODEL_ROUTED}'`
    );
  });

  it("value matches EVENT_NAME_PATTERN", () => {
    assert.match(EVENTS.POLICY_MODEL_ROUTED, EVENT_NAME_PATTERN);
  });

  it("value starts with box.v1.policy", () => {
    assert.ok(EVENTS.POLICY_MODEL_ROUTED.startsWith("box.v1.policy"));
  });

  it("buildEvent builds a valid event with POLICY domain", () => {
    const evt = buildEvent(
      EVENTS.POLICY_MODEL_ROUTED,
      EVENT_DOMAIN.POLICY,
      "corr-model-routed-001",
      { roleName: "worker", resolvedModel: "Claude Sonnet 4.6", tier: "T1", wasDowngraded: false, routingReasonCode: "standard", taskKind: "general" }
    );
    assert.strictEqual(evt.event, EVENTS.POLICY_MODEL_ROUTED);
    assert.strictEqual(evt.domain, EVENT_DOMAIN.POLICY);
    assert.strictEqual(evt.correlationId, "corr-model-routed-001");
  });

  it("validateEvent accepts correctly-constructed POLICY_MODEL_ROUTED event", () => {
    const evt = buildEvent(
      EVENTS.POLICY_MODEL_ROUTED,
      EVENT_DOMAIN.POLICY,
      "corr-validate-001"
    );
    const result = validateEvent(evt);
    assert.strictEqual(result.ok, true);
  });
});

// ── POLICY_RETRY_SUPPRESSED ───────────────────────────────────────────────────

describe("EVENTS.POLICY_RETRY_SUPPRESSED", () => {
  it("is present in EVENTS catalog", () => {
    assert.ok("POLICY_RETRY_SUPPRESSED" in EVENTS, "POLICY_RETRY_SUPPRESSED key missing from EVENTS");
  });

  it("value is present in VALID_EVENT_NAMES", () => {
    assert.ok(
      VALID_EVENT_NAMES.has(EVENTS.POLICY_RETRY_SUPPRESSED),
      `VALID_EVENT_NAMES does not contain '${EVENTS.POLICY_RETRY_SUPPRESSED}'`
    );
  });

  it("value matches EVENT_NAME_PATTERN", () => {
    assert.match(EVENTS.POLICY_RETRY_SUPPRESSED, EVENT_NAME_PATTERN);
  });

  it("value starts with box.v1.policy", () => {
    assert.ok(EVENTS.POLICY_RETRY_SUPPRESSED.startsWith("box.v1.policy"));
  });

  it("buildEvent builds a valid event with POLICY domain", () => {
    const evt = buildEvent(
      EVENTS.POLICY_RETRY_SUPPRESSED,
      EVENT_DOMAIN.POLICY,
      "corr-retry-suppressed-001",
      { role: "king-david", expectedGain: 0.1, threshold: 0.3, reason: "low-roi", attempt: 2 }
    );
    assert.strictEqual(evt.event, EVENTS.POLICY_RETRY_SUPPRESSED);
    assert.strictEqual(evt.domain, EVENT_DOMAIN.POLICY);
  });

  it("validateEvent accepts correctly-constructed POLICY_RETRY_SUPPRESSED event", () => {
    const evt = buildEvent(
      EVENTS.POLICY_RETRY_SUPPRESSED,
      EVENT_DOMAIN.POLICY,
      "corr-validate-retry-001"
    );
    const result = validateEvent(evt);
    assert.strictEqual(result.ok, true);
  });
});

// ── POLICY_REROUTE_PENALTY_APPLIED ────────────────────────────────────────────

describe("EVENTS.POLICY_REROUTE_PENALTY_APPLIED", () => {
  it("is present in EVENTS catalog", () => {
    assert.ok("POLICY_REROUTE_PENALTY_APPLIED" in EVENTS, "POLICY_REROUTE_PENALTY_APPLIED key missing from EVENTS");
  });

  it("value is present in VALID_EVENT_NAMES", () => {
    assert.ok(
      VALID_EVENT_NAMES.has(EVENTS.POLICY_REROUTE_PENALTY_APPLIED),
      `VALID_EVENT_NAMES does not contain '${EVENTS.POLICY_REROUTE_PENALTY_APPLIED}'`
    );
  });

  it("value matches EVENT_NAME_PATTERN", () => {
    assert.match(EVENTS.POLICY_REROUTE_PENALTY_APPLIED, EVENT_NAME_PATTERN);
  });

  it("value starts with box.v1.policy", () => {
    assert.ok(EVENTS.POLICY_REROUTE_PENALTY_APPLIED.startsWith("box.v1.policy"));
  });

  it("buildEvent builds a valid event with POLICY domain", () => {
    const evt = buildEvent(
      EVENTS.POLICY_REROUTE_PENALTY_APPLIED,
      EVENT_DOMAIN.POLICY,
      "corr-reroute-001",
      { role: "esther", lane: "quality", reasonCode: "low-fill", fillRatio: 0.4, laneScore: 0.2 }
    );
    assert.strictEqual(evt.event, EVENTS.POLICY_REROUTE_PENALTY_APPLIED);
    assert.strictEqual(evt.domain, EVENT_DOMAIN.POLICY);
  });

  it("validateEvent accepts correctly-constructed POLICY_REROUTE_PENALTY_APPLIED event", () => {
    const evt = buildEvent(
      EVENTS.POLICY_REROUTE_PENALTY_APPLIED,
      EVENT_DOMAIN.POLICY,
      "corr-validate-reroute-001"
    );
    const result = validateEvent(evt);
    assert.strictEqual(result.ok, true);
  });
});

// ── Missing-event detection ───────────────────────────────────────────────────

describe("Missing-event detection", () => {
  it("consumeTypedEvent rejects an unregistered event name", () => {
    const fakeEvent = {
      event: "box.v1.unknown.fakeEvent",
      domain: EVENT_DOMAIN.POLICY,
      correlationId: "corr-fake",
      version: 1,
      timestamp: new Date().toISOString(),
      payload: {},
    };
    const result = consumeTypedEvent(fakeEvent);
    assert.strictEqual(result.ok, false);
    assert.ok(
      typeof result.code === "string" && result.code.length > 0,
      `Expected a non-empty string error code, got: ${result.code}`
    );
  });

  it("consumeTypedEvent accepts a registered new policy event", () => {
    const evt = buildEvent(
      EVENTS.POLICY_MODEL_ROUTED,
      EVENT_DOMAIN.POLICY,
      "corr-consume-001"
    );
    const result = consumeTypedEvent(evt);
    assert.strictEqual(result.ok, true);
  });

  it("consumeTypedEvent accepts POLICY_RETRY_SUPPRESSED", () => {
    const evt = buildEvent(
      EVENTS.POLICY_RETRY_SUPPRESSED,
      EVENT_DOMAIN.POLICY,
      "corr-consume-002"
    );
    const result = consumeTypedEvent(evt);
    assert.strictEqual(result.ok, true);
  });

  it("consumeTypedEvent accepts POLICY_REROUTE_PENALTY_APPLIED", () => {
    const evt = buildEvent(
      EVENTS.POLICY_REROUTE_PENALTY_APPLIED,
      EVENT_DOMAIN.POLICY,
      "corr-consume-003"
    );
    const result = consumeTypedEvent(evt);
    assert.strictEqual(result.ok, true);
  });
});

// ── Governance block event — regression guard ─────────────────────────────────

describe("Governance block event regression guard", () => {
  it("GOVERNANCE_GATE_EVALUATED is still in EVENTS catalog", () => {
    assert.ok("GOVERNANCE_GATE_EVALUATED" in EVENTS, "GOVERNANCE_GATE_EVALUATED was accidentally removed");
  });

  it("GOVERNANCE_GATE_EVALUATED is in VALID_EVENT_NAMES", () => {
    assert.ok(VALID_EVENT_NAMES.has(EVENTS.GOVERNANCE_GATE_EVALUATED));
  });

  it("VALID_EVENT_NAMES size equals EVENTS value count (no orphan entries)", () => {
    assert.strictEqual(
      VALID_EVENT_NAMES.size,
      Object.values(EVENTS).length,
      "VALID_EVENT_NAMES size mismatch — an event was added to EVENTS but not reflected in the set"
    );
  });
});

// ── Negative paths ────────────────────────────────────────────────────────────

describe("Negative paths — invalid event construction", () => {
  it("validateEvent rejects event with empty correlationId", () => {
    // Construct manually to avoid buildEvent throwing
    const raw = {
      event: EVENTS.POLICY_MODEL_ROUTED,
      domain: EVENT_DOMAIN.POLICY,
      correlationId: "",
      version: 1,
      timestamp: new Date().toISOString(),
      payload: {},
    };
    const result = validateEvent(raw);
    assert.strictEqual(result.ok, false);
    assert.ok(result.code, "Invalid event must carry a code");
  });

  it("validateEvent rejects null input", () => {
    const result = validateEvent(null as any);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, EVENT_ERROR_CODE.MISSING_INPUT);
  });

  it("validateEvent rejects event with invalid domain", () => {
    const raw = {
      event: EVENTS.POLICY_MODEL_ROUTED,
      domain: "not-a-real-domain",
      correlationId: "corr-bad-domain",
      version: 1,
      timestamp: new Date().toISOString(),
      payload: {},
    };
    const result = validateEvent(raw);
    assert.strictEqual(result.ok, false);
  });
});
