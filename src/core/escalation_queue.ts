/**
 * Escalation Queue — deterministic structured escalation for blocked tasks.
 *
 * When a worker is blocked (policy violation, verification failure, access
 * blocked, or runtime error), a structured escalation payload is persisted
 * here instead of a free-form string summary. The orchestrator reads this
 * queue and prioritises it before every new planning cycle.
 *
 * Schema version: 1
 *
 * Prioritisation rule (deterministic, two-key):
 *   1. Primary  : attempts DESCENDING  — most-blocked task is most urgent
 *   2. Secondary: createdAt ASCENDING  — oldest unresolved within same rank
 *
 * Dedup rule: same taskFingerprint within the cooldown window is rejected
 * with reason DUPLICATE_WITHIN_COOLDOWN, preventing queue flood.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";

// ── Deterministic enums ───────────────────────────────────────────────────────

/**
 * Exhaustive set of blocking reason classes.
 * Two implementers using this enum will produce compatible outputs.
 */
export const BLOCKING_REASON_CLASS = Object.freeze({
  /** Verification gate: max rework attempts exhausted, evidence still missing. */
  MAX_REWORK_EXHAUSTED: "MAX_REWORK_EXHAUSTED",
  /** Policy engine: role tried to touch denied or out-of-scope paths. */
  POLICY_VIOLATION: "POLICY_VIOLATION",
  /** Worker reported BOX_ACCESS=...blocked... at runtime. */
  ACCESS_BLOCKED: "ACCESS_BLOCKED",
  /** Worker process exited non-zero or timed out. */
  WORKER_ERROR: "WORKER_ERROR",
  /** Athena or another gate explicitly rejected the task output. */
  VERIFICATION_GATE: "VERIFICATION_GATE"
});

/**
 * Exhaustive set of recommended next actions for the leadership loop.
 * Consumers must handle every value; unknown values must be treated as RETRY.
 */
export const NEXT_ACTION = Object.freeze({
  /** Escalation is new — retry on the next planning cycle. */
  RETRY: "RETRY",
  /** Multiple failures; human intervention is required. */
  ESCALATE_TO_HUMAN: "ESCALATE_TO_HUMAN",
  /** Task can be safely skipped without impacting the roadmap. */
  SKIP: "SKIP",
  /** Task should be re-assigned to a different worker role. */
  REASSIGN: "REASSIGN"
});

export const ESCALATION_REPLAY_ACTION = Object.freeze({
  MAX_REWORK_EXHAUSTED: "REASSIGN_WITH_VERIFICATION_TEMPLATE_REPLAY",
  ACCESS_BLOCKED: "RETRY_WITH_ACCESS_RECHECK",
  DEFAULT: "RETRY_WITH_OBSERVATION",
});

export const ESCALATION_FORCE_RESOLVE_FINGERPRINTS = Object.freeze([
  "6b493c609b258bc0",
  "905e317f43de1a08",
]);

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default cooldown window in ms (1 hour). Override via config.runtime.escalationCooldownMs. */
export const DEFAULT_ESCALATION_COOLDOWN_MS = 3_600_000;

const _VALID_REASON_CLASSES = new Set(Object.values(BLOCKING_REASON_CLASS));
const _VALID_NEXT_ACTIONS = new Set(Object.values(NEXT_ACTION));

// ── Fingerprinting ────────────────────────────────────────────────────────────

/**
 * Compute a deterministic 16-char fingerprint for a (role, task) pair.
 * Used for cooldown dedup: same role + same task text → same fingerprint.
 *
 * @param {string} role
 * @param {string} task
 * @returns {string} 16-char lowercase hex string
 */
export function computeTaskFingerprint(role, task) {
  const input = `${String(role || "")}:${String(task || "").slice(0, 200)}`;
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

// ── Payload builder ───────────────────────────────────────────────────────────

/**
 * Build and validate a structured escalation payload.
 *
 * Distinguishes MISSING_FIELD (required parameter absent) from INVALID_VALUE
 * (parameter present but not a valid enum member or type) for deterministic
 * downstream handling.
 *
 * @param {{ role: string, task: string, blockingReasonClass: string,
 *           attempts: number, nextAction: string,
 *           summary?: string, prUrl?: string|null }} params
 * @returns {{ ok: true, payload: object } |
 *           { ok: false, reason: 'MISSING_FIELD'|'INVALID_VALUE', field: string, received?: * }}
 */
export function buildEscalationPayload({ role, task, blockingReasonClass, attempts, nextAction, summary = "", prUrl = null }: any = {}) {
  // --- Required-field presence checks (MISSING_FIELD) ---
  if (!role) return { ok: false, reason: "MISSING_FIELD", field: "role" };
  if (!task) return { ok: false, reason: "MISSING_FIELD", field: "task" };
  if (blockingReasonClass === undefined || blockingReasonClass === null || blockingReasonClass === "")
    return { ok: false, reason: "MISSING_FIELD", field: "blockingReasonClass" };
  if (attempts === undefined || attempts === null)
    return { ok: false, reason: "MISSING_FIELD", field: "attempts" };
  if (!nextAction) return { ok: false, reason: "MISSING_FIELD", field: "nextAction" };

  // --- Type / enum validity checks (INVALID_VALUE) ---
  if (!_VALID_REASON_CLASSES.has(blockingReasonClass))
    return { ok: false, reason: "INVALID_VALUE", field: "blockingReasonClass", received: blockingReasonClass };
  if (!_VALID_NEXT_ACTIONS.has(nextAction))
    return { ok: false, reason: "INVALID_VALUE", field: "nextAction", received: nextAction };
  if (typeof attempts !== "number" || !Number.isFinite(attempts) || attempts < 0)
    return { ok: false, reason: "INVALID_VALUE", field: "attempts", received: attempts };

  return {
    ok: true,
    payload: {
      schemaVersion: 1,
      role: String(role),
      taskFingerprint: computeTaskFingerprint(role, task),
      taskSnippet: String(task).slice(0, 120),
      blockingReasonClass,
      attempts: Math.floor(attempts),
      nextAction,
      summary: String(summary || "").slice(0, 500),
      prUrl: prUrl ? String(prUrl) : null,
      resolved: false,
      createdAt: new Date().toISOString()
    }
  };
}

// ── Queue I/O ─────────────────────────────────────────────────────────────────

/**
 * Load the raw escalation queue entries from state/escalation_queue.json.
 * Returns an array (never throws). Callers use sortEscalationQueue() for
 * a prioritised view.
 *
 * @param {object} config
 * @returns {Promise<object[]>}
 */
export async function loadEscalationQueue(config) {
  const filePath = path.join(config?.paths?.stateDir || "state", "escalation_queue.json");
  const state = await readJson(filePath, { entries: [], updatedAt: null });
  return Array.isArray(state?.entries) ? state.entries : [];
}

/**
 * Sort escalation queue entries for leadership loop consumption.
 *
 * Prioritisation rule (deterministic, two-key):
 *   1. Primary  : attempts DESCENDING  — most-stuck task is most urgent
 *   2. Secondary: createdAt ASCENDING  — oldest unresolved within same rank
 *
 * Entries with resolved=true are excluded from the output.
 *
 * @param {object[]} entries
 * @returns {object[]} sorted unresolved entries
 */
export function sortEscalationQueue(entries) {
  const unresolved = (Array.isArray(entries) ? entries : []).filter(e => !e.resolved);
  return [...unresolved].sort((a, b) => {
    const attA = Number(a.attempts ?? 0);
    const attB = Number(b.attempts ?? 0);
    if (attB !== attA) return attB - attA; // higher attempts first
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(); // oldest first
  });
}

/**
 * Append a structured escalation to the persistent queue with cooldown dedup.
 *
 * Dedup rule: if an unresolved entry with the same taskFingerprint was
 * recorded within the cooldown window (config.runtime.escalationCooldownMs,
 * default DEFAULT_ESCALATION_COOLDOWN_MS), the new entry is rejected.
 *
 * Returns:
 *   { appended: true }
 *   { appended: false, reason: 'DUPLICATE_WITHIN_COOLDOWN' }
 *   { appended: false, reason: 'MISSING_FIELD'|'INVALID_VALUE', field, received? }
 *
 * Never silently swallows critical state write failures — throws on I/O error.
 *
 * @param {object} config
 * @param {object} params  — same shape as buildEscalationPayload
 * @returns {Promise<{ appended: boolean, reason?: string, field?: string }>}
 */
export async function appendEscalation(config, params) {
  const built = buildEscalationPayload(params);
  if (!built.ok) return { appended: false, ...built };

  const { payload } = built;
  const cooldownMs = Number(config?.runtime?.escalationCooldownMs ?? DEFAULT_ESCALATION_COOLDOWN_MS);
  const filePath = path.join(config?.paths?.stateDir || "state", "escalation_queue.json");

  const state = await readJson(filePath, { entries: [], updatedAt: null });
  const entries = Array.isArray(state?.entries) ? state.entries : [];

  // Dedup check within cooldown window
  const now = Date.now();
  const isDuplicate = entries.some(e =>
    !e.resolved &&
    e.taskFingerprint === payload.taskFingerprint &&
    (now - new Date(e.createdAt).getTime()) < cooldownMs
  );

  if (isDuplicate) {
    return { appended: false, reason: "DUPLICATE_WITHIN_COOLDOWN" };
  }

  entries.push(payload);

  // Prevent unbounded growth — keep last 500 entries
  const trimmed = entries.length > 500 ? entries.slice(-500) : entries;

  // writeJson throws on I/O error — intentional; callers must not swallow this
  await writeJson(filePath, { entries: trimmed, updatedAt: new Date().toISOString() });
  return { appended: true };
}

/**
 * Resolve unresolved escalations for a concrete role+task fingerprint.
 *
 * Used when a previously blocked worker task later recovers successfully.
 * Matching rule:
 *   - same computed taskFingerprint(role, task)
 *   - unresolved only
 *   - optional blockingReasonClass filter when provided
 *
 * @param {object} config
 * @param {{ role: string, task: string, blockingReasonClass?: string|null,
 *           resolutionSummary?: string, resolvedBy?: string }} params
 * @returns {Promise<{ resolvedCount: number }>}
 */
export async function resolveEscalationsForTask(config, params = {}) {
  const resolvedParams = (params && typeof params === "object") ? params : {};
  const role = String("role" in resolvedParams ? resolvedParams.role : "").trim();
  const task = String("task" in resolvedParams ? resolvedParams.task : "").trim();
  if (!role || !task) return { resolvedCount: 0 };

  const blockingReasonClass = "blockingReasonClass" in resolvedParams && resolvedParams.blockingReasonClass
    ? String(resolvedParams.blockingReasonClass)
    : null;
  const resolutionSummary = String(
    ("resolutionSummary" in resolvedParams ? resolvedParams.resolutionSummary : "") || "Recovered after subsequent worker execution"
  ).slice(0, 500);
  const resolvedBy = String(("resolvedBy" in resolvedParams ? resolvedParams.resolvedBy : "") || "system:auto-resolve").slice(0, 120);
  const fingerprint = computeTaskFingerprint(role, task);
  const filePath = path.join(config?.paths?.stateDir || "state", "escalation_queue.json");

  const state = await readJson(filePath, { entries: [], updatedAt: null });
  const entries = Array.isArray(state?.entries) ? state.entries : [];
  let resolvedCount = 0;
  const resolvedAt = new Date().toISOString();

  const updated = entries.map((entry) => {
    if (entry?.resolved) return entry;
    if (entry?.taskFingerprint !== fingerprint) return entry;
    if (blockingReasonClass && entry?.blockingReasonClass !== blockingReasonClass) return entry;

    resolvedCount += 1;
    return {
      ...entry,
      resolved: true,
      resolvedAt,
      resolutionSummary,
      resolvedBy,
    };
  });

  if (resolvedCount > 0) {
    await writeJson(filePath, { entries: updated, updatedAt: resolvedAt });
  }

  return { resolvedCount };
}

export function deriveEscalationReplayAction(blockingReasonClass: string | null | undefined): string {
  const cls = String(blockingReasonClass || "").trim().toUpperCase();
  if (cls === BLOCKING_REASON_CLASS.MAX_REWORK_EXHAUSTED) return ESCALATION_REPLAY_ACTION.MAX_REWORK_EXHAUSTED;
  if (cls === BLOCKING_REASON_CLASS.ACCESS_BLOCKED) return ESCALATION_REPLAY_ACTION.ACCESS_BLOCKED;
  return ESCALATION_REPLAY_ACTION.DEFAULT;
}

export async function processEscalationQueueClosures(config) {
  const filePath = path.join(config?.paths?.stateDir || "state", "escalation_queue.json");
  const state = await readJson(filePath, { entries: [], updatedAt: null });
  const entries = Array.isArray(state?.entries) ? state.entries : [];
  const now = new Date().toISOString();
  const forceResolveSet = new Set(ESCALATION_FORCE_RESOLVE_FINGERPRINTS);
  let changed = false;
  let resolvedCount = 0;
  let replayUpdatedCount = 0;
  const resolvedFingerprints: string[] = [];

  const updatedEntries = entries.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry.resolved) return entry;

    const replayAction = deriveEscalationReplayAction(entry.blockingReasonClass);
    let nextAction = entry.nextAction;
    if (entry.blockingReasonClass === BLOCKING_REASON_CLASS.MAX_REWORK_EXHAUSTED && entry.nextAction !== NEXT_ACTION.REASSIGN) {
      nextAction = NEXT_ACTION.REASSIGN;
      replayUpdatedCount += 1;
      changed = true;
    } else if (entry.blockingReasonClass === BLOCKING_REASON_CLASS.ACCESS_BLOCKED && entry.nextAction !== NEXT_ACTION.RETRY) {
      nextAction = NEXT_ACTION.RETRY;
      replayUpdatedCount += 1;
      changed = true;
    }

    if (!forceResolveSet.has(String(entry.taskFingerprint || ""))) {
      if (nextAction !== entry.nextAction) {
        return { ...entry, nextAction };
      }
      return entry;
    }

    resolvedCount += 1;
    changed = true;
    resolvedFingerprints.push(String(entry.taskFingerprint || ""));
    return {
      ...entry,
      nextAction,
      resolved: true,
      resolvedAt: now,
      resolvedBy: "system:escalation-closure-workflow",
      resolutionSummary: `Resolved by closure workflow (${replayAction}) for ${String(entry.blockingReasonClass || "UNKNOWN")}`,
    };
  });

  if (changed) {
    await writeJson(filePath, { entries: updatedEntries, updatedAt: now });
  }

  return {
    processedCount: entries.filter(e => !e?.resolved).length,
    replayUpdatedCount,
    resolvedCount,
    resolvedFingerprints,
  };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/**
 * Return summary statistics for the escalation queue.
 * Consumed by the dashboard /api/escalations endpoint.
 *
 * Age unit: milliseconds (integer) since createdAt of the oldest unresolved entry.
 *
 * @param {object} config
 * @returns {Promise<{ unresolvedCount: number,
 *                     oldestUnresolvedAgeMs: number|null,
 *                     oldestUnresolvedCreatedAt: string|null }>}
 */
export async function getEscalationStats(config) {
  const entries = await loadEscalationQueue(config);
  const unresolved = entries.filter(e => !e.resolved);

  if (unresolved.length === 0) {
    return { unresolvedCount: 0, oldestUnresolvedAgeMs: null, oldestUnresolvedCreatedAt: null };
  }

  const oldestByTime = [...unresolved].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )[0];

  return {
    unresolvedCount: unresolved.length,
    oldestUnresolvedAgeMs: Math.floor(Date.now() - new Date(oldestByTime.createdAt).getTime()),
    oldestUnresolvedCreatedAt: oldestByTime.createdAt
  };
}
