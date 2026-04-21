import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  writeCheckpoint,
  initializeRunSegmentState,
  applyRunSegmentRollover,
  checkCancellationAtCheckpoint,
  writeBoundaryCheckpoint,
  createVersionedCheckpointEnvelope,
  CHECKPOINT_NS,
} from "../../src/core/checkpoint_engine.js";
import { createCancellationToken, CancelledError } from "../../src/core/daemon_control.js";

const REAL_DATE = Date;

describe("checkpoint_engine", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-checkpoint-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes checkpoint JSON into state directory", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const payload = { cycle: 1, status: "ok" };
    const filePath = await writeCheckpoint(config, payload);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.cycle, payload.cycle);
    assert.equal(parsed.status, payload.status);
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.checkpointFormat, "resumable_v2");
    assert.ok(typeof parsed.integrity?.hash === "string" && parsed.integrity.hash.length > 0);
  });

  it("negative path: writes distinct files on successive calls", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const stamps = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.010Z"
    ].map((value) => REAL_DATE.parse(value));
    let index = 0;

    class FakeDate extends REAL_DATE {
      constructor(value?: string | number | Date) {
        super(value ?? stamps[Math.min(index++, stamps.length - 1)]);
      }

      static now() {
        return stamps[Math.min(index++, stamps.length - 1)];
      }

      static parse(value: string) {
        return REAL_DATE.parse(value);
      }

      static UTC(...args: Parameters<typeof REAL_DATE.UTC>) {
        return REAL_DATE.UTC(...args);
      }
    }

    Object.defineProperty(globalThis, "Date", {
      configurable: true,
      writable: true,
      value: FakeDate,
    });

    try {
      const a = await writeCheckpoint(config, { id: "a" });
      const b = await writeCheckpoint(config, { id: "b" });
      assert.notEqual(a, b);
    } finally {
      Object.defineProperty(globalThis, "Date", {
        configurable: true,
        writable: true,
        value: REAL_DATE,
      });
    }
  });

  it("initializes run-segment state deterministically", () => {
    const checkpoint = initializeRunSegmentState({
      totalPlans: 12,
      createdAt: "2026-04-04T00:00:00.000Z",
    }, {
      spanBatches: 5,
      historyMax: 3,
    });
    assert.equal(checkpoint.runSegment.segmentIndex, 1);
    assert.equal(checkpoint.runSegment.startBatch, 1);
    assert.equal(checkpoint.runSegment.endBatch, 5);
    assert.equal(checkpoint.runSegmentHistoryMax, 3);
    assert.deepEqual(checkpoint.runSegmentHistory, []);
  });

  it("rolls over run-segments and caps history size", () => {
    const base = initializeRunSegmentState({ totalPlans: 13 }, { spanBatches: 5, historyMax: 2 });
    const r1 = applyRunSegmentRollover({ ...base }, { completedBatches: 5, spanBatches: 5, historyMax: 2 });
    assert.equal(r1.rolledOver, true);
    assert.equal((r1.activeSegment as any).segmentIndex, 2);
    assert.equal((r1.checkpoint as any).runSegmentHistory.length, 1);

    const r2 = applyRunSegmentRollover({ ...(r1.checkpoint as any) }, { completedBatches: 10, spanBatches: 5, historyMax: 2 });
    assert.equal(r2.rolledOver, true);
    assert.equal((r2.activeSegment as any).segmentIndex, 3);
    assert.equal((r2.checkpoint as any).runSegmentHistory.length, 2);

    const r3 = applyRunSegmentRollover({ ...(r2.checkpoint as any) }, { completedBatches: 13, spanBatches: 5, historyMax: 2 });
    assert.equal(r3.rolledOver, false, "final batch completion should not create extra rollover");
    assert.equal((r3.checkpoint as any).runSegmentHistory.length, 2, "history must remain bounded");
  });
});

// ── Cancellation-scope semantics ──────────────────────────────────────────────

describe("checkCancellationAtCheckpoint", () => {
  it("is a no-op when token is null", () => {
    assert.doesNotThrow(() => checkCancellationAtCheckpoint(null));
  });

  it("is a no-op when token is undefined", () => {
    assert.doesNotThrow(() => checkCancellationAtCheckpoint(undefined));
  });

  it("is a no-op when token is not cancelled", () => {
    const token = createCancellationToken();
    assert.doesNotThrow(() => checkCancellationAtCheckpoint(token));
  });

  it("throws CancelledError when token is cancelled", () => {
    const token = createCancellationToken();
    token.cancel("test-cancel");
    assert.throws(() => checkCancellationAtCheckpoint(token), CancelledError);
  });

  it("CancelledError reason matches token cancel reason", () => {
    const token = createCancellationToken();
    token.cancel("stop-requested:test");
    try {
      checkCancellationAtCheckpoint(token);
      assert.fail("expected CancelledError to be thrown");
    } catch (err) {
      assert.ok(err instanceof CancelledError);
      assert.equal(err.reason, "stop-requested:test");
    }
  });
});

describe("writeCheckpoint — cancellation-scope", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-checkpoint-cancel-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("throws CancelledError when a cancelled token is passed in opts", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const token = createCancellationToken();
    token.cancel("stop-requested");
    await assert.rejects(
      () => writeCheckpoint(config, { cycle: 1 }, { fileName: "test.json", token }),
      CancelledError,
    );
  });

  it("writes normally when a non-cancelled token is passed in opts", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const token = createCancellationToken();
    const filePath = await writeCheckpoint(config, { cycle: 2 }, { fileName: "ok.json", token });
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.cycle, 2);
  });

  it("writes normally when no token is provided (backward-compatible)", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const filePath = await writeCheckpoint(config, { cycle: 3 }, { fileName: "no-token.json" });
    const raw = await fs.readFile(filePath, "utf8");
    assert.equal(JSON.parse(raw).cycle, 3);
  });

  // ── CHECKPOINT_NS constants ──────────────────────────────────────────────────

  it("CHECKPOINT_NS contains all pipeline namespaces", () => {
    assert.equal(CHECKPOINT_NS.PLANNER, "planner");
    assert.equal(CHECKPOINT_NS.REVIEWER, "reviewer");
    assert.equal(CHECKPOINT_NS.DISPATCH, "dispatch");
    assert.equal(CHECKPOINT_NS.VERIFICATION, "verification");
  });

  // ── createVersionedCheckpointEnvelope with logical identifiers ───────────────

  it("includes thread_id, checkpoint_ns, checkpoint_id when provided", () => {
    const payload = { cycleInfo: "test" };
    const envelope = createVersionedCheckpointEnvelope(
      payload, null, "boundary:planner",
      { thread_id: "cycle-123", checkpoint_ns: "planner", checkpoint_id: "cycle-123/planner/1" }
    );
    assert.equal(envelope.thread_id, "cycle-123");
    assert.equal(envelope.checkpoint_ns, "planner");
    assert.equal(envelope.checkpoint_id, "cycle-123/planner/1");
    assert.equal(envelope.checkpointKind, "boundary:planner");
    assert.ok(typeof envelope.integrity?.hash === "string" && envelope.integrity.hash.length > 0);
  });

  it("omits thread_id/checkpoint_ns/checkpoint_id when not provided (backward-compatible)", () => {
    const payload = { cycle: 5 };
    const envelope = createVersionedCheckpointEnvelope(payload);
    assert.equal(envelope.thread_id, undefined);
    assert.equal(envelope.checkpoint_ns, undefined);
    assert.equal(envelope.checkpoint_id, undefined);
  });

  // ── writeBoundaryCheckpoint ───────────────────────────────────────────────────

  it("writeBoundaryCheckpoint writes a file with logical identifiers", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const filePath = await writeBoundaryCheckpoint(config, { planCount: 3 }, {
      thread_id: "cycle-abc",
      checkpoint_ns: CHECKPOINT_NS.PLANNER,
    });
    assert.ok(typeof filePath === "string" && filePath.length > 0);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.planCount, 3);
    assert.equal(parsed.thread_id, "cycle-abc");
    assert.equal(parsed.checkpoint_ns, "planner");
    assert.ok(typeof parsed.checkpoint_id === "string" && parsed.checkpoint_id.includes("planner"));
    assert.equal(parsed.schemaVersion, 2);
    assert.ok(typeof parsed.integrity?.hash === "string");
  });

  it("writeBoundaryCheckpoint uses checkpoint_ns in the filename", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const filePath = await writeBoundaryCheckpoint(config, {}, {
      thread_id: "t1",
      checkpoint_ns: CHECKPOINT_NS.REVIEWER,
    });
    assert.ok(path.basename(filePath).includes("reviewer"));
  });

  it("writeBoundaryCheckpoint persists normalized prompt-lineage continuity state", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const filePath = await writeBoundaryCheckpoint(config, {
      promptLineage: {
        lineageId: "planner:abc",
        promptFamilyKey: "family-123",
        cacheableSegments: "2.9",
        totalSegments: -4,
        estimatedSavedTokens: 60,
      },
    }, {
      thread_id: "cycle-lineage",
      checkpoint_ns: CHECKPOINT_NS.PLANNER,
    });
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(parsed.promptLineage.lineageId, "planner:abc");
    assert.equal(parsed.promptLineage.promptFamilyKey, "family-123");
    assert.equal(parsed.promptLineage.cacheableSegments, 2);
    assert.equal(parsed.promptLineage.totalSegments, 0);
  });

  it("createVersionedCheckpointEnvelope keeps stable prompt-family lineage joins", () => {
    const envelope = createVersionedCheckpointEnvelope({
      taskKind: "planning",
      roleName: "prometheus",
      lineage: {
        lineageId: "lineage-501",
        taskKind: "planning",
        promptFamilyKey: "planner-batch-5",
      },
    });
    assert.equal(envelope.lineageJoinKey, "prompt-family:planner-batch-5");
  });

  it("negative path: writeBoundaryCheckpoint handles missing thread_id gracefully", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const filePath = await writeBoundaryCheckpoint(config, { data: true }, {
      thread_id: "",
      checkpoint_ns: CHECKPOINT_NS.VERIFICATION,
    });
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(parsed.data, true);
    assert.equal(parsed.thread_id, undefined);
    assert.ok(typeof parsed.checkpoint_id === "string" && parsed.checkpoint_id.includes("verification"));
  });
});

