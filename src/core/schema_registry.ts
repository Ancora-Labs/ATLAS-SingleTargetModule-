/**
 * schema_registry.js — Contract-versioned state schema registry for BOX.
 *
 * Defines version numbering, schema diffs, and migration handlers for the
 * three critical state files:
 *   - worker_sessions      (state/worker_sessions.json)
 *   - prometheus_analysis  (state/prometheus_analysis.json)
 *   - athena_postmortems   (state/athena_postmortems.json)
 *
 * Version scheme: non-negative integers.
 *   0 = LEGACY  — no schemaVersion field (files written before this registry)
 *   1 = V1      — current schema; schemaVersion: 1 present
 *
 * Schema diffs v0 → v1:
 *
 *   worker_sessions v0:
 *     { [roleName]: { status, startedAt?, ... } }
 *   worker_sessions v1:
 *     { schemaVersion: 1, [roleName]: { status, startedAt?, ... } }
 *     Added: schemaVersion integer field at root level.
 *
 *   prometheus_analysis v0:
 *     { plans, projectHealth, analysis, analyzedAt, model, repo, requestedBy, ... }
 *   prometheus_analysis v1:
 *     { schemaVersion: 1, plans, projectHealth, analysis, analyzedAt, model, repo, requestedBy, ... }
 *     Added: schemaVersion integer field at root level.
 *
 *   athena_postmortems v0:
 *     [ { workerName, taskCompleted, recommendation, ... }, ... ]  (root array)
 *   athena_postmortems v1:
 *     { schemaVersion: 1, entries: [ { workerName, taskCompleted, recommendation, ... }, ... ] }
 *     Added: schemaVersion wrapper object, entries array field.
 *
 * Migration telemetry: appended to state/schema_migration_log.json.
 *   Each record: { timestamp, fileType, filePath, fromVersion, toVersion, success, reason }
 */

import fs from "node:fs/promises";
import path from "node:path";

// ── Version constants ─────────────────────────────────────────────────────────

/**
 * Integer schema version enumeration.
 *   LEGACY (0): No schemaVersion field — written before this registry existed.
 *   V1     (1): Current schema — schemaVersion: 1 present at root.
 *
 * N-1 baseline: V1 is the current version; LEGACY (0) is N-1.
 * Future versions > V1 are unknown and must fail closed.
 */
export const SCHEMA_VERSION = Object.freeze({
  LEGACY: 0,
  V1: 1
});

/** The schema version written by all new writes. */
export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION.V1;

// ── File type identifiers ─────────────────────────────────────────────────────

/**
 * Canonical identifiers for schema-versioned state files.
 * Used as the `fileType` parameter in all registry functions.
 */
export const STATE_FILE_TYPE = Object.freeze({
  WORKER_SESSIONS:     "worker_sessions",
  PROMETHEUS_ANALYSIS: "prometheus_analysis",
  ATHENA_POSTMORTEMS:  "athena_postmortems"
});

// ── Migration result reason codes ─────────────────────────────────────────────

/**
 * Reason codes returned by migrateData.
 * Callers must inspect this field; silent fallback is not allowed.
 *
 * @enum {string}
 */
export const MIGRATION_REASON = Object.freeze({
  /** Migration succeeded — data was at v0 and has been migrated to v1. */
  OK: "OK",
  /** No migration needed — data is already at CURRENT_SCHEMA_VERSION. */
  ALREADY_CURRENT: "ALREADY_CURRENT",
  /** schemaVersion is present but exceeds CURRENT_SCHEMA_VERSION — fail closed. */
  UNKNOWN_FUTURE_VERSION: "UNKNOWN_FUTURE_VERSION",
  /** fileType is not a known STATE_FILE_TYPE value. */
  UNSUPPORTED_TYPE: "UNSUPPORTED_TYPE",
  /** Data structure is incompatible with the declared (or detected) version. */
  INVALID_DATA: "INVALID_DATA"
});

/** File name for migration telemetry log within the state directory. */
export const MIGRATION_LOG_FILE = "schema_migration_log.json";

/** Maximum telemetry log entries retained (oldest entries pruned first). */
const MIGRATION_LOG_MAX_ENTRIES = 500;

// ── Version detection ─────────────────────────────────────────────────────────

/**
 * Detect the schemaVersion of a parsed state value.
 *
 * Rules:
 *   - Array input               → SCHEMA_VERSION.LEGACY (athena_postmortems v0)
 *   - Object without field      → SCHEMA_VERSION.LEGACY
 *   - Object with integer field → that integer value
 *   - Object with non-integer   → null (undetectable / corrupt)
 *   - null / non-object         → null
 *
 * @param {any} data
 * @returns {number|null}
 */
export function detectVersion(data) {
  if (Array.isArray(data)) return SCHEMA_VERSION.LEGACY;
  if (!data || typeof data !== "object") return null;
  if (!("schemaVersion" in data)) return SCHEMA_VERSION.LEGACY;
  const v = data.schemaVersion;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  return null; // non-integer schemaVersion is corrupt / undetectable
}

// ── v0 → v1 schema migrations ─────────────────────────────────────────────────

/**
 * Internal: apply v0 → v1 migration for a specific file type.
 *
 * @param {any} data
 * @param {string} fileType - STATE_FILE_TYPE value
 * @returns {{ ok: boolean, data: any, reason: string }}
 */
function migrateV0ToV1(data, fileType) {
  switch (fileType) {
    case STATE_FILE_TYPE.WORKER_SESSIONS:
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { ok: false, data: null, reason: MIGRATION_REASON.INVALID_DATA };
      }
      // Add schemaVersion at root; all existing role-keyed entries remain.
      return { ok: true, data: { schemaVersion: SCHEMA_VERSION.V1, ...data }, reason: MIGRATION_REASON.OK };

    case STATE_FILE_TYPE.PROMETHEUS_ANALYSIS:
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { ok: false, data: null, reason: MIGRATION_REASON.INVALID_DATA };
      }
      // Add schemaVersion at root; all existing analysis fields remain.
      return { ok: true, data: { schemaVersion: SCHEMA_VERSION.V1, ...data }, reason: MIGRATION_REASON.OK };

    case STATE_FILE_TYPE.ATHENA_POSTMORTEMS:
      if (!Array.isArray(data)) {
        return { ok: false, data: null, reason: MIGRATION_REASON.INVALID_DATA };
      }
      // Wrap array in object envelope with schemaVersion.
      return { ok: true, data: { schemaVersion: SCHEMA_VERSION.V1, entries: data }, reason: MIGRATION_REASON.OK };

    default:
      return { ok: false, data: null, reason: MIGRATION_REASON.UNSUPPORTED_TYPE };
  }
}

// ── Public migration API ──────────────────────────────────────────────────────

/**
 * Migrate parsed state data from its detected version to CURRENT_SCHEMA_VERSION.
 *
 * Fail-closed contract:
 *   - Unknown future versions (schemaVersion > CURRENT) → ok=false, reason=UNKNOWN_FUTURE_VERSION
 *   - Undetectable / corrupt schemaVersion value         → ok=false, reason=INVALID_DATA
 *   - Unsupported fileType                               → ok=false, reason=UNSUPPORTED_TYPE
 *   - Data incompatible with declared version            → ok=false, reason=INVALID_DATA
 *   - Already at current version                         → ok=true,  reason=ALREADY_CURRENT
 *   - Successfully migrated                              → ok=true,  reason=OK
 *
 * @param {any} data - parsed JSON value
 * @param {string} fileType - STATE_FILE_TYPE value
 * @returns {{ ok: boolean, data: any, fromVersion: number|null, toVersion: number, reason: string }}
 */
export function migrateData(data, fileType) {
  const fromVersion = detectVersion(data);

  // Undetectable / corrupt schemaVersion
  if (fromVersion === null) {
    return {
      ok: false, data: null,
      fromVersion: null, toVersion: CURRENT_SCHEMA_VERSION,
      reason: MIGRATION_REASON.INVALID_DATA
    };
  }

  // Future unknown version — fail closed with explicit warning
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false, data: null,
      fromVersion, toVersion: CURRENT_SCHEMA_VERSION,
      reason: MIGRATION_REASON.UNKNOWN_FUTURE_VERSION
    };
  }

  // Already at current version — no migration needed
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return {
      ok: true, data,
      fromVersion, toVersion: CURRENT_SCHEMA_VERSION,
      reason: MIGRATION_REASON.ALREADY_CURRENT
    };
  }

  // v0 → v1
  if (fromVersion === SCHEMA_VERSION.LEGACY) {
    const result = migrateV0ToV1(data, fileType);
    return {
      ok: result.ok, data: result.data,
      fromVersion, toVersion: CURRENT_SCHEMA_VERSION,
      reason: result.reason
    };
  }

  // Intermediate versions not yet defined (would be vN → vN+1 chains)
  return {
    ok: false, data: null,
    fromVersion, toVersion: CURRENT_SCHEMA_VERSION,
    reason: MIGRATION_REASON.UNSUPPORTED_TYPE
  };
}

/**
 * Stamp a data object with the current schema version for writing.
 *
 * For athena_postmortems: wraps an array in { schemaVersion, entries }.
 * For all other file types: adds schemaVersion at root (spread).
 *
 * @param {any} data - the value to write (object or array depending on fileType)
 * @param {string} fileType - STATE_FILE_TYPE value
 * @returns {object} - versioned object ready to pass to writeJson
 */
export function addSchemaVersion(data, fileType) {
  if (fileType === STATE_FILE_TYPE.ATHENA_POSTMORTEMS) {
    const entries = Array.isArray(data)
      ? data
      : (Array.isArray(data?.entries) ? data.entries : []);
    return { schemaVersion: CURRENT_SCHEMA_VERSION, entries };
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return { schemaVersion: CURRENT_SCHEMA_VERSION, ...data };
  }
  return data;
}

/**
 * Extract the postmortem entries array from a raw read value.
 *
 * Handles both v0 (array) and v1 ({ schemaVersion, entries }) transparently.
 * Returns an empty array on unrecognized input.
 *
 * @param {any} raw - value returned by readJson for athena_postmortems.json
 * @returns {Array}
 */
export function extractPostmortemEntries(raw) {
  if (Array.isArray(raw)) return raw;                         // v0 legacy
  if (raw?.entries && Array.isArray(raw.entries)) return raw.entries; // v1
  return [];
}

/**
 * Valid values for the `decisionQualityLabel` field on a postmortem entry.
 * These labels are the only strings accepted on write paths and migration.
 */
export const VALID_DECISION_QUALITY_LABELS = Object.freeze([
  "correct",
  "delayed-correct",
  "incorrect",
  "inconclusive",
] as const);

export type DecisionQualityLabel = typeof VALID_DECISION_QUALITY_LABELS[number];

/**
 * Backfill postmortem entries that are missing a `decisionQualityLabel`.
 *
 * Missing or blank labels are set to `"inconclusive"` — the conservative choice
 * for entries whose outcome cannot be determined from historical data.
 *
 * An optional `reason` string is added as `decisionQualityLabelReason` to
 * distinguish programmatic backfills from labels set at review time.
 *
 * @param entries  — array of postmortem entry objects (mutated in-place for efficiency)
 * @returns { entries, backfilledCount }
 */
export function backfillDecisionQualityLabel(
  entries: Array<Record<string, unknown>>,
): { entries: Array<Record<string, unknown>>; backfilledCount: number } {
  if (!Array.isArray(entries)) return { entries: [], backfilledCount: 0 };
  let backfilledCount = 0;
  for (const entry of entries) {
    if (entry && typeof entry === "object") {
      const label = entry["decisionQualityLabel"];
      if (
        typeof label !== "string" ||
        !(VALID_DECISION_QUALITY_LABELS as readonly string[]).includes(label)
      ) {
        entry["decisionQualityLabel"] = "inconclusive";
        entry["decisionQualityLabelReason"] = "BACKFILLED_MISSING";
        backfilledCount++;
      }
    }
  }
  return { entries, backfilledCount };
}

// ── Migration telemetry ───────────────────────────────────────────────────────

/**
 * Record a schema migration event to state/schema_migration_log.json.
 *
 * Telemetry record schema:
 *   {
 *     timestamp:   string (ISO 8601),
 *     fileType:    string (STATE_FILE_TYPE value),
 *     filePath:    string,
 *     fromVersion: number | null,
 *     toVersion:   number,
 *     success:     boolean,
 *     reason:      string (MIGRATION_REASON value)
 *   }
 *
 * Never throws — telemetry failure is logged to stderr but never propagates.
 *
 * @param {string} stateDir
 * @param {{ fileType, filePath, fromVersion, toVersion, success, reason }} event
 */
export async function recordMigrationTelemetry(stateDir, event) {
  const logPath = path.join(stateDir, MIGRATION_LOG_FILE);
  const record = {
    timestamp:   new Date().toISOString(),
    fileType:    event.fileType,
    filePath:    event.filePath,
    fromVersion: event.fromVersion ?? null,
    toVersion:   event.toVersion,
    success:     Boolean(event.success),
    reason:      event.reason
  };

  try {
    let entries = [];
    try {
      const raw = await fs.readFile(logPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      // Missing or corrupt log — start fresh
    }
    entries.push(record);
    if (entries.length > MIGRATION_LOG_MAX_ENTRIES) {
      entries = entries.slice(entries.length - MIGRATION_LOG_MAX_ENTRIES);
    }
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  } catch (err) {
    console.error(`[schema_registry] telemetry write failed: ${String(err?.message || err)}`);
  }
}
