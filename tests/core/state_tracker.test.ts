import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ALERT_SEVERITY,
  appendAlert,
  appendProgress,
  buildProgressLogPrefix,
  loadTestsState,
  updateTaskInTestsState,
  CACHE_COMPLETION_OUTCOME,
  appendCacheOutcome,
  appendPromptCacheTelemetry,
  readPromptCacheTelemetry,
  appendInterventionRetirementEvidence,
  appendPolicyClosureEvidence,
  enforceStateRetention,
  loadInterventionRetirementEvidence,
  loadPolicyClosureHistory,
  loadInterventionOptimizerLog,
  appendInterventionOptimizerEntry,
  appendGovernanceBlockEvent,
  loadGovernanceBlockSummary,
  STATE_RETENTION_RULES,
} from "../../src/core/state_tracker.js";
import { getTargetSessionProgressLogPath } from "../../src/core/target_session_state.js";
import {
  OPTIMIZER_LOG_JSONL_SCHEMA,
  OPTIMIZER_LOG_RECORD_TYPE,
} from "../../src/core/intervention_optimizer.js";

describe("state_tracker", () => {
  let stateDir: string;
  let config: any;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-state-tracker-"));
    config = {
      paths: {
        stateDir,
        progressFile: path.join(stateDir, "progress.txt"),
        testsStateFile: path.join(stateDir, "tests_state.json")
      }
    };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("initializes tests state and updates task totals deterministically", async () => {
    const initial = await loadTestsState(config);
    assert.deepEqual(initial.totals, { passed: 0, failed: 0, running: 0, queued: 0 });

    await updateTaskInTestsState(config, { id: 1, title: "T1", kind: "unit" }, "passed", "ok");
    const updated = await loadTestsState(config);
    assert.equal(updated.tests.length, 1);
    assert.equal(updated.totals.passed, 1);
  });

  it("negative path: appendProgress creates file and appends message", async () => {
    await appendProgress(config, "hello world");
    const raw = await fs.readFile(config.paths.progressFile, "utf8");
    assert.ok(raw.includes("hello world"));
    assert.equal(ALERT_SEVERITY.CRITICAL, "critical");
  });

  it("fans out target-mode progress into a per-session summary log with mode context", async () => {
    config.platformModeState = { currentMode: "single_target_delivery" };
    config.activeTargetSession = {
      projectId: "target_portal",
      sessionId: "sess_123",
    };

    await appendProgress(config, "target lifecycle advanced");

    const globalLog = await fs.readFile(config.paths.progressFile, "utf8");
    const sessionLogPath = getTargetSessionProgressLogPath(stateDir, "target_portal", "sess_123");
    const sessionLog = await fs.readFile(sessionLogPath, "utf8");

    assert.ok(globalLog.includes("target lifecycle advanced"));
    assert.ok(globalLog.includes(buildProgressLogPrefix(config)));
    assert.match(globalLog, /target lifecycle advanced \[mode=single_target_delivery projectId=target_portal sessionId=sess_123\]/);
    assert.ok(sessionLog.includes("target lifecycle advanced"));
    assert.ok(sessionLog.includes("projectId=target_portal"));
    assert.ok(sessionLog.includes("sessionId=sess_123"));
  });

  it("caps alerts history using the centralized retention rule", async () => {
    const limit = STATE_RETENTION_RULES.alerts.maxEntries;

    for (let index = 0; index < limit + 5; index += 1) {
      await appendAlert(config, {
        severity: ALERT_SEVERITY.MEDIUM,
        source: "test",
        title: `alert-${index}`,
        message: `message-${index}`,
        correlationId: `corr-${index}`,
      });
    }

    const snapshot = JSON.parse(await fs.readFile(path.join(stateDir, "alerts.json"), "utf8"));
    assert.equal(snapshot.entries.length, limit);
    assert.equal(snapshot.entries[0].id, "corr-5");
    assert.equal(snapshot.entries.at(-1).id, `corr-${limit + 4}`);
  });
});

// ── CACHE_COMPLETION_OUTCOME enum ────────────────────────────────────────────

describe("CACHE_COMPLETION_OUTCOME enum", () => {
  it("exports all five canonical outcome values as frozen constants", () => {
    assert.equal(CACHE_COMPLETION_OUTCOME.MERGED,   "merged");
    assert.equal(CACHE_COMPLETION_OUTCOME.REOPEN,   "reopen");
    assert.equal(CACHE_COMPLETION_OUTCOME.ROLLBACK, "rollback");
    assert.equal(CACHE_COMPLETION_OUTCOME.TIMEOUT,  "timeout");
    assert.equal(CACHE_COMPLETION_OUTCOME.UNKNOWN,  "unknown");
    assert.ok(Object.isFrozen(CACHE_COMPLETION_OUTCOME), "must be frozen");
  });
});

// ── appendCacheOutcome ────────────────────────────────────────────────────────

describe("appendCacheOutcome — positive path", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-cache-outcome-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("persists a cache-hit record and returns ok=true", async () => {
    const config = { paths: { stateDir } };
    const result = await appendCacheOutcome(config, {
      correlationId: "corr-001",
      cacheHit: true,
      completionOutcome: CACHE_COMPLETION_OUTCOME.MERGED,
    });
    assert.equal(result.ok, true);
    const file = path.join(stateDir, "cache_outcomes.jsonl");
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.cacheHit, true);
    assert.equal(parsed.completionOutcome, "merged");
    assert.equal(parsed.correlationId, "corr-001");
  });

  it("persists a cache-miss record and returns ok=true", async () => {
    const config = { paths: { stateDir } };
    const result = await appendCacheOutcome(config, {
      cacheHit: false,
      completionOutcome: CACHE_COMPLETION_OUTCOME.ROLLBACK,
    });
    assert.equal(result.ok, true);
    const file = path.join(stateDir, "cache_outcomes.jsonl");
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.cacheHit, false);
    assert.equal(parsed.completionOutcome, "rollback");
  });

  it("appends multiple records correctly (newline-separated JSONL)", async () => {
    const config = { paths: { stateDir } };
    await appendCacheOutcome(config, { cacheHit: true,  completionOutcome: "merged" });
    await appendCacheOutcome(config, { cacheHit: false, completionOutcome: "timeout" });
    const file = path.join(stateDir, "cache_outcomes.jsonl");
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).completionOutcome, "merged");
    assert.equal(JSON.parse(lines[1]).completionOutcome, "timeout");
  });
});

describe("appendCacheOutcome — negative path", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-cache-outcome-neg-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("returns ok=false when record is null", async () => {
    const config = { paths: { stateDir } };
    const result = await appendCacheOutcome(config, null as any);
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("null"));
  });

  it("returns ok=false when cacheHit is not a boolean", async () => {
    const config = { paths: { stateDir } };
    const result = await appendCacheOutcome(config, { cacheHit: "yes" as any, completionOutcome: "merged" });
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("cacheHit"));
  });

  it("returns ok=false when completionOutcome is an unknown value", async () => {
    const config = { paths: { stateDir } };
    const result = await appendCacheOutcome(config, { cacheHit: true, completionOutcome: "invalid_outcome" as any });
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("invalid_outcome"));
  });
});

// ── appendPolicyClosureEvidence / loadPolicyClosureHistory ─────────────────────

describe("appendPolicyClosureEvidence", () => {
  let closureStateDir: string;

  beforeEach(async () => {
    closureStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-closure-"));
  });

  afterEach(async () => {
    await fs.rm(closureStateDir, { recursive: true, force: true });
  });

  it("persists a closure evidence record and reads it back", async () => {
    const config = { paths: { stateDir: closureStateDir } };
    const record = { policyId: "lint-failure", resolvedAt: new Date().toISOString(), resolvedBy: "manual", evidence: "Fixed" };
    const result = await appendPolicyClosureEvidence(config, record);
    assert.equal(result.ok, true);

    const history = await loadPolicyClosureHistory(config);
    assert.equal(history.length, 1);
    assert.equal(history[0].policyId, "lint-failure");
  });

  it("appends multiple records in order", async () => {
    const config = { paths: { stateDir: closureStateDir } };
    const rec1 = { policyId: "p1", resolvedAt: new Date().toISOString(), resolvedBy: "manual", evidence: "ev1" };
    const rec2 = { policyId: "p2", resolvedAt: new Date().toISOString(), resolvedBy: "auto", evidence: "ev2" };
    await appendPolicyClosureEvidence(config, rec1);
    await appendPolicyClosureEvidence(config, rec2);

    const history = await loadPolicyClosureHistory(config);
    assert.equal(history.length, 2);
    assert.equal(history[0].policyId, "p1");
    assert.equal(history[1].policyId, "p2");
  });

  it("returns ok=false when record is null", async () => {
    const config = { paths: { stateDir: closureStateDir } };
    const result = await appendPolicyClosureEvidence(config, null as any);
    assert.equal(result.ok, false);
  });
});

describe("loadPolicyClosureHistory", () => {
  let closureStateDir2: string;

  beforeEach(async () => {
    closureStateDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "box-closure2-"));
  });

  afterEach(async () => {
    await fs.rm(closureStateDir2, { recursive: true, force: true });
  });

  it("returns empty array when no history file exists", async () => {
    const config = { paths: { stateDir: closureStateDir2 } };
    const history = await loadPolicyClosureHistory(config);
    assert.deepEqual(history, []);
  });

  it("skips malformed lines silently", async () => {
    const config = { paths: { stateDir: closureStateDir2 } };
    const filePath = path.join(closureStateDir2, "policy_closure_evidence.jsonl");
    await fs.writeFile(filePath, '{"policyId":"ok"}\nNOT JSON\n{"policyId":"also-ok"}\n');
    const history = await loadPolicyClosureHistory(config);
    assert.equal(history.length, 2);
    assert.equal(history[0].policyId, "ok");
    assert.equal(history[1].policyId, "also-ok");
  });
});

describe("appendInterventionRetirementEvidence / loadInterventionRetirementEvidence", () => {
  let retirementStateDir: string;

  beforeEach(async () => {
    retirementStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-retirement-"));
  });

  afterEach(async () => {
    await fs.rm(retirementStateDir, { recursive: true, force: true });
  });

  it("persists explicit no-signal closure evidence and reads it back", async () => {
    const config = { paths: { stateDir: retirementStateDir } };
    const result = await appendInterventionRetirementEvidence(config, [{
      cycleId: "cycle-1",
      interventionId: "plan-17",
      policyId: "policy-parser-guard",
      decision: "hold",
      decisionMode: "safety_gate",
      closureMode: "no_signal",
      noSignalOutcome: true,
      reason: "insufficient_sample:1/3",
      outcomeScore: 0.35,
    }]);

    assert.equal(result.ok, true);
    const history = await loadInterventionRetirementEvidence(config);
    assert.equal(history.length, 1);
    assert.equal(history[0].interventionId, "plan-17");
    assert.equal(history[0].closureMode, "no_signal");
    assert.equal(history[0].noSignalOutcome, true);
    assert.equal(history[0].lineageJoinKey, "cycle-intervention:cycle-1:plan-17");
    assert.equal(history[0].lineage?.interventionId, "plan-17");
    assert.equal(history[0].lineage?.cycleId, "cycle-1");
  });

  it("negative path: rejects retirement evidence without a stable lineage seed", async () => {
    const config = { paths: { stateDir: retirementStateDir } };
    const result = await appendInterventionRetirementEvidence(config, [{
      cycleId: null,
      interventionId: "",
      policyId: "policy-parser-guard",
    }]);

    assert.equal(result.ok, false);
    assert.match(String(result.reason || ""), /interventionId is required/i);
  });
});

describe("enforceStateRetention", () => {
  let retentionStateDir: string;

  beforeEach(async () => {
    retentionStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-retention-"));
  });

  afterEach(async () => {
    await fs.rm(retentionStateDir, { recursive: true, force: true });
  });

  it("trims jsonl and history-backed artifacts according to centralized rules", async () => {
    const config = { paths: { stateDir: retentionStateDir } };
    const promptRule = STATE_RETENTION_RULES.promptCacheTelemetry;
    const baselineRule = STATE_RETENTION_RULES.parserBaselineMetrics;

    const promptLines = Array.from({ length: promptRule.maxEntries + 5 }, (_, index) => JSON.stringify({ index }));
    await fs.writeFile(path.join(retentionStateDir, promptRule.fileName), `${promptLines.join("\n")}\n`, "utf8");

    const baselineHistory = Array.from({ length: baselineRule.maxEntries + 7 }, (_, index) => ({ cycleId: `cycle-${index}` }));
    await fs.writeFile(
      path.join(retentionStateDir, baselineRule.fileName),
      JSON.stringify({ schemaVersion: 1, lastRecord: baselineHistory[0], history: baselineHistory, updatedAt: null }),
      "utf8",
    );

    const result = await enforceStateRetention(config);
    assert.equal(result.ok, true);
    assert.equal(result.totalTrimmed, 12);

    const retainedPromptLines = (await fs.readFile(path.join(retentionStateDir, promptRule.fileName), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(retainedPromptLines.length, promptRule.maxEntries);
    assert.equal(retainedPromptLines[0].index, 5);

    const retainedBaseline = JSON.parse(await fs.readFile(path.join(retentionStateDir, baselineRule.fileName), "utf8"));
    assert.equal(retainedBaseline.history.length, baselineRule.maxEntries);
    assert.equal(retainedBaseline.history[0].cycleId, "cycle-0");
    assert.equal(retainedBaseline.history.at(-1).cycleId, `cycle-${baselineRule.maxEntries - 1}`);
    assert.equal(retainedBaseline.lastRecord.cycleId, "cycle-0");
  });
});

describe("loadInterventionOptimizerLog", () => {
  let optimizerStateDir: string;
  let config: any;

  beforeEach(async () => {
    optimizerStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-optimizer-state-"));
    config = { paths: { stateDir: optimizerStateDir } };
  });

  afterEach(async () => {
    await fs.rm(optimizerStateDir, { recursive: true, force: true });
  });

  it("loads only fresh, contract-valid JSONL records", async () => {
    const now = Date.now();
    const staleSavedAt = new Date(now - (8 * 60 * 60 * 1000)).toISOString();
    const freshSavedAt = new Date(now).toISOString();
    const logFile = path.join(optimizerStateDir, "intervention_optimizer_log.jsonl");

    const lines = [
      JSON.stringify({
        jsonlSchema: "wrong.schema",
        recordType: OPTIMIZER_LOG_RECORD_TYPE,
        savedAt: freshSavedAt,
        freshness: { staleAfterMs: 6 * 60 * 60 * 1000 },
        payload: { id: "invalid-schema" },
      }),
      JSON.stringify({
        jsonlSchema: OPTIMIZER_LOG_JSONL_SCHEMA,
        recordType: "wrong_type",
        savedAt: freshSavedAt,
        freshness: { staleAfterMs: 6 * 60 * 60 * 1000 },
        payload: { id: "invalid-type" },
      }),
      JSON.stringify({
        jsonlSchema: OPTIMIZER_LOG_JSONL_SCHEMA,
        recordType: OPTIMIZER_LOG_RECORD_TYPE,
        savedAt: staleSavedAt,
        freshness: { staleAfterMs: 6 * 60 * 60 * 1000 },
        payload: { id: "stale" },
      }),
      JSON.stringify({
        jsonlSchema: OPTIMIZER_LOG_JSONL_SCHEMA,
        recordType: OPTIMIZER_LOG_RECORD_TYPE,
        savedAt: freshSavedAt,
        freshness: { staleAfterMs: 6 * 60 * 60 * 1000 },
        payload: { id: "fresh-valid" },
      }),
    ];

    await fs.writeFile(logFile, `${lines.join("\n")}\n`, "utf8");
    const result = await loadInterventionOptimizerLog(config);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].id, "fresh-valid");
  });

  it("returns no entries when legacy fallback file is stale", async () => {
    const fallbackFile = path.join(optimizerStateDir, "intervention_optimizer_log.json");
    await fs.writeFile(
      fallbackFile,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date(Date.now() - (8 * 60 * 60 * 1000)).toISOString(),
        entries: [{ id: "legacy-stale" }],
      }),
      "utf8",
    );

    const result = await loadInterventionOptimizerLog(config);
    assert.deepEqual(result.entries, []);
  });
});

describe("appendInterventionOptimizerEntry", () => {
  let optimizerAppendDir: string;
  let config: any;

  beforeEach(async () => {
    optimizerAppendDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-optimizer-append-"));
    config = { paths: { stateDir: optimizerAppendDir } };
  });

  afterEach(async () => {
    await fs.rm(optimizerAppendDir, { recursive: true, force: true });
  });

  it("writes standardized contract fields for optimizer diagnostics JSONL", async () => {
    await appendInterventionOptimizerEntry(config, { status: "ok", selected: [], rejected: [] });
    const logFile = path.join(optimizerAppendDir, "intervention_optimizer_log.jsonl");
    const line = (await fs.readFile(logFile, "utf8")).trim();
    const record = JSON.parse(line);
    assert.equal(record.jsonlSchema, OPTIMIZER_LOG_JSONL_SCHEMA);
    assert.equal(record.recordType, OPTIMIZER_LOG_RECORD_TYPE);
    assert.equal(record.freshness.status, "fresh");
  });
});

// ── appendGovernanceBlockEvent (Task 2) ──────────────────────────────────────

describe("appendGovernanceBlockEvent", () => {
  let blockDir: string;
  let config: any;

  beforeEach(async () => {
    blockDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gov-block-"));
    config = { paths: { stateDir: blockDir } };
  });

  afterEach(async () => {
    await fs.rm(blockDir, { recursive: true, force: true });
  });

  it("writes a JSONL record to governance_blocks.jsonl", async () => {
    await appendGovernanceBlockEvent(config, {
      cycleId: "cycle-12345",
      blockReason: "GOVERNANCE_FREEZE_ACTIVE:monthly-freeze",
      blockedAt: "2025-01-01T10:00:00.000Z",
      gateSource: "pre_dispatch_gate",
    });
    const filePath = path.join(blockDir, "governance_blocks.jsonl");
    const line = (await fs.readFile(filePath, "utf8")).trim();
    const record = JSON.parse(line);
    assert.equal(record.cycleId, "cycle-12345");
    assert.equal(record.blockReason, "GOVERNANCE_FREEZE_ACTIVE:monthly-freeze");
    assert.equal(record.blockReasonCode, "governance_freeze_active");
    assert.equal(record.gateSource, "pre_dispatch_gate");
    assert.equal(record.schemaVersion, 1);
  });

  it("appends multiple records (log is cumulative)", async () => {
    await appendGovernanceBlockEvent(config, {
      cycleId: "c1", blockReason: "reason-1", blockedAt: "2025-01-01T10:00:00Z", gateSource: "pre_dispatch_gate",
    });
    await appendGovernanceBlockEvent(config, {
      cycleId: "c2", blockReason: "reason-2", blockedAt: "2025-01-01T11:00:00Z", gateSource: "lane_diversity_gate",
    });
    const filePath = path.join(blockDir, "governance_blocks.jsonl");
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2, "both block events must be recorded");
    const r1 = JSON.parse(lines[0]);
    const r2 = JSON.parse(lines[1]);
    assert.equal(r1.cycleId, "c1");
    assert.equal(r2.gateSource, "lane_diversity_gate");
  });

  it("negative: missing record fields fall back gracefully (no throw)", async () => {
    await assert.doesNotReject(
      appendGovernanceBlockEvent(config, {
        cycleId: "",
        blockReason: "",
        blockedAt: "",
        gateSource: "",
      })
    );
  });

  it("builds a recent governance block summary with normalized reason codes", async () => {
    await appendGovernanceBlockEvent(config, {
      cycleId: "c1",
      blockReason: "autonomy_execution_gate_not_ready:insufficient_exploitation_window",
      blockedAt: "2025-01-01T10:00:00Z",
      gateSource: "pre_dispatch_gate",
    });
    await appendGovernanceBlockEvent(config, {
      cycleId: "c2",
      blockReason: "lane_diversity_gate_blocked:Only 1 effective lane",
      blockedAt: "2025-01-01T11:00:00Z",
      gateSource: "lane_diversity_gate",
    });
    const summary = await loadGovernanceBlockSummary(config, 10);
    assert.equal(summary.recentBlockCount, 2);
    assert.equal(summary.byReasonCode.autonomy_execution_gate_not_ready, 1);
    assert.equal(summary.byGateSource.pre_dispatch_gate, 1);
    assert.equal(summary.latestBlockReason, "lane_diversity_gate_blocked:Only 1 effective lane");
  });
});

// ── recordCapabilityExecution / loadCapabilityExecutionTraces ─────────────────

import {
  recordCapabilityExecution,
  loadCapabilityExecutionTraces,
  loadCapabilityExecutionSummary,
} from "../../src/core/state_tracker.js";

describe("recordCapabilityExecution", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-cap-trace-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("writes a trace entry and loadCapabilityExecutionTraces reads it back", async () => {
    const config = { paths: { stateDir } };
    await recordCapabilityExecution(config, "test-capability", "cycle-1 invocation");
    const traces = await loadCapabilityExecutionTraces(config);
    assert.ok(traces instanceof Set, "traces must be a Set");
    assert.ok(traces.has("test-capability"), "recorded capability must appear in traces set");
  });

  it("distinguishes two different capabilities by name", async () => {
    const config = { paths: { stateDir } };
    await recordCapabilityExecution(config, "cap-alpha", "c1");
    await recordCapabilityExecution(config, "cap-beta", "c1");
    const traces = await loadCapabilityExecutionTraces(config);
    assert.ok(traces.has("cap-alpha"), "cap-alpha must be in traces");
    assert.ok(traces.has("cap-beta"), "cap-beta must be in traces");
  });

  it("negative path: returns empty Set when trace file does not exist", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-cap-empty-"));
    try {
      const config = { paths: { stateDir: emptyDir } };
      const traces = await loadCapabilityExecutionTraces(config);
      assert.ok(traces instanceof Set, "must return Set even when file missing");
      assert.equal(traces.size, 0, "must be empty when no traces written");
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("builds a capability execution summary with observed capability counts", async () => {
    const config = { paths: { stateDir } };
    await recordCapabilityExecution(config, "cap-alpha", "c1");
    await recordCapabilityExecution(config, "cap-beta", "c1");
    const summary = await loadCapabilityExecutionSummary(config);
    assert.equal(summary.observedCapabilityCount, 2);
    assert.equal(summary.recentTraceCount, 2);
    assert.ok(summary.observedCapabilities.includes("cap-alpha"));
    assert.ok(summary.observedCapabilities.includes("cap-beta"));
    assert.equal(typeof summary.lastObservedAt, "string");
  });

  it("summary marks stale traces outside freshness window (negative path)", async () => {
    const config = { paths: { stateDir } };
    const staleAt = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)).toISOString();
    await fs.writeFile(
      path.join(stateDir, "capability_execution_traces.json"),
      JSON.stringify({
        traces: [
          { capability: "cap-stale", observedAt: staleAt, context: "old run" },
        ],
      }),
      "utf8",
    );
    const summary = await loadCapabilityExecutionSummary(config);
    assert.equal(summary.observedCapabilityCount, 0);
    assert.equal(summary.recentTraceCount, 0);
    assert.equal(summary.staleTraceCount, 1);
    assert.equal(summary.lastObservedAt, null);
  });

  it("persists prompt-cache lineage contract fields for causal joins", async () => {
    const config = { paths: { stateDir } };
    const result = await appendPromptCacheTelemetry(config, {
      promptFamilyKey: "planner",
      agent: "quality-worker",
      model: "Claude Sonnet 4.6",
      taskKind: "test",
      totalSegments: 10,
      cachedSegments: 6,
      estimatedSavedTokens: 120,
      lineageId: "lineage-1",
      taskId: "task-1",
      cycleId: "cycle-1",
      interventionId: "plan-1",
      lane: "quality",
      capability: "prompt-cache",
      specialized: true,
    });
    assert.equal(result.ok, true);
    const raw = await fs.readFile(path.join(stateDir, "prompt_cache_usage.jsonl"), "utf8");
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.lineageId, "lineage-1");
    assert.equal(parsed.lineageJoinKey, "lineage:lineage-1");
    assert.equal(parsed.stablePrefixHash, "planner");
    assert.equal(parsed.cacheableSegments, 6);
    assert.equal(parsed.prefixReuseRate, 0.6);
    assert.equal(parsed.lineage.taskId, "task-1");
    assert.equal(parsed.lineage.role, "quality-worker");
    assert.equal(parsed.lineage.lane, "quality");
    assert.equal(parsed.lineage.specialized, true);
  });

  it("normalizes prompt-cache telemetry around the prompt-family key when lineage ids are absent", async () => {
    const config = { paths: { stateDir } };
    const result = await appendPromptCacheTelemetry(config, {
      promptFamilyKey: "review-family",
      agent: "athena",
      model: "GPT-5.4",
      taskKind: "review",
      totalSegments: 7,
      cacheableSegments: 3,
      estimatedSavedTokens: 90,
    });
    assert.equal(result.ok, true);

    const entries = await readPromptCacheTelemetry(config);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].cachedSegments, 3);
    assert.equal(entries[0].cacheableSegments, 3);
    assert.equal(entries[0].lineageJoinKey, "prompt-family:review-family");
    assert.equal(entries[0].stablePrefixHash, "review-family");
    assert.equal(entries[0].prefixReuseRate, entries[0].hitRate);
  });

  it("normalizes legacy prompt-cache telemetry aliases symmetrically on read", async () => {
    const config = { paths: { stateDir } };
    await fs.writeFile(
      path.join(stateDir, "prompt_cache_usage.jsonl"),
      `${JSON.stringify({
        promptFamilyKey: "plan-family",
        agent: "prometheus",
        taskKind: "planning",
        totalSegments: 8,
        cachedSegments: 5,
        estimatedSavedTokens: 144,
      })}\n`,
      "utf8",
    );

    const entries = await readPromptCacheTelemetry(config);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].cacheableSegments, 5);
    assert.equal(entries[0].cachedSegments, 5);
    assert.equal(entries[0].stablePrefixHash, "plan-family");
    assert.equal(entries[0].prefixReuseRate, 0.625);
  });

  it("retains capability-execution lineage metadata in the runtime summary", async () => {
    const config = { paths: { stateDir } };
    await recordCapabilityExecution(config, "specialization-admission-control", "c1", {
      role: "quality-worker",
      taskId: "task-2",
      cycleId: "cycle-2",
      taskKind: "test",
      interventionId: "plan-2",
      lane: "quality",
      specialized: true,
      lineage: {
        lineageId: "lineage-2",
        taskIdentity: "targeted regression",
      },
    });
    const summary = await loadCapabilityExecutionSummary(config);
    assert.equal(summary.recentTraceCount, 1);
    assert.equal(summary.recentTraces[0].lineage?.lineageId, "lineage-2");
    assert.equal(summary.recentTraces[0].lineageJoinKey, "lineage:lineage-2");
    assert.equal(summary.recentTraces[0].lineage?.lane, "quality");
    assert.equal(summary.recentTraces[0].lineage?.specialized, true);
  });
});

