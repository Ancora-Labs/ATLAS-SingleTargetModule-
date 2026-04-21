/**
 * Canary Ledger — Persistence layer and audit trail for canary config experiments.
 *
 * ## Canary Ledger schema (state/canary_ledger.json) — AC5 / AC8
 *
 *   {
 *     "schemaVersion": 1,
 *     "experiments": [                          // array of CanaryEntry
 *       {
 *         "canaryId":      "canary-<sha1-12>",  // stable derived ID (AC5)
 *         "experimentId":  "exp-<sha1-12>|null",// links to experiment_registry (AC5)
 *         "configPath":    "runtime.workerTimeoutMinutes", // dot-notation path
 *         "controlValue":  30,                  // value before change — rollback target (AC4)
 *         "canaryValue":   45,                  // proposed new value
 *         "canaryRatio":   0.2,                 // 0–1 observation sampling fraction (AC1)
 *         "status":        "running",           // CANARY_STATUS enum (AC8)
 *         "statusReason":  null,                // machine-readable reason for last transition
 *         "metricSnapshots": [                  // per-cycle metric observations
 *           {
 *             "cycleId":   "cycle-...",
 *             "timestamp": "2026-...",
 *             "metrics":   { "taskSuccessRate": 0.9, "errorRate": 0.05, ... }
 *           }
 *         ],
 *         "createdAt":     "2026-...",
 *         "promotedAt":    null,
 *         "rolledBackAt":  null
 *       }
 *     ],
 *     "updatedAt": "2026-..."
 *   }
 *
 * ## Audit log schema (state/canary_audit.jsonl) — AC1 / AC14
 *
 *   Each line is a self-contained JSON object (newline-delimited JSON / JSONL):
 *   {
 *     "event":        "CANARY_STARTED",      // CANARY_AUDIT_EVENT enum — required
 *     "experimentId": "exp-...",             // links to experiment_registry — required
 *     "canaryId":     "canary-...",          // unique canary entry ID — required
 *     "timestamp":    "2026-...",            // ISO8601 — required
 *     "configPath":   "runtime.timeout",    // config path under change — required
 *     "canaryRatio":  0.2,                   // configured observation ratio — required
 *     "metrics":      { ... } | null,        // snapshot metrics (null for non-snapshot events)
 *     "reason":       "ALL_THRESHOLDS_MET" | null  // machine-readable transition reason
 *   }
 */

import path from "node:path";
import fs   from "node:fs/promises";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "./fs_utils.js";

// ── Status and event enums (AC8) ──────────────────────────────────────────────

/**
 * Machine-readable status values for a canary experiment entry.
 * Used in the `status` field of CanaryEntry.
 */
export const CANARY_STATUS = Object.freeze({
  RUNNING:     "running",
  PROMOTED:    "promoted",
  ROLLED_BACK: "rolled_back",
  FAILED:      "failed"
});

/**
 * Machine-readable event names for the canary audit log.
 * Each event written to canary_audit.jsonl must use one of these values.
 * AC1 / AC14 — output contract: event name is an explicit enum.
 */
export const CANARY_AUDIT_EVENT = Object.freeze({
  CANARY_STARTED:         "CANARY_STARTED",
  CANARY_METRIC_SNAPSHOT: "CANARY_METRIC_SNAPSHOT",
  CANARY_PROMOTED:        "CANARY_PROMOTED",
  CANARY_ROLLED_BACK:     "CANARY_ROLLED_BACK",
  CANARY_FAILED:          "CANARY_FAILED"
});

/** Required fields present on every audit log entry. Used for schema validation. */
export const AUDIT_REQUIRED_FIELDS = Object.freeze([
  "event", "experimentId", "canaryId", "timestamp", "configPath", "canaryRatio"
]);

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * @typedef {"MISSING_FIELD"|"INVALID_VALUE"} ValidationErrorCode
 */

/**
 * Validate a raw CanaryEntry object.
 * Distinguishes MISSING_FIELD from INVALID_VALUE (AC9).
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, errors: Array<{ field: string, code: ValidationErrorCode, message: string }> }}
 */
export function validateCanaryEntry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ field: "root", code: "MISSING_FIELD", message: "canary entry must be a non-null object" }]
    };
  }

  const e = /** @type {Record<string, unknown>} */ (input);
  const errors = [];

  // Required non-empty strings
  for (const field of ["canaryId", "configPath"]) {
    if (!(field in e) || e[field] == null) {
      errors.push({ field, code: "MISSING_FIELD", message: `${field} is required` });
    } else if (typeof e[field] !== "string" || String(e[field]).trim() === "") {
      errors.push({ field, code: "INVALID_VALUE", message: `${field} must be a non-empty string` });
    }
  }

  // canaryRatio: 0 < ratio <= 1
  if (!("canaryRatio" in e) || e.canaryRatio == null) {
    errors.push({ field: "canaryRatio", code: "MISSING_FIELD", message: "canaryRatio is required" });
  } else if (
    typeof e.canaryRatio !== "number" ||
    !Number.isFinite(e.canaryRatio) ||
    e.canaryRatio <= 0 ||
    e.canaryRatio > 1
  ) {
    errors.push({ field: "canaryRatio", code: "INVALID_VALUE", message: "canaryRatio must be a number in (0, 1]" });
  }

  // status
  if (!("status" in e) || e.status == null) {
    errors.push({ field: "status", code: "MISSING_FIELD", message: "status is required" });
  } else if (!Object.values(CANARY_STATUS).includes(/** @type {any} */ (e.status))) {
    errors.push({
      field: "status",
      code:  "INVALID_VALUE",
      message: `status must be one of: ${Object.values(CANARY_STATUS).join(", ")}`
    });
  }

  // metricSnapshots: must be array if present
  if ("metricSnapshots" in e && !Array.isArray(e.metricSnapshots)) {
    errors.push({ field: "metricSnapshots", code: "INVALID_VALUE", message: "metricSnapshots must be an array" });
  }

  // createdAt: required ISO timestamp
  if (!("createdAt" in e) || e.createdAt == null) {
    errors.push({ field: "createdAt", code: "MISSING_FIELD", message: "createdAt is required" });
  } else if (typeof e.createdAt !== "string" || !Number.isFinite(Date.parse(/** @type {string} */ (e.createdAt)))) {
    errors.push({ field: "createdAt", code: "INVALID_VALUE", message: "createdAt must be a valid ISO timestamp" });
  }

  return { ok: errors.length === 0, errors };
}

// ── Canary ID generation (AC5) ────────────────────────────────────────────────

/**
 * Build a stable canary ID from its defining axes.
 * Format: "canary-<sha1-12>" — deterministic for (configPath, canaryValue, createdAt).
 * Storage location: state/canary_ledger.json#experiments[].canaryId (AC5).
 *
 * @param {string} configPath
 * @param {unknown} canaryValue
 * @param {string} createdAt  ISO timestamp
 * @returns {string}
 */
export function buildCanaryId(configPath, canaryValue, createdAt) {
  const key  = `${configPath}|${JSON.stringify(canaryValue)}|${createdAt}`;
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return `canary-${hash}`;
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Load the canary ledger from disk.
 * Returns a fresh default object (schemaVersion=1, experiments=[]) on ENOENT.
 * Never shares a mutable reference between callers (always a new object).
 *
 * @param {string} stateDir
 * @returns {Promise<{ schemaVersion: number, experiments: Array<object>, updatedAt?: string }>}
 */
export async function loadLedger(stateDir) {
  return readJson(path.join(stateDir, "canary_ledger.json"), {
    schemaVersion: 1,
    experiments:   []
  });
}

/**
 * Save the canary ledger to disk (atomic write via writeJson).
 *
 * @param {string} stateDir
 * @param {{ schemaVersion: number, experiments: Array<object>, updatedAt?: string }} ledger
 */
export async function saveLedger(stateDir, ledger) {
  ledger.updatedAt = new Date().toISOString();
  await writeJson(path.join(stateDir, "canary_ledger.json"), ledger);
}

// ── Audit log (AC1 / AC14) ────────────────────────────────────────────────────

/**
 * Append a structured audit event to the canary audit log (state/canary_audit.jsonl).
 *
 * Audit log output contract (AC1 / AC14):
 *   - Log path    : state/canary_audit.jsonl  (JSONL — one JSON object per line)
 *   - Event name  : event field, must be a CANARY_AUDIT_EVENT value
 *   - Required fields: event, experimentId, canaryId, timestamp, configPath, canaryRatio
 *   - Optional fields: metrics (object | null), reason (string | null)
 *
 * Missing required fields cause the entry to be written with an explicit
 * `auditError: "MISSING_REQUIRED_FIELD:<fieldName>"` instead of silently omitting data. (AC10)
 *
 * @param {string}  stateDir
 * @param {object}  entry   Object conforming to AUDIT_REQUIRED_FIELDS + optional fields
 * @returns {Promise<void>}
 */
export async function appendAuditLog(stateDir, entry) {
  // Validate required fields — do NOT silently skip them
  const missingFields = AUDIT_REQUIRED_FIELDS.filter(
    f => !(f in entry) || entry[f] == null
  );

  const record = {
    event:        entry.event        ?? null,
    experimentId: entry.experimentId ?? null,
    canaryId:     entry.canaryId     ?? null,
    timestamp:    entry.timestamp    ?? new Date().toISOString(),
    configPath:   entry.configPath   ?? null,
    canaryRatio:  entry.canaryRatio  ?? null,
    metrics:      entry.metrics      ?? null,
    reason:       entry.reason       ?? null,
    // AC10: non-silent degradation — flag missing required fields explicitly
    ...(missingFields.length > 0
      ? { auditError: `MISSING_REQUIRED_FIELDS:${missingFields.join(",")}` }
      : {})
  };

  const logPath = path.join(stateDir, "canary_audit.jsonl");
  try {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.appendFile(logPath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Audit log write failure must not crash the main path; caller has no recovery action.
    // The failure is implicitly observable via the missing entry in the audit file.
  }
}
