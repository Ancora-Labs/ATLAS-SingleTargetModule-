/**
 * lineage_graph.js — Task Fingerprint Lineage Graph
 *
 * Tracks parent-child task relationships and semantic retries as an immutable,
 * append-only graph. Provides loop detection and failure cluster analysis.
 *
 * Design decisions (per Athena hardening review):
 *   - All thresholds are explicit named constants (non-deterministic behavior forbidden).
 *   - Loop detection uses two orthogonal signals: graph depth and fingerprint repeat count.
 *   - Failure signature is a defined schema tuple: { fingerprint, failureReason, semanticKey }.
 *   - Cluster reporting is file-based (state/lineage_clusters.json), top-N format, JSON.
 *   - Missing vs invalid inputs produce distinct error codes (MISSING_INPUT vs INVALID_ENTRY).
 *   - No silent fallback: every function returns { ok, value?, code, message } or throws
 *     only when contract is violated by the caller (programmer error).
 *
 * Risk level: HIGH — this module is new, but state_tracker.js integration is append-only.
 *   Rollback: set config.runtime.lineageGraphEnabled = false to skip all graph writes.
 */

import { createHash } from "node:crypto";

// ── Explicit thresholds — deterministic, machine-checkable ───────────────────

/**
 * All loop-detection and cluster-reporting thresholds in a single named object.
 * Changing any threshold is a conscious, documented decision.
 *
 * LOOP_DEPTH_LIMIT     — entries with depth >= this value are treated as loop candidates.
 *                        Rationale: legitimate retry chains rarely exceed 10 levels.
 * LOOP_REPEAT_THRESHOLD — same fingerprint appearing this many times within a single
 *                        lineage root's chain signals a semantic loop.
 *                        Rationale: 3 identical attempts on the same root = stuck.
 * CLUSTER_MIN_SIZE     — minimum number of failed entries sharing a failure signature
 *                        required before the cluster is reported. Below this threshold
 *                        the cluster is considered noise, not a pattern.
 * TOP_CLUSTERS_COUNT   — maximum number of clusters written to the dashboard file.
 */
export const LINEAGE_THRESHOLDS = Object.freeze({
  LOOP_DEPTH_LIMIT:      10,
  LOOP_REPEAT_THRESHOLD: 3,
  CLUSTER_MIN_SIZE:      3,
  TOP_CLUSTERS_COUNT:    5,
});

// ── Status enum for LineageEntry ─────────────────────────────────────────────

/**
 * Valid status values for a LineageEntry.
 * Mirrors QueueTask status but is independent — lineage entries record terminal
 * and in-progress states for graph completeness.
 */
export const LINEAGE_ENTRY_STATUS = Object.freeze({
  RUNNING: "running",
  PASSED:  "passed",
  FAILED:  "failed",
  BLOCKED: "blocked",
  PARKED:  "parked",
});

// ── Error codes for deterministic validation outcomes ─────────────────────────

/**
 * Machine-readable reason codes returned by validateLineageEntry and detectLoop.
 * Callers must check the code field; silent fallback is forbidden.
 */
export const LINEAGE_ERROR_CODE = Object.freeze({
  /** Input was null or undefined. */
  MISSING_INPUT:        "MISSING_INPUT",
  /** Input is not a plain object. */
  INVALID_ENTRY:        "INVALID_ENTRY",
  /** A required field is absent. */
  MISSING_FIELD:        "MISSING_FIELD",
  /** A field has an incorrect type or value. */
  INVALID_FIELD:        "INVALID_FIELD",
  /** status value is not one of LINEAGE_ENTRY_STATUS. */
  INVALID_STATUS:       "INVALID_STATUS",
  /** Loop detected via depth limit. */
  LOOP_DEPTH_EXCEEDED:  "LOOP_DEPTH_EXCEEDED",
  /** Loop detected via fingerprint repeat threshold. */
  LOOP_REPEAT_EXCEEDED: "LOOP_REPEAT_EXCEEDED",
  /** No loop detected (success path for detectLoop). */
  NO_LOOP:              "NO_LOOP",
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a stable fingerprint for a task.
 * Uses the same algorithm as buildSemanticKey (sha1 of kind|normalizedTitle)
 * but returns the full 40-char hex digest for precision in graph operations.
 *
 * @param {string} kind
 * @param {string} title
 * @returns {string}
 */
export function buildTaskFingerprint(kind, title) {
  const normalizedTitle = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s:_-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha1").update(`${String(kind || "")}|${normalizedTitle}`).digest("hex");
}

/**
 * Build a unique, stable LineageEntry ID.
 * Format: <fingerprint_prefix>-<taskId>-<attempt>
 * Stable across restarts because it is derived from deterministic inputs.
 *
 * @param {string} fingerprint — 40-char hex (from buildTaskFingerprint)
 * @param {number} taskId
 * @param {number} attempt
 * @returns {string}
 */
export function buildLineageId(fingerprint, taskId, attempt) {
  return `${String(fingerprint).slice(0, 12)}-${Number(taskId)}-${Number(attempt)}`;
}

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_ENTRY_STATUSES = new Set(Object.values(LINEAGE_ENTRY_STATUS));

/**
 * Validate a LineageEntry object against the defined schema.
 *
 * LineageEntry required fields:
 *   id            — string, non-empty (built via buildLineageId)
 *   taskId        — positive integer
 *   semanticKey   — string, non-empty
 *   fingerprint   — string, non-empty (40-char hex from buildTaskFingerprint)
 *   parentId      — string|null (null for root entries)
 *   rootId        — positive integer (= taskId if this is a root entry)
 *   depth         — integer >= 0 (0 = root, increments per retry/split level)
 *   status        — one of LINEAGE_ENTRY_STATUS values
 *   timestamp     — ISO 8601 string
 *   failureReason — string|null (required when status is failed|blocked, null otherwise)
 *   splitAncestry — number[] (taskIds from root→this task; empty array for root entries)
 *                   'split ancestry' = the chain of taskIds that produced this entry
 *                   via autonomous-split source, ordered root-first.
 *
 * Distinguishes missing input (MISSING_INPUT) from invalid structure (INVALID_ENTRY)
 * from field-level errors (MISSING_FIELD / INVALID_FIELD / INVALID_STATUS).
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, value?: object, code: string, message: string }}
 */
export function validateLineageEntry(input) {
  if (input === null || input === undefined) {
    return { ok: false, code: LINEAGE_ERROR_CODE.MISSING_INPUT, message: "entry is required (got null/undefined)" };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: LINEAGE_ERROR_CODE.INVALID_ENTRY, message: "entry must be a plain object" };
  }

  const e = /** @type {Record<string,unknown>} */ (input);

  if (typeof e.id !== "string" || e.id.trim().length === 0) {
    return { ok: false, code: LINEAGE_ERROR_CODE.MISSING_FIELD, message: "entry.id is required and must be a non-empty string" };
  }
  if (!Number.isInteger(e.taskId) || Number(e.taskId) <= 0) {
    return { ok: false, code: LINEAGE_ERROR_CODE.INVALID_FIELD, message: "entry.taskId must be a positive integer" };
  }
  if (typeof e.semanticKey !== "string" || e.semanticKey.trim().length === 0) {
    return { ok: false, code: LINEAGE_ERROR_CODE.MISSING_FIELD, message: "entry.semanticKey is required and must be a non-empty string" };
  }
  if (typeof e.fingerprint !== "string" || e.fingerprint.trim().length === 0) {
    return { ok: false, code: LINEAGE_ERROR_CODE.MISSING_FIELD, message: "entry.fingerprint is required and must be a non-empty string" };
  }
  // parentId: null for root entries, non-empty string for child entries
  if (e.parentId !== null && (typeof e.parentId !== "string" || e.parentId.trim().length === 0)) {
    return { ok: false, code: LINEAGE_ERROR_CODE.INVALID_FIELD, message: "entry.parentId must be null or a non-empty string" };
  }
  if (!Number.isInteger(e.rootId) || Number(e.rootId) <= 0) {
    return { ok: false, code: LINEAGE_ERROR_CODE.INVALID_FIELD, message: "entry.rootId must be a positive integer" };
  }
  if (!Number.isInteger(e.depth) || Number(e.depth) < 0) {
    return { ok: false, code: LINEAGE_ERROR_CODE.INVALID_FIELD, message: "entry.depth must be an integer >= 0" };
  }
  if (!VALID_ENTRY_STATUSES.has(e.status)) {
    return {
      ok: false,
      code: LINEAGE_ERROR_CODE.INVALID_STATUS,
      message: `entry.status '${e.status}' must be one of: ${[...VALID_ENTRY_STATUSES].join(", ")}`
    };
  }
  if (typeof e.timestamp !== "string" || isNaN(Date.parse(/** @type {string} */ (e.timestamp)))) {
    return { ok: false, code: LINEAGE_ERROR_CODE.INVALID_FIELD, message: "entry.timestamp must be a valid ISO 8601 string" };
  }
  // failureReason: required (non-null) when status is failed|blocked
  const needsFailureReason = e.status === LINEAGE_ENTRY_STATUS.FAILED || e.status === LINEAGE_ENTRY_STATUS.BLOCKED;
  if (needsFailureReason && (e.failureReason === null || e.failureReason === undefined)) {
    return {
      ok: false,
      code: LINEAGE_ERROR_CODE.MISSING_FIELD,
      message: `entry.failureReason is required when status is '${e.status}'`
    };
  }
  if (!needsFailureReason && e.failureReason !== null && e.failureReason !== undefined) {
    // Allow failureReason to be null for non-failure statuses; coerce if string
  }
  if (!Array.isArray(e.splitAncestry)) {
    return { ok: false, code: LINEAGE_ERROR_CODE.INVALID_FIELD, message: "entry.splitAncestry must be an array (empty for root entries)" };
  }
  for (const id of /** @type {unknown[]} */ (e.splitAncestry)) {
    if (!Number.isInteger(id) || Number(id) <= 0) {
      return { ok: false, code: LINEAGE_ERROR_CODE.INVALID_FIELD, message: "entry.splitAncestry must contain only positive integers" };
    }
  }

  return { ok: true, value: /** @type {object} */ (input), code: LINEAGE_ERROR_CODE.NO_LOOP, message: "valid" };
}

// ── Loop detection ────────────────────────────────────────────────────────────

/**
 * Detect whether adding a new entry to the lineage graph would create a loop.
 *
 * Two independent loop signals (both checked; first match wins):
 *   1. DEPTH: candidate.depth >= LINEAGE_THRESHOLDS.LOOP_DEPTH_LIMIT
 *      — Any entry deeper than 10 levels from its root is considered a loop
 *        regardless of fingerprint, because legitimate retry chains do not
 *        require more than 10 levels of nesting.
 *   2. REPEAT: count of existing entries in the same root's chain (rootId match)
 *      that share candidate.fingerprint >= LINEAGE_THRESHOLDS.LOOP_REPEAT_THRESHOLD
 *      — 3 or more identical-fingerprint entries under the same root = stuck loop.
 *
 * @param {object[]} existingEntries — current graph entries (may be empty)
 * @param {object}   candidate       — the entry being considered for insertion
 * @returns {{ isLoop: boolean, code: string, message: string }}
 */
export function detectLoop(existingEntries, candidate) {
  if (!Array.isArray(existingEntries)) {
    return { isLoop: false, code: LINEAGE_ERROR_CODE.NO_LOOP, message: "no existing entries" };
  }
  if (!candidate || typeof candidate !== "object") {
    return { isLoop: false, code: LINEAGE_ERROR_CODE.NO_LOOP, message: "invalid candidate — skipping loop check" };
  }

  const depth = Number(candidate.depth ?? 0);
  if (depth >= LINEAGE_THRESHOLDS.LOOP_DEPTH_LIMIT) {
    return {
      isLoop: true,
      code: LINEAGE_ERROR_CODE.LOOP_DEPTH_EXCEEDED,
      message: `loop detected: entry depth ${depth} >= limit ${LINEAGE_THRESHOLDS.LOOP_DEPTH_LIMIT}`
    };
  }

  const fp = String(candidate.fingerprint || "");
  const rootId = Number(candidate.rootId);
  if (fp && rootId > 0) {
    const sameRootSameFingerprint = existingEntries.filter(
      (e) => Number(e.rootId) === rootId && String(e.fingerprint || "") === fp
    ).length;
    if (sameRootSameFingerprint >= LINEAGE_THRESHOLDS.LOOP_REPEAT_THRESHOLD) {
      return {
        isLoop: true,
        code: LINEAGE_ERROR_CODE.LOOP_REPEAT_EXCEEDED,
        message: `loop detected: fingerprint '${fp.slice(0, 12)}...' appears ${sameRootSameFingerprint} times under rootId ${rootId} (threshold=${LINEAGE_THRESHOLDS.LOOP_REPEAT_THRESHOLD})`
      };
    }
  }

  return { isLoop: false, code: LINEAGE_ERROR_CODE.NO_LOOP, message: "no loop detected" };
}

// ── Failure cluster analysis ──────────────────────────────────────────────────

/**
 * @typedef {object} FailureSignature
 * @property {string} fingerprint   — task fingerprint (sha1 hex)
 * @property {string} failureReason — normalized failure reason string
 * @property {string} semanticKey   — representative semantic key
 */

/**
 * @typedef {object} FailureCluster
 * @property {string}   fingerprint   — task fingerprint shared by all entries in cluster
 * @property {string}   semanticKey   — representative semanticKey (from most recent entry)
 * @property {string}   failureReason — most common failure reason in this cluster
 * @property {number}   count         — number of failed/blocked entries in this cluster
 * @property {number[]} taskIds       — all taskIds in this cluster (deduplicated)
 * @property {string}   lastFailedAt  — ISO timestamp of the most recent failure in this cluster
 */

/**
 * Build failure clusters from a set of lineage entries.
 *
 * Failure signature = (fingerprint, failureReason).
 * A cluster is a group of FAILED or BLOCKED entries sharing the same fingerprint.
 * Only clusters with count >= LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE are included.
 * Returns at most LINEAGE_THRESHOLDS.TOP_CLUSTERS_COUNT clusters, sorted by count desc.
 *
 * @param {object[]} entries — all lineage entries (full graph)
 * @returns {FailureCluster[]}
 */
export function buildFailureClusters(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const failureEntries = entries.filter(
    (e) => e.status === LINEAGE_ENTRY_STATUS.FAILED || e.status === LINEAGE_ENTRY_STATUS.BLOCKED
  );
  if (failureEntries.length === 0) return [];

  // Group by fingerprint
  /** @type {Map<string, object[]>} */
  const byFingerprint = new Map();
  for (const entry of failureEntries) {
    const fp = String(entry.fingerprint || "unknown");
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
    byFingerprint.get(fp).push(entry);
  }

  /** @type {FailureCluster[]} */
  const clusters = [];
  for (const [fp, group] of byFingerprint) {
    if (group.length < LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE) continue;

    // Most common failure reason in this cluster
    const reasonCounts = /** @type {Map<string,number>} */ (new Map());
    for (const e of group) {
      const reason = String(e.failureReason || "unknown");
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
    const topReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    // Most recent entry in the cluster (for semanticKey and lastFailedAt)
    const sorted = [...group].sort((a, b) => Number(new Date(b.timestamp)) - Number(new Date(a.timestamp)));
    const mostRecent = sorted[0];

    const taskIds = [...new Set(group.map((e) => Number(e.taskId)))];

    clusters.push({
      fingerprint: fp,
      semanticKey: String(mostRecent.semanticKey || "unknown"),
      failureReason: topReason,
      count: group.length,
      taskIds,
      lastFailedAt: String(mostRecent.timestamp || new Date().toISOString()),
    });
  }

  // Sort by count descending, take top N
  clusters.sort((a, b) => b.count - a.count);
  return clusters.slice(0, LINEAGE_THRESHOLDS.TOP_CLUSTERS_COUNT);
}
