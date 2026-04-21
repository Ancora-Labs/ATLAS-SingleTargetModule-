import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  BLOCKING_REASON_CLASS,
  NEXT_ACTION,
  DEFAULT_ESCALATION_COOLDOWN_MS,
  computeTaskFingerprint,
  buildEscalationPayload,
  loadEscalationQueue,
  sortEscalationQueue,
  appendEscalation,
  getEscalationStats,
  deriveEscalationReplayAction,
  processEscalationQueueClosures,
  ESCALATION_REPLAY_ACTION,
  ESCALATION_FORCE_RESOLVE_FINGERPRINTS,
} from "../../src/core/escalation_queue.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(stateDir) {
  return { paths: { stateDir }, runtime: {} };
}

function validParams(overrides = {}) {
  return {
    role: "King David",
    task: "Implement user authentication",
    blockingReasonClass: BLOCKING_REASON_CLASS.VERIFICATION_GATE,
    attempts: 1,
    nextAction: NEXT_ACTION.RETRY,
    ...overrides
  };
}

// ── Schema / enum exports ─────────────────────────────────────────────────────

describe("BLOCKING_REASON_CLASS enum", () => {
  it("is frozen and contains all required values", () => {
    assert.ok(Object.isFrozen(BLOCKING_REASON_CLASS));
    assert.equal(BLOCKING_REASON_CLASS.MAX_REWORK_EXHAUSTED, "MAX_REWORK_EXHAUSTED");
    assert.equal(BLOCKING_REASON_CLASS.POLICY_VIOLATION, "POLICY_VIOLATION");
    assert.equal(BLOCKING_REASON_CLASS.ACCESS_BLOCKED, "ACCESS_BLOCKED");
    assert.equal(BLOCKING_REASON_CLASS.WORKER_ERROR, "WORKER_ERROR");
    assert.equal(BLOCKING_REASON_CLASS.VERIFICATION_GATE, "VERIFICATION_GATE");
  });
});

describe("NEXT_ACTION enum", () => {
  it("is frozen and contains all required values", () => {
    assert.ok(Object.isFrozen(NEXT_ACTION));
    assert.equal(NEXT_ACTION.RETRY, "RETRY");
    assert.equal(NEXT_ACTION.ESCALATE_TO_HUMAN, "ESCALATE_TO_HUMAN");
    assert.equal(NEXT_ACTION.SKIP, "SKIP");
    assert.equal(NEXT_ACTION.REASSIGN, "REASSIGN");
  });
});

// ── computeTaskFingerprint ────────────────────────────────────────────────────

describe("computeTaskFingerprint", () => {
  it("returns a 16-char lowercase hex string", () => {
    const fp = computeTaskFingerprint("King David", "Fix the login bug");
    assert.equal(typeof fp, "string");
    assert.equal(fp.length, 16);
    assert.match(fp, /^[0-9a-f]+$/);
  });

  it("is deterministic: same inputs always produce the same fingerprint", () => {
    const a = computeTaskFingerprint("Esther", "Deploy microservice");
    const b = computeTaskFingerprint("Esther", "Deploy microservice");
    assert.equal(a, b);
  });

  it("differs when role changes", () => {
    const a = computeTaskFingerprint("Aaron", "Fix tests");
    const b = computeTaskFingerprint("Samuel", "Fix tests");
    assert.notEqual(a, b);
  });

  it("differs when task changes", () => {
    const a = computeTaskFingerprint("Noah", "Task A");
    const b = computeTaskFingerprint("Noah", "Task B");
    assert.notEqual(a, b);
  });
});

// ── buildEscalationPayload ────────────────────────────────────────────────────

describe("buildEscalationPayload", () => {
  it("returns a valid payload for correct inputs", () => {
    const result = buildEscalationPayload(validParams());
    assert.ok(result.ok, "should succeed");
    assert.equal(result.payload.schemaVersion, 1);
    assert.equal(result.payload.role, "King David");
    assert.equal(result.payload.blockingReasonClass, BLOCKING_REASON_CLASS.VERIFICATION_GATE);
    assert.equal(result.payload.nextAction, NEXT_ACTION.RETRY);
    assert.equal(result.payload.attempts, 1);
    assert.equal(result.payload.resolved, false);
    assert.ok(result.payload.taskFingerprint);
    assert.ok(result.payload.createdAt);
  });

  // ── MISSING_FIELD paths ──

  it("returns MISSING_FIELD for absent role", () => {
    const result = buildEscalationPayload(validParams({ role: "" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "MISSING_FIELD");
    assert.equal(result.field, "role");
  });

  it("returns MISSING_FIELD for absent task", () => {
    const result = buildEscalationPayload(validParams({ task: "" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "MISSING_FIELD");
    assert.equal(result.field, "task");
  });

  it("returns MISSING_FIELD for absent blockingReasonClass", () => {
    const result = buildEscalationPayload(validParams({ blockingReasonClass: "" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "MISSING_FIELD");
    assert.equal(result.field, "blockingReasonClass");
  });

  it("returns MISSING_FIELD for absent attempts", () => {
    const result = buildEscalationPayload(validParams({ attempts: null }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "MISSING_FIELD");
    assert.equal(result.field, "attempts");
  });

  it("returns MISSING_FIELD for absent nextAction", () => {
    const result = buildEscalationPayload(validParams({ nextAction: "" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "MISSING_FIELD");
    assert.equal(result.field, "nextAction");
  });

  // ── INVALID_VALUE paths (distinguishes from missing) ──

  it("returns INVALID_VALUE for unknown blockingReasonClass", () => {
    const result = buildEscalationPayload(validParams({ blockingReasonClass: "UNKNOWN_CLASS" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "INVALID_VALUE");
    assert.equal(result.field, "blockingReasonClass");
    assert.equal(result.received, "UNKNOWN_CLASS");
  });

  it("returns INVALID_VALUE for unknown nextAction", () => {
    const result = buildEscalationPayload(validParams({ nextAction: "DO_SOMETHING" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "INVALID_VALUE");
    assert.equal(result.field, "nextAction");
    assert.equal(result.received, "DO_SOMETHING");
  });

  it("returns INVALID_VALUE for negative attempts", () => {
    const result = buildEscalationPayload(validParams({ attempts: -1 }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "INVALID_VALUE");
    assert.equal(result.field, "attempts");
  });

  it("returns INVALID_VALUE for non-finite attempts", () => {
    const result = buildEscalationPayload(validParams({ attempts: Infinity }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "INVALID_VALUE");
    assert.equal(result.field, "attempts");
  });

  it("distinguishes MISSING_FIELD from INVALID_VALUE for blockingReasonClass", () => {
    const missing = buildEscalationPayload(validParams({ blockingReasonClass: "" }));
    const invalid = buildEscalationPayload(validParams({ blockingReasonClass: "BAD" }));
    assert.equal(missing.reason, "MISSING_FIELD");
    assert.equal(invalid.reason, "INVALID_VALUE");
    assert.notEqual(missing.reason, invalid.reason);
  });
});

// ── sortEscalationQueue ───────────────────────────────────────────────────────

describe("sortEscalationQueue", () => {
  it("sorts by attempts descending as primary key", () => {
    const entries = [
      { attempts: 1, createdAt: "2025-01-01T00:00:00.000Z", resolved: false },
      { attempts: 3, createdAt: "2025-01-01T01:00:00.000Z", resolved: false },
      { attempts: 2, createdAt: "2025-01-01T02:00:00.000Z", resolved: false }
    ];
    const sorted = sortEscalationQueue(entries);
    assert.equal(sorted[0].attempts, 3);
    assert.equal(sorted[1].attempts, 2);
    assert.equal(sorted[2].attempts, 1);
  });

  it("breaks ties by createdAt ascending (oldest first)", () => {
    const entries = [
      { attempts: 2, createdAt: "2025-01-01T02:00:00.000Z", resolved: false },
      { attempts: 2, createdAt: "2025-01-01T00:00:00.000Z", resolved: false },
      { attempts: 2, createdAt: "2025-01-01T01:00:00.000Z", resolved: false }
    ];
    const sorted = sortEscalationQueue(entries);
    assert.equal(sorted[0].createdAt, "2025-01-01T00:00:00.000Z");
    assert.equal(sorted[1].createdAt, "2025-01-01T01:00:00.000Z");
    assert.equal(sorted[2].createdAt, "2025-01-01T02:00:00.000Z");
  });

  it("excludes resolved entries", () => {
    const entries = [
      { attempts: 5, createdAt: "2025-01-01T00:00:00.000Z", resolved: true },
      { attempts: 1, createdAt: "2025-01-01T01:00:00.000Z", resolved: false }
    ];
    const sorted = sortEscalationQueue(entries);
    assert.equal(sorted.length, 1);
    assert.equal(sorted[0].attempts, 1);
  });

  it("returns empty array when all entries are resolved", () => {
    const entries = [
      { attempts: 3, createdAt: "2025-01-01T00:00:00.000Z", resolved: true }
    ];
    assert.deepEqual(sortEscalationQueue(entries), []);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(sortEscalationQueue([]), []);
  });
});

// ── appendEscalation + dedup ──────────────────────────────────────────────────

describe("appendEscalation (dedup and persistence)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "escalation-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("appends a valid escalation and returns { appended: true }", async () => {
    const config = makeConfig(tmpDir);
    const result = await appendEscalation(config, validParams({ task: "Task dedup-1" }));
    assert.equal(result.appended, true);
  });

  it("rejects duplicate within cooldown window", async () => {
    const config = makeConfig(tmpDir);
    const params = validParams({ task: "Task dedup-2" });
    // First append — should succeed
    const first = await appendEscalation(config, params);
    assert.equal(first.appended, true);
    // Second append same fingerprint within cooldown — must be rejected
    const second = await appendEscalation(config, params);
    assert.equal(second.appended, false);
    assert.equal(second.reason, "DUPLICATE_WITHIN_COOLDOWN");
  });

  it("allows same fingerprint after cooldown window expires", async () => {
    const config = { ...makeConfig(tmpDir), runtime: { escalationCooldownMs: 1 } };
    const params = validParams({ task: "Task cooldown-expired" });
    const first = await appendEscalation(config, params);
    assert.equal(first.appended, true);
    // Wait for cooldown to expire (1ms)
    await new Promise(r => setTimeout(r, 5));
    const second = await appendEscalation(config, params);
    assert.equal(second.appended, true, "should allow after cooldown expires");
  });

  it("rejects with MISSING_FIELD if required field is absent", async () => {
    const config = makeConfig(tmpDir);
    const result = await appendEscalation(config, validParams({ role: "" }));
    assert.equal(result.appended, false);
    assert.equal(result.reason, "MISSING_FIELD");
    assert.equal(result.field, "role");
  });

  it("rejects with INVALID_VALUE if blockingReasonClass is unrecognised", async () => {
    const config = makeConfig(tmpDir);
    const result = await appendEscalation(config, validParams({ blockingReasonClass: "NOT_A_REAL_CLASS" }));
    assert.equal(result.appended, false);
    assert.equal(result.reason, "INVALID_VALUE");
    assert.equal(result.field, "blockingReasonClass");
  });

  it("persists schema version 1 in the file", async () => {
    const config = makeConfig(tmpDir);
    await appendEscalation(config, validParams({ task: "Task schema-version-check" }));
    const entries = await loadEscalationQueue(config);
    const entry = entries.find(e => e.taskSnippet && e.taskSnippet.includes("schema-version-check"));
    assert.ok(entry, "entry should be in queue");
    assert.equal(entry.schemaVersion, 1);
  });

  it("persists all required schema fields", async () => {
    const config = makeConfig(tmpDir);
    await appendEscalation(config, validParams({ task: "Task schema-fields-check" }));
    const entries = await loadEscalationQueue(config);
    const entry = entries.find(e => e.taskSnippet && e.taskSnippet.includes("schema-fields-check"));
    assert.ok(entry);
    assert.ok("schemaVersion" in entry, "schemaVersion missing");
    assert.ok("role" in entry, "role missing");
    assert.ok("taskFingerprint" in entry, "taskFingerprint missing");
    assert.ok("taskSnippet" in entry, "taskSnippet missing");
    assert.ok("blockingReasonClass" in entry, "blockingReasonClass missing");
    assert.ok("attempts" in entry, "attempts missing");
    assert.ok("nextAction" in entry, "nextAction missing");
    assert.ok("summary" in entry, "summary missing");
    assert.ok("resolved" in entry, "resolved missing");
    assert.ok("createdAt" in entry, "createdAt missing");
  });

  // Negative path: invalid input must not corrupt the queue
  it("does not write to file when input is invalid", async () => {
    const config = makeConfig(tmpDir);
    const before = await loadEscalationQueue(config);
    const result = await appendEscalation(config, validParams({ nextAction: "INVALID_ACTION" }));
    const after = await loadEscalationQueue(config);
    assert.equal(result.appended, false);
    assert.equal(before.length, after.length, "queue should not grow on invalid input");
  });
});

// ── getEscalationStats ────────────────────────────────────────────────────────

describe("getEscalationStats", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "escalation-stats-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns zeros when queue is empty", async () => {
    const config = makeConfig(tmpDir);
    const stats = await getEscalationStats(config);
    assert.equal(stats.unresolvedCount, 0);
    assert.equal(stats.oldestUnresolvedAgeMs, null);
    assert.equal(stats.oldestUnresolvedCreatedAt, null);
  });

  it("returns correct count and age after appending an escalation", async () => {
    const config = makeConfig(tmpDir);
    await appendEscalation(config, validParams({ task: "Stats-test task" }));
    const stats = await getEscalationStats(config);
    assert.equal(stats.unresolvedCount, 1);
    assert.ok(Number.isFinite(stats.oldestUnresolvedAgeMs) && stats.oldestUnresolvedAgeMs >= 0,
      "oldestUnresolvedAgeMs should be a non-negative number");
    assert.ok(typeof stats.oldestUnresolvedCreatedAt === "string");
  });

  it("does not count resolved entries", async () => {
    const config = makeConfig(tmpDir);
    // Manually write a queue with one resolved and one unresolved entry
    const queuePath = path.join(tmpDir, "escalation_queue.json");
    await fs.writeFile(queuePath, JSON.stringify({
      entries: [
        { ...buildEscalationPayload(validParams({ task: "Resolved task" })).payload, resolved: true },
        { ...buildEscalationPayload(validParams({ task: "Open task stats" })).payload, resolved: false }
      ]
    }), "utf8");
    const stats = await getEscalationStats(config);
    assert.equal(stats.unresolvedCount, 1);
  });
});

// ── DEFAULT_ESCALATION_COOLDOWN_MS ────────────────────────────────────────────

describe("DEFAULT_ESCALATION_COOLDOWN_MS", () => {
  it("equals 3600000 ms (1 hour)", () => {
    assert.equal(DEFAULT_ESCALATION_COOLDOWN_MS, 3_600_000);
  });
});

describe("processEscalationQueueClosures", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "escalation-closure-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("maps replay actions by blocking reason class", () => {
    assert.equal(
      deriveEscalationReplayAction(BLOCKING_REASON_CLASS.MAX_REWORK_EXHAUSTED),
      ESCALATION_REPLAY_ACTION.MAX_REWORK_EXHAUSTED,
    );
    assert.equal(
      deriveEscalationReplayAction(BLOCKING_REASON_CLASS.ACCESS_BLOCKED),
      ESCALATION_REPLAY_ACTION.ACCESS_BLOCKED,
    );
  });

  it("resolves forced fingerprints and updates class-specific nextAction", async () => {
    const config = makeConfig(tmpDir);
    const filePath = path.join(tmpDir, "escalation_queue.json");
    const [fpMax, fpAccess] = ESCALATION_FORCE_RESOLVE_FINGERPRINTS;
    await fs.writeFile(filePath, JSON.stringify({
      entries: [
        {
          ...buildEscalationPayload(validParams({
            task: "forced max rework",
            blockingReasonClass: BLOCKING_REASON_CLASS.MAX_REWORK_EXHAUSTED,
            nextAction: NEXT_ACTION.RETRY,
          })).payload,
          taskFingerprint: fpMax,
          resolved: false,
        },
        {
          ...buildEscalationPayload(validParams({
            task: "forced access blocked",
            blockingReasonClass: BLOCKING_REASON_CLASS.ACCESS_BLOCKED,
            nextAction: NEXT_ACTION.ESCALATE_TO_HUMAN,
          })).payload,
          taskFingerprint: fpAccess,
          resolved: false,
        },
      ],
      updatedAt: null,
    }), "utf8");

    const result = await processEscalationQueueClosures(config);
    assert.equal(result.resolvedCount, 2);
    assert.equal(result.resolvedFingerprints.length, 2);

    const entries = await loadEscalationQueue(config);
    const resolvedMax = entries.find(e => e.taskFingerprint === fpMax);
    const resolvedAccess = entries.find(e => e.taskFingerprint === fpAccess);
    assert.equal(resolvedMax?.resolved, true);
    assert.equal(resolvedMax?.nextAction, NEXT_ACTION.REASSIGN);
    assert.equal(typeof resolvedMax?.resolvedAt, "string");
    assert.ok(String(resolvedMax?.resolutionSummary || "").includes("MAX_REWORK_EXHAUSTED"));
    assert.equal(resolvedAccess?.resolved, true);
    assert.equal(resolvedAccess?.nextAction, NEXT_ACTION.RETRY);
    assert.equal(typeof resolvedAccess?.resolvedAt, "string");
    assert.ok(String(resolvedAccess?.resolutionSummary || "").includes("ACCESS_BLOCKED"));
  });
});
