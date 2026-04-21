/**
 * Tests for src/dashboard/live_dashboard.ts
 *
 * Covers:
 *   - deriveSystemStatus (event-driven paths, fallback-heuristic paths)
 *   - DASHBOARD_PAYLOAD_MAX_BYTES constant
 *   - statusFreshnessAt and statusSource fields are present on runtime
 *   - degradedReason is explicit when systemStatus === "degraded"
 *   - Negative path: degraded state without reason code still records explicit status
 *   - No silent fallback: fallback-heuristic path sets explicit degradedReason or statusSource
 *   - Payload size guard (< 50 KB)
 *   - Schema: SYSTEM_STATUS_ENUM, SYSTEM_STATUS_REASON_CODE from pipeline_progress.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveSystemStatus,
  DASHBOARD_PAYLOAD_MAX_BYTES,
  consumeTypedEvent,
  isTypedEventForDomain,
} from "../../src/dashboard/live_dashboard.ts";

import {
  SYSTEM_STATUS_ENUM,
  SYSTEM_STATUS_REASON_CODE,
} from "../../src/core/pipeline_progress.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePipeline(stage, updatedAt) {
  return {
    stage: stage || "idle",
    updatedAt: updatedAt || new Date().toISOString(),
    startedAt: null,
  };
}

function makeHealth(orchestratorStatus, reason, recordedAt) {
  return {
    orchestratorStatus: orchestratorStatus || "operational",
    reason: reason || null,
    recordedAt: recordedAt || new Date().toISOString(),
  };
}

function daemonRunning() {
  return { running: true, pid: 12345 };
}
function daemonStopped() {
  return { running: false, pid: 0 };
}

// ── SYSTEM_STATUS_ENUM ────────────────────────────────────────────────────────

describe("SYSTEM_STATUS_ENUM", () => {
  it("contains all five valid status values", () => {
    assert.ok(SYSTEM_STATUS_ENUM.includes("offline"));
    assert.ok(SYSTEM_STATUS_ENUM.includes("completed"));
    assert.ok(SYSTEM_STATUS_ENUM.includes("degraded"));
    assert.ok(SYSTEM_STATUS_ENUM.includes("idle"));
    assert.ok(SYSTEM_STATUS_ENUM.includes("working"));
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(SYSTEM_STATUS_ENUM));
  });
});

// ── SYSTEM_STATUS_REASON_CODE ─────────────────────────────────────────────────

describe("SYSTEM_STATUS_REASON_CODE", () => {
  it("contains all required reason codes", () => {
    assert.ok(typeof SYSTEM_STATUS_REASON_CODE.HEALTH_FILE_DEGRADED === "string");
    assert.ok(typeof SYSTEM_STATUS_REASON_CODE.DAEMON_OFFLINE === "string");
    assert.ok(typeof SYSTEM_STATUS_REASON_CODE.FALLBACK_HEURISTIC === "string");
    assert.ok(typeof SYSTEM_STATUS_REASON_CODE.MISSING_PIPELINE_STATE === "string");
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(SYSTEM_STATUS_REASON_CODE));
  });
});

// ── DASHBOARD_PAYLOAD_MAX_BYTES ───────────────────────────────────────────────

describe("DASHBOARD_PAYLOAD_MAX_BYTES", () => {
  it("is exactly 51200 (50 KB)", () => {
    assert.equal(DASHBOARD_PAYLOAD_MAX_BYTES, 51200);
  });

  it("is a positive finite number", () => {
    assert.ok(typeof DASHBOARD_PAYLOAD_MAX_BYTES === "number");
    assert.ok(Number.isFinite(DASHBOARD_PAYLOAD_MAX_BYTES));
    assert.ok(DASHBOARD_PAYLOAD_MAX_BYTES > 0);
  });
});

// ── deriveSystemStatus — event-driven paths ───────────────────────────────────

describe("deriveSystemStatus — event-driven: degraded", () => {
  it("returns degraded when orchestratorStatus is degraded", () => {
    const result = deriveSystemStatus(
      makePipeline("idle"),
      makeHealth("degraded", "slo-breach"),
      daemonRunning(),
      {},
      null
    );
    assert.equal(result.systemStatus, "degraded");
    assert.equal(result.statusSource, "event-driven");
    assert.ok(typeof result.statusFreshnessAt === "string", "statusFreshnessAt must be a string");
    assert.ok(result.degradedReason !== null, "degradedReason must not be null when degraded");
  });

  it("includes the reason from orchestratorHealth in systemStatusText", () => {
    const result = deriveSystemStatus(
      makePipeline("idle"),
      makeHealth("degraded", "slo-breach-latency"),
      daemonRunning(),
      {},
      null
    );
    assert.ok(result.systemStatusText.includes("slo-breach-latency"));
  });

  it("uses fallback reason code when orchestratorHealth.reason is null", () => {
    const result = deriveSystemStatus(
      makePipeline("idle"),
      makeHealth("degraded", null),
      daemonRunning(),
      {},
      null
    );
    assert.equal(result.systemStatus, "degraded");
    assert.equal(result.degradedReason, SYSTEM_STATUS_REASON_CODE.HEALTH_FILE_DEGRADED);
  });

  // Negative path: degraded status must always set an explicit degradedReason
  it("[NEGATIVE] never returns degraded status with null degradedReason when reason is missing", () => {
    const result = deriveSystemStatus(
      makePipeline("idle"),
      makeHealth("degraded", ""),
      daemonRunning(),
      {},
      null
    );
    assert.equal(result.systemStatus, "degraded");
    assert.ok(result.degradedReason !== null, "degradedReason must be non-null even when reason string is empty");
  });
});

describe("deriveSystemStatus — event-driven: completed", () => {
  it("returns completed when daemon is stopped and completedEntry is present", () => {
    const completedEntry = {
      repo: "CanerDoqdu/Box",
      completedAt: new Date().toISOString(),
    };
    const result = deriveSystemStatus(
      makePipeline("idle"),
      makeHealth("operational"),
      daemonStopped(),
      {},
      completedEntry
    );
    assert.equal(result.systemStatus, "completed");
    assert.equal(result.statusSource, "event-driven");
    assert.ok(typeof result.statusFreshnessAt === "string");
  });
});

describe("deriveSystemStatus — event-driven: active pipeline stage", () => {
  it("returns working for a fresh active stage", () => {
    const freshNow = new Date().toISOString();
    const result = deriveSystemStatus(
      makePipeline("workers_running", freshNow),
      makeHealth("operational"),
      daemonRunning(),
      {},
      null
    );
    assert.equal(result.systemStatus, "working");
    assert.equal(result.statusSource, "event-driven");
    assert.equal(result.statusFreshnessAt, freshNow);
  });

  it("falls back to heuristic for a stale active stage (> 10 min old)", () => {
    const staleAt = new Date(Date.now() - 12 * 60 * 1000).toISOString(); // 12 min ago
    const result = deriveSystemStatus(
      makePipeline("workers_running", staleAt),
      makeHealth("operational"),
      daemonRunning(),
      {},
      null
    );
    // Should use fallback since pipeline state is stale
    assert.equal(result.statusSource, "fallback-heuristic");
  });
});

describe("deriveSystemStatus — event-driven: idle", () => {
  it("returns idle when pipeline stage is idle and daemon is running", () => {
    const result = deriveSystemStatus(
      makePipeline("idle"),
      makeHealth("operational"),
      daemonRunning(),
      {},
      null
    );
    assert.equal(result.systemStatus, "idle");
    assert.equal(result.statusSource, "event-driven");
    assert.equal(result.degradedReason, null);
  });

  it("returns offline when pipeline stage is idle and daemon is stopped", () => {
    const result = deriveSystemStatus(
      makePipeline("idle"),
      makeHealth("operational"),
      daemonStopped(),
      {},
      null
    );
    assert.equal(result.systemStatus, "offline");
    assert.equal(result.statusSource, "event-driven");
    assert.equal(result.degradedReason, SYSTEM_STATUS_REASON_CODE.DAEMON_OFFLINE);
  });

  it("returns idle after cycle_complete when daemon is running", () => {
    const result = deriveSystemStatus(
      makePipeline("cycle_complete"),
      makeHealth("operational"),
      daemonRunning(),
      {},
      null
    );
    assert.equal(result.systemStatus, "idle");
    assert.equal(result.statusSource, "event-driven");
  });
});

// ── deriveSystemStatus — fallback-heuristic paths ────────────────────────────

describe("deriveSystemStatus — fallback-heuristic paths", () => {
  it("returns working via fallback when stale pipeline and workers are active", () => {
    const staleAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const result = deriveSystemStatus(
      makePipeline("prometheus_analyzing", staleAt),
      makeHealth("operational"),
      daemonRunning(),
      { worker1: { status: "working" } },
      null
    );
    assert.equal(result.systemStatus, "working");
    assert.equal(result.statusSource, "fallback-heuristic");
    // Fallback must not be silent — degradedReason must record the fallback code
    assert.equal(result.degradedReason, SYSTEM_STATUS_REASON_CODE.FALLBACK_HEURISTIC);
  });

  it("returns idle via fallback when stale pipeline and no active workers", () => {
    const staleAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const result = deriveSystemStatus(
      makePipeline("prometheus_analyzing", staleAt),
      makeHealth("operational"),
      daemonRunning(),
      { worker1: { status: "idle" } },
      null
    );
    assert.equal(result.systemStatus, "idle");
    assert.equal(result.statusSource, "fallback-heuristic");
    assert.equal(result.degradedReason, SYSTEM_STATUS_REASON_CODE.FALLBACK_HEURISTIC);
  });

  it("returns offline via fallback when daemon is stopped (stale pipeline)", () => {
    const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const result = deriveSystemStatus(
      makePipeline("workers_running", staleAt),
      makeHealth("operational"),
      daemonStopped(),
      {},
      null
    );
    assert.equal(result.systemStatus, "offline");
    assert.equal(result.statusSource, "fallback-heuristic");
    assert.equal(result.degradedReason, SYSTEM_STATUS_REASON_CODE.DAEMON_OFFLINE);
  });

  // Negative path: no silent fallback — fallback must always set statusSource
  it("[NEGATIVE] fallback path always sets statusSource — never leaves it undefined", () => {
    const staleAt = new Date(0).toISOString(); // epoch — maximally stale
    const result = deriveSystemStatus(
      makePipeline("janus_thinking", staleAt),
      makeHealth("operational"),
      daemonRunning(),
      {},
      null
    );
    assert.ok(result.statusSource !== undefined, "statusSource must never be undefined");
    assert.ok(
      result.statusSource === "event-driven" || result.statusSource === "fallback-heuristic",
      `statusSource must be a known value, got: ${result.statusSource}`
    );
  });
});

// ── deriveSystemStatus — output shape ────────────────────────────────────────

describe("deriveSystemStatus — output shape contract", () => {
  it("always returns all five required fields", () => {
    const result = deriveSystemStatus(
      makePipeline("idle"),
      makeHealth("operational"),
      daemonRunning(),
      {},
      null
    );
    assert.ok("systemStatus" in result, "missing systemStatus");
    assert.ok("systemStatusText" in result, "missing systemStatusText");
    assert.ok("statusSource" in result, "missing statusSource");
    assert.ok("statusFreshnessAt" in result, "missing statusFreshnessAt");
    assert.ok("degradedReason" in result, "missing degradedReason");
  });

  it("systemStatus is always one of SYSTEM_STATUS_ENUM", () => {
    const scenarios = [
      [makePipeline("idle"), makeHealth("operational"), daemonRunning(), {}, null],
      [makePipeline("idle"), makeHealth("degraded", "r"), daemonRunning(), {}, null],
      [makePipeline("workers_running", new Date().toISOString()), makeHealth("operational"), daemonRunning(), {}, null],
      [makePipeline("idle"), makeHealth("operational"), daemonStopped(), {}, null],
    ];
    for (const [pp, oh, ds, ws, ce] of scenarios) {
      const result = deriveSystemStatus(pp, oh, ds, ws, ce);
      assert.ok(
        SYSTEM_STATUS_ENUM.includes(result.systemStatus),
        `systemStatus '${result.systemStatus}' is not in SYSTEM_STATUS_ENUM`
      );
    }
  });

  it("degradedReason is null when systemStatus is not degraded or DAEMON_OFFLINE/FALLBACK_HEURISTIC", () => {
    const result = deriveSystemStatus(
      makePipeline("idle"),
      makeHealth("operational"),
      daemonRunning(),
      {},
      null
    );
    assert.equal(result.systemStatus, "idle");
    assert.equal(result.degradedReason, null);
  });
});

// ── consumeTypedEvent / isTypedEventForDomain (re-exported behaviour) ─────────

describe("consumeTypedEvent", () => {
  it("returns ok=false for null input", () => {
    const result = consumeTypedEvent(null);
    assert.equal(result.ok, false);
  });

  it("returns ok=false for a non-event plain string", () => {
    const result = consumeTypedEvent("not-json");
    assert.equal(result.ok, false);
  });

  it("returns ok=true for a well-formed event object", () => {
    const evt = {
      event: "box.v1.orchestration.stageEntered",
      version: 1,
      correlationId: "test-corr-1",
      timestamp: new Date().toISOString(),
      domain: "orchestration",
      payload: { step: "idle" },
    };
    const result = consumeTypedEvent(evt);
    assert.equal(result.ok, true);
    assert.ok(result.event !== undefined);
  });

  // Negative path: event with wrong version is rejected
  it("[NEGATIVE] rejects an event with wrong version", () => {
    const evt = {
      event: "box.v1.orchestration.stageEntered",
      version: 999,
      correlationId: "test-corr-2",
      timestamp: new Date().toISOString(),
      domain: "orchestration",
      payload: {},
    };
    const result = consumeTypedEvent(evt);
    assert.equal(result.ok, false);
  });
});

describe("isTypedEventForDomain", () => {
  it("returns true for a valid event matching the domain filter", () => {
    const evt = {
      event: "box.v1.orchestration.stageEntered",
      version: 1,
      correlationId: "c1",
      timestamp: new Date().toISOString(),
      domain: "orchestration",
      payload: {},
    };
    assert.equal(isTypedEventForDomain(evt, "orchestration"), true);
  });

  it("returns false when domain does not match", () => {
    const evt = {
      event: "box.v1.orchestration.stageEntered",
      version: 1,
      correlationId: "c1",
      timestamp: new Date().toISOString(),
      domain: "orchestration",
      payload: {},
    };
    assert.equal(isTypedEventForDomain(evt, "billing"), false);
  });

  it("returns false for invalid input", () => {
    assert.equal(isTypedEventForDomain(null), false);
    assert.equal(isTypedEventForDomain("garbage"), false);
  });
});

