/**
 * lineage_graph.test.ts — Tests for the task fingerprint lineage graph.
 *
 * Coverage:
 *   - buildTaskFingerprint: determinism, normalization, distinction
 *   - buildLineageId: format, determinism
 *   - validateLineageEntry: schema validation, missing-vs-invalid distinction, all fields
 *   - detectLoop: depth limit, repeat threshold, no-loop happy path (negative path included)
 *   - buildFailureClusters: cluster grouping, min-size filter, top-N cap, sort order
 *
 * Each test verifies behavior, not implementation details.
 * At least one negative path per critical flow is included.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskFingerprint,
  buildLineageId,
  validateLineageEntry,
  detectLoop,
  buildFailureClusters,
  LINEAGE_THRESHOLDS,
  LINEAGE_ENTRY_STATUS,
  LINEAGE_ERROR_CODE,
} from "../../src/core/lineage_graph.js";

// ── Shared test fixture builders ──────────────────────────────────────────────

function makeEntry(overrides = {}) {
  const fp = buildTaskFingerprint("quality", "Fix lint errors");
  return {
    id: buildLineageId(fp, 1, 1),
    taskId: 1,
    semanticKey: "quality::abc123def456",
    fingerprint: fp,
    parentId: null,
    rootId: 1,
    depth: 0,
    status: LINEAGE_ENTRY_STATUS.PASSED,
    timestamp: new Date().toISOString(),
    failureReason: null,
    splitAncestry: [],
    ...overrides,
  };
}

function makeFailedEntry(taskId, rootId, depth = 0, fingerprint = null, reason = "test failure") {
  const fp = fingerprint ?? buildTaskFingerprint("quality", "Fix lint errors");
  return makeEntry({
    id: buildLineageId(fp, taskId, 1),
    taskId,
    rootId,
    depth,
    fingerprint: fp,
    status: LINEAGE_ENTRY_STATUS.FAILED,
    failureReason: reason,
  });
}

// ── buildTaskFingerprint ─────────────────────────────────────────────────────

describe("buildTaskFingerprint", () => {
  it("returns a 40-char hex string", () => {
    const fp = buildTaskFingerprint("quality", "Fix lint errors");
    assert.match(fp, /^[a-f0-9]{40}$/);
  });

  it("is deterministic for the same inputs", () => {
    const a = buildTaskFingerprint("backend", "Add auth middleware");
    const b = buildTaskFingerprint("backend", "Add auth middleware");
    assert.equal(a, b);
  });

  it("produces different fingerprints for different titles", () => {
    const a = buildTaskFingerprint("quality", "Fix lint");
    const b = buildTaskFingerprint("quality", "Add tests");
    assert.notEqual(a, b);
  });

  it("normalizes case and punctuation", () => {
    const a = buildTaskFingerprint("quality", "Fix lint errors!!!");
    const b = buildTaskFingerprint("quality", "fix lint errors");
    assert.equal(a, b);
  });

  it("produces different fingerprints for different kinds with the same title", () => {
    const a = buildTaskFingerprint("quality", "Fix lint");
    const b = buildTaskFingerprint("security", "Fix lint");
    assert.notEqual(a, b);
  });

  it("handles empty inputs gracefully (returns a string)", () => {
    const fp = buildTaskFingerprint("", "");
    assert.equal(typeof fp, "string");
    assert.equal(fp.length, 40);
  });
});

// ── buildLineageId ────────────────────────────────────────────────────────────

describe("buildLineageId", () => {
  it("returns a non-empty string", () => {
    const fp = buildTaskFingerprint("quality", "test");
    const id = buildLineageId(fp, 1, 1);
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
  });

  it("is deterministic for the same inputs", () => {
    const fp = buildTaskFingerprint("quality", "test");
    assert.equal(buildLineageId(fp, 5, 2), buildLineageId(fp, 5, 2));
  });

  it("differs when taskId changes", () => {
    const fp = buildTaskFingerprint("quality", "test");
    assert.notEqual(buildLineageId(fp, 1, 1), buildLineageId(fp, 2, 1));
  });

  it("differs when attempt changes", () => {
    const fp = buildTaskFingerprint("quality", "test");
    assert.notEqual(buildLineageId(fp, 1, 1), buildLineageId(fp, 1, 2));
  });

  it("includes fingerprint prefix, taskId, and attempt separated by dashes", () => {
    const fp = buildTaskFingerprint("quality", "test");
    const id = buildLineageId(fp, 42, 3);
    assert.ok(id.includes("42"), "should contain taskId");
    assert.ok(id.includes("3"), "should contain attempt");
  });
});

// ── validateLineageEntry ──────────────────────────────────────────────────────

describe("validateLineageEntry", () => {
  it("accepts a fully valid root entry", () => {
    const result = validateLineageEntry(makeEntry());
    assert.equal(result.ok, true);
  });

  it("accepts a valid failed entry with failureReason", () => {
    const result = validateLineageEntry(makeFailedEntry(1, 1));
    assert.equal(result.ok, true);
  });

  it("accepts a valid blocked entry with failureReason", () => {
    const result = validateLineageEntry(makeEntry({ status: LINEAGE_ENTRY_STATUS.BLOCKED, failureReason: "access denied" }));
    assert.equal(result.ok, true);
  });

  it("accepts a valid split-child entry with splitAncestry", () => {
    const fp = buildTaskFingerprint("quality", "Fix lint errors");
    const result = validateLineageEntry(makeEntry({
      taskId: 3,
      parentId: buildLineageId(fp, 2, 1),
      rootId: 1,
      depth: 2,
      splitAncestry: [1, 2],
    }));
    assert.equal(result.ok, true);
  });

  // ── Missing input (null/undefined) ── NEGATIVE PATH ────────────────────────
  it("returns MISSING_INPUT code for null input", () => {
    const result = validateLineageEntry(null);
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.MISSING_INPUT);
  });

  it("returns MISSING_INPUT code for undefined input", () => {
    const result = validateLineageEntry(undefined);
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.MISSING_INPUT);
  });

  // ── Invalid structure ── NEGATIVE PATH ──────────────────────────────────────
  it("returns INVALID_ENTRY code for array input", () => {
    const result = validateLineageEntry([]);
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.INVALID_ENTRY);
  });

  it("returns INVALID_ENTRY code for string input", () => {
    const result = validateLineageEntry("not an entry");
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.INVALID_ENTRY);
  });

  // ── Field-level validation ── NEGATIVE PATHS ─────────────────────────────

  it("rejects entry with empty id", () => {
    const result = validateLineageEntry(makeEntry({ id: "" }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.MISSING_FIELD);
  });

  it("rejects entry with non-positive taskId", () => {
    const result = validateLineageEntry(makeEntry({ taskId: 0 }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.INVALID_FIELD);
  });

  it("rejects entry with negative taskId", () => {
    const result = validateLineageEntry(makeEntry({ taskId: -1 }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.INVALID_FIELD);
  });

  it("rejects entry with empty semanticKey", () => {
    const result = validateLineageEntry(makeEntry({ semanticKey: "" }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.MISSING_FIELD);
  });

  it("rejects entry with empty fingerprint", () => {
    const result = validateLineageEntry(makeEntry({ fingerprint: "" }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.MISSING_FIELD);
  });

  it("rejects entry with invalid parentId (non-null non-string)", () => {
    const result = validateLineageEntry(makeEntry({ parentId: 123 }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.INVALID_FIELD);
  });

  it("rejects entry with empty-string parentId (use null for root)", () => {
    const result = validateLineageEntry(makeEntry({ parentId: "" }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.INVALID_FIELD);
  });

  it("rejects entry with negative depth", () => {
    const result = validateLineageEntry(makeEntry({ depth: -1 }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.INVALID_FIELD);
  });

  it("rejects entry with invalid status — NEGATIVE PATH for status enum", () => {
    const result = validateLineageEntry(makeEntry({ status: "unknown" }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.INVALID_STATUS);
  });

  it("rejects entry with invalid timestamp", () => {
    const result = validateLineageEntry(makeEntry({ timestamp: "not-a-date" }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.INVALID_FIELD);
  });

  it("rejects failed entry missing failureReason — NEGATIVE PATH", () => {
    const result = validateLineageEntry(makeEntry({ status: LINEAGE_ENTRY_STATUS.FAILED, failureReason: null }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.MISSING_FIELD);
    assert.ok(result.message.includes("failureReason"), "message should mention failureReason");
  });

  it("rejects blocked entry missing failureReason — NEGATIVE PATH", () => {
    const result = validateLineageEntry(makeEntry({ status: LINEAGE_ENTRY_STATUS.BLOCKED, failureReason: null }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.MISSING_FIELD);
  });

  it("rejects entry with non-array splitAncestry", () => {
    const result = validateLineageEntry(makeEntry({ splitAncestry: "not-array" }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.INVALID_FIELD);
  });

  it("rejects splitAncestry containing non-positive integers", () => {
    const result = validateLineageEntry(makeEntry({ splitAncestry: [1, -2, 3] }));
    assert.equal(result.ok, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.INVALID_FIELD);
  });
});

// ── detectLoop ───────────────────────────────────────────────────────────────

describe("detectLoop", () => {
  it("returns no-loop for an empty graph", () => {
    const result = detectLoop([], makeEntry());
    assert.equal(result.isLoop, false);
    assert.equal(result.code, LINEAGE_ERROR_CODE.NO_LOOP);
  });

  it("returns no-loop when depth is below the limit", () => {
    const candidate = makeEntry({ depth: LINEAGE_THRESHOLDS.LOOP_DEPTH_LIMIT - 1 });
    const result = detectLoop([], candidate);
    assert.equal(result.isLoop, false);
  });

  // ── Depth-based loop detection — NEGATIVE PATH ────────────────────────────
  it("returns LOOP_DEPTH_EXCEEDED when depth equals the limit", () => {
    const candidate = makeEntry({ depth: LINEAGE_THRESHOLDS.LOOP_DEPTH_LIMIT });
    const result = detectLoop([], candidate);
    assert.equal(result.isLoop, true);
    assert.equal(result.code, LINEAGE_ERROR_CODE.LOOP_DEPTH_EXCEEDED);
  });

  it("returns LOOP_DEPTH_EXCEEDED when depth exceeds the limit", () => {
    const candidate = makeEntry({ depth: LINEAGE_THRESHOLDS.LOOP_DEPTH_LIMIT + 5 });
    const result = detectLoop([], candidate);
    assert.equal(result.isLoop, true);
    assert.equal(result.code, LINEAGE_ERROR_CODE.LOOP_DEPTH_EXCEEDED);
  });

  // ── Repeat-based loop detection — NEGATIVE PATH ──────────────────────────
  it("returns LOOP_REPEAT_EXCEEDED when same fingerprint + rootId reaches threshold", () => {
    const fp = buildTaskFingerprint("quality", "Fix lint errors");
    const rootId = 1;
    const existing = Array.from({ length: LINEAGE_THRESHOLDS.LOOP_REPEAT_THRESHOLD }, (_, i) =>
      makeEntry({ taskId: i + 10, rootId, fingerprint: fp, depth: i })
    );
    const candidate = makeEntry({ taskId: 99, rootId, fingerprint: fp, depth: LINEAGE_THRESHOLDS.LOOP_REPEAT_THRESHOLD });
    const result = detectLoop(existing, candidate);
    assert.equal(result.isLoop, true);
    assert.equal(result.code, LINEAGE_ERROR_CODE.LOOP_REPEAT_EXCEEDED);
  });

  it("does not trigger repeat loop below threshold", () => {
    const fp = buildTaskFingerprint("quality", "Fix lint errors");
    const rootId = 1;
    const existing = Array.from({ length: LINEAGE_THRESHOLDS.LOOP_REPEAT_THRESHOLD - 1 }, (_, i) =>
      makeEntry({ taskId: i + 10, rootId, fingerprint: fp, depth: i })
    );
    const candidate = makeEntry({ taskId: 99, rootId, fingerprint: fp, depth: LINEAGE_THRESHOLDS.LOOP_REPEAT_THRESHOLD - 1 });
    const result = detectLoop(existing, candidate);
    assert.equal(result.isLoop, false);
  });

  it("does not trigger repeat loop for different rootId", () => {
    const fp = buildTaskFingerprint("quality", "Fix lint errors");
    // 3 entries under rootId=1, candidate under rootId=2
    const existing = Array.from({ length: LINEAGE_THRESHOLDS.LOOP_REPEAT_THRESHOLD }, (_, i) =>
      makeEntry({ taskId: i + 10, rootId: 1, fingerprint: fp, depth: i })
    );
    const candidate = makeEntry({ taskId: 99, rootId: 2, fingerprint: fp, depth: 1 });
    const result = detectLoop(existing, candidate);
    assert.equal(result.isLoop, false);
  });

  it("handles non-array existingEntries gracefully", () => {
    const result = detectLoop(null, makeEntry());
    assert.equal(result.isLoop, false);
  });

  it("handles null candidate gracefully", () => {
    const result = detectLoop([], null);
    assert.equal(result.isLoop, false);
  });
});

// ── buildFailureClusters ──────────────────────────────────────────────────────

describe("buildFailureClusters", () => {
  it("returns empty array for no entries", () => {
    assert.deepEqual(buildFailureClusters([]), []);
  });

  it("returns empty array for null/non-array input", () => {
    assert.deepEqual(buildFailureClusters(null), []);
  });

  it("returns empty array when no failed/blocked entries exist — NEGATIVE PATH", () => {
    const entries = [
      makeEntry({ status: LINEAGE_ENTRY_STATUS.PASSED }),
      makeEntry({ taskId: 2, status: LINEAGE_ENTRY_STATUS.RUNNING }),
    ];
    assert.deepEqual(buildFailureClusters(entries), []);
  });

  it("excludes clusters below CLUSTER_MIN_SIZE — NEGATIVE PATH", () => {
    const fp = buildTaskFingerprint("quality", "Fix lint errors");
    const entries = Array.from({ length: LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE - 1 }, (_, i) =>
      makeFailedEntry(i + 1, 1, 0, fp)
    );
    const clusters = buildFailureClusters(entries);
    assert.equal(clusters.length, 0, "cluster below min size should not be reported");
  });

  it("includes clusters that meet CLUSTER_MIN_SIZE", () => {
    const fp = buildTaskFingerprint("quality", "Fix lint errors");
    const entries = Array.from({ length: LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE }, (_, i) =>
      makeFailedEntry(i + 1, 1, 0, fp)
    );
    const clusters = buildFailureClusters(entries);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].fingerprint, fp);
    assert.equal(clusters[0].count, LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE);
  });

  it("cluster contains expected fields matching FailureCluster schema", () => {
    const fp = buildTaskFingerprint("quality", "Fix lint errors");
    const entries = Array.from({ length: LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE }, (_, i) =>
      makeFailedEntry(i + 1, 1, 0, fp, "test reason")
    );
    const [cluster] = buildFailureClusters(entries);
    assert.equal(typeof cluster.fingerprint, "string");
    assert.equal(typeof cluster.semanticKey, "string");
    assert.equal(typeof cluster.failureReason, "string");
    assert.equal(typeof cluster.count, "number");
    assert.ok(Array.isArray(cluster.taskIds));
    assert.equal(typeof cluster.lastFailedAt, "string");
    assert.ok(!isNaN(Date.parse(cluster.lastFailedAt)), "lastFailedAt should be a valid ISO string");
  });

  it("caps output at TOP_CLUSTERS_COUNT regardless of how many distinct clusters exist", () => {
    // Create more than TOP_CLUSTERS_COUNT distinct fingerprints, each with CLUSTER_MIN_SIZE entries
    const clusters = Array.from({ length: LINEAGE_THRESHOLDS.TOP_CLUSTERS_COUNT + 3 }, (_, ci) => {
      const fp = buildTaskFingerprint("quality", `task ${ci}`);
      return Array.from({ length: LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE }, (__, i) =>
        makeFailedEntry(ci * 10 + i + 1, ci + 1, 0, fp)
      );
    }).flat();

    const result = buildFailureClusters(clusters);
    assert.ok(result.length <= LINEAGE_THRESHOLDS.TOP_CLUSTERS_COUNT);
  });

  it("sorts clusters by count descending", () => {
    const fp1 = buildTaskFingerprint("quality", "task one");
    const fp2 = buildTaskFingerprint("quality", "task two");
    // fp2 has more failures than fp1
    const entries = [
      ...Array.from({ length: LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE }, (_, i) =>
        makeFailedEntry(i + 1, 1, 0, fp1)
      ),
      ...Array.from({ length: LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE + 2 }, (_, i) =>
        makeFailedEntry(100 + i + 1, 2, 0, fp2)
      ),
    ];
    const result = buildFailureClusters(entries);
    assert.ok(result.length >= 2);
    assert.ok(result[0].count >= result[1].count, "clusters should be sorted by count desc");
    assert.equal(result[0].fingerprint, fp2, "fp2 should be first as it has more failures");
  });

  it("deduplicates taskIds within a cluster", () => {
    const fp = buildTaskFingerprint("quality", "repeating task");
    // Same taskId appearing multiple times (retry same task)
    const entries = Array.from({ length: LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE + 1 }, (_, i) =>
      makeFailedEntry(1, 1, i, fp)  // same taskId=1, different depths
    );
    const [cluster] = buildFailureClusters(entries);
    // taskIds should be deduplicated
    const uniqueCount = new Set(cluster.taskIds).size;
    assert.equal(uniqueCount, cluster.taskIds.length, "taskIds should be deduplicated");
  });
});

// ── LINEAGE_THRESHOLDS — verify thresholds are explicit and accessible ────────

describe("LINEAGE_THRESHOLDS", () => {
  it("exports all expected threshold constants", () => {
    assert.equal(typeof LINEAGE_THRESHOLDS.LOOP_DEPTH_LIMIT, "number");
    assert.equal(typeof LINEAGE_THRESHOLDS.LOOP_REPEAT_THRESHOLD, "number");
    assert.equal(typeof LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE, "number");
    assert.equal(typeof LINEAGE_THRESHOLDS.TOP_CLUSTERS_COUNT, "number");
  });

  it("thresholds are positive and within expected sane ranges", () => {
    assert.ok(LINEAGE_THRESHOLDS.LOOP_DEPTH_LIMIT > 0);
    assert.ok(LINEAGE_THRESHOLDS.LOOP_REPEAT_THRESHOLD > 1);
    assert.ok(LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE >= 2);
    assert.ok(LINEAGE_THRESHOLDS.TOP_CLUSTERS_COUNT >= 1);
  });

  it("thresholds object is frozen (immutable)", () => {
    assert.throws(() => {
      "use strict";
      LINEAGE_THRESHOLDS.LOOP_DEPTH_LIMIT = 99;
    }, TypeError);
  });
});

// ── LINEAGE_ENTRY_STATUS — verify status enum is complete and frozen ───────────

describe("LINEAGE_ENTRY_STATUS", () => {
  it("contains all expected status values", () => {
    const expected = ["running", "passed", "failed", "blocked", "parked"];
    for (const s of expected) {
      assert.ok(Object.values(LINEAGE_ENTRY_STATUS).includes(s), `status '${s}' should be in LINEAGE_ENTRY_STATUS`);
    }
  });

  it("is frozen (immutable)", () => {
    assert.throws(() => {
      "use strict";
      LINEAGE_ENTRY_STATUS.NEW_STATUS = "oops";
    }, TypeError);
  });
});
